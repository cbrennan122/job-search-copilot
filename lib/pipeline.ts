// Orchestrates a fetch run: pull from every enabled source, dedupe into the
// store, close anything that has disappeared from a source we can trust, then
// score whatever is still unscored. Safe to run repeatedly (idempotent).

import { scoreUnscored, type ScoreResult } from "./fit";
import { loadProfile, type Profile } from "./profile";
import { fetchAdzuna } from "./sources/adzuna";
import { fetchAshby } from "./sources/ashby";
import { fetchGreenhouse } from "./sources/greenhouse";
import { fetchJSearch } from "./sources/jsearch";
import { fetchLever } from "./sources/lever";
import { fetchRemoteOk } from "./sources/remoteok";
import { fetchUsaJobs } from "./sources/usajobs";
import { markDelisted, pruneClosed, upsertJobs } from "./store";
import type { Job, SourceResult } from "./types";

export interface PipelineResult {
  fetched: number;
  inserted: number;
  updated: number;
  closed: number;
  pruned: number;
  scored: number;
  /** How the LLM half of scoring went — see ScoreResult. */
  scoring: ScoreResult;
  /** Per source: how many jobs it returned, or -1 if the whole source failed. */
  perSource: Record<string, number>;
}

export interface FetchAllResult {
  jobs: Job[];
  /** Scope keys whose enumeration succeeded — the only jobs eligible for closing. */
  scopes: string[];
  perSource: Record<string, number>;
}

/** Fetch from every source the profile enables, concurrently. */
export async function fetchAllSources(profile: Profile): Promise<FetchAllResult> {
  const tasks: Array<{ name: string; run: () => Promise<SourceResult> }> = [];

  if (profile.greenhouse.companies.length)
    tasks.push({ name: "greenhouse", run: () => fetchGreenhouse(profile.greenhouse.companies) });
  if (profile.lever.companies.length)
    tasks.push({ name: "lever", run: () => fetchLever(profile.lever.companies) });
  if (profile.ashby.companies.length)
    tasks.push({ name: "ashby", run: () => fetchAshby(profile.ashby.companies) });
  if (profile.remoteok.enabled) tasks.push({ name: "remoteok", run: () => fetchRemoteOk(profile) });
  if (profile.jsearch.queries.length && process.env.OPENWEBNINJA_API_KEY)
    tasks.push({
      name: "jsearch",
      run: () => fetchJSearch(profile.jsearch.queries, profile.jsearch.pages),
    });
  if (profile.usajobs.queries.length && process.env.USAJOBS_API_KEY && process.env.USAJOBS_EMAIL)
    tasks.push({
      name: "usajobs",
      run: () => fetchUsaJobs(profile.usajobs.queries, profile.usajobs.results_per_page),
    });
  if (profile.adzuna.queries.length && process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY)
    tasks.push({
      name: "adzuna",
      run: () =>
        fetchAdzuna(
          profile.adzuna.country,
          profile.adzuna.queries,
          profile.adzuna.pages,
          profile.adzuna.results_per_page,
        ),
    });

  const settled = await Promise.allSettled(tasks.map((t) => t.run()));
  const jobs: Job[] = [];
  const scopes: string[] = [];
  const perSource: Record<string, number> = {};

  settled.forEach((r, i) => {
    if (r.status === "fulfilled") {
      perSource[tasks[i].name] = r.value.jobs.length;
      jobs.push(...r.value.jobs);
      // Only a source that *succeeded* contributes scopes. An adapter that threw
      // returns nothing here, so its companies stay untouched rather than having
      // every one of their jobs closed on the strength of a failed request.
      scopes.push(...r.value.scopes);
    } else {
      perSource[tasks[i].name] = -1;
      console.warn(`  ! source ${tasks[i].name} failed: ${r.reason}`);
    }
  });

  return { jobs, scopes, perSource };
}

export async function runPipeline(opts?: {
  score?: boolean;
  /** Delete jobs closed longer ago than this. 0 disables pruning. */
  pruneAfterDays?: number;
  /** Progress callback for the LLM scoring pass, which is the slow part. */
  onScoreProgress?: (done: number, total: number) => void;
}): Promise<PipelineResult> {
  const profile = loadProfile();

  const { jobs, scopes, perSource } = await fetchAllSources(profile);
  const { inserted, updated } = upsertJobs(jobs);

  // Close jobs that belong to a fully-enumerated scope but were not in this run.
  const closed = markDelisted(
    scopes,
    jobs.map((j) => j.id),
  );

  const pruneAfterDays = opts?.pruneAfterDays ?? 0;
  const pruned = pruneAfterDays > 0 ? pruneClosed(pruneAfterDays) : 0;

  let scoring: ScoreResult = { scored: 0, llmAttempted: 0, llmFailed: 0 };
  if (opts?.score !== false) {
    scoring = await scoreUnscored(profile, { onProgress: opts?.onScoreProgress });
  }

  return {
    fetched: jobs.length,
    inserted,
    updated,
    closed,
    pruned,
    scored: scoring.scored,
    scoring,
    perSource,
  };
}
