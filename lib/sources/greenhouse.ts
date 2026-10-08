// Greenhouse public job-board API adapter.
// Docs: https://developers.greenhouse.io/job-board.html
// This is a public, intended-for-consumption API — no scraping, no auth.

import { cleanField, htmlToText } from "../html";
import { makeJobId, scopeKey } from "../store";
import type { Job, SourceResult } from "../types";

interface GhJob {
  id: number;
  title: string;
  absolute_url: string;
  updated_at: string;
  /** When the post first went live. Prefer this over updated_at — see below. */
  first_published?: string;
  location?: { name?: string };
  content?: string; // HTML, present when ?content=true
  departments?: Array<{ name?: string }>;
}

const API = "https://boards-api.greenhouse.io/v1/boards";

async function boardName(token: string): Promise<string> {
  try {
    const res = await fetch(`${API}/${token}`);
    if (!res.ok) return token;
    const data = (await res.json()) as { name?: string };
    return data.name ?? token;
  } catch {
    return token;
  }
}

/** Fetch all open jobs for one company board. */
async function fetchBoard(token: string): Promise<{ jobs: Job[]; scope: string }> {
  const [name, res] = await Promise.all([
    boardName(token),
    fetch(`${API}/${token}/jobs?content=true`),
  ]);
  if (!res.ok) {
    throw new Error(`greenhouse ${token}: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { jobs?: GhJob[] };
  const now = new Date().toISOString();
  const company = cleanField(name);
  const jobs = (data.jobs ?? []).map((j) => {
    const location = cleanField(j.location?.name ?? "") || "Unspecified";
    const title = cleanField(j.title);
    return {
      id: makeJobId(title, company, location),
      source: "greenhouse" as const,
      sourceJobId: String(j.id),
      title,
      company,
      location,
      remote: /remote|anywhere/i.test(location) || null,
      description: j.content ? htmlToText(j.content) : "",
      url: j.absolute_url,
      // updated_at refreshes whenever anyone edits the post, which made every
      // stale listing look freshly posted. first_published is the real date.
      postedAt: j.first_published ?? j.updated_at ?? null,
      fetchedAt: now,
      compensation: null,
      employmentType: null,
      department: j.departments?.[0]?.name ? cleanField(j.departments[0].name!) : null,
    };
  });
  return { jobs, scope: scopeKey("greenhouse", company) };
}

/**
 * Fetch jobs across many company boards. Individual board failures are logged
 * and skipped so one bad token doesn't sink the whole run — and, critically, a
 * failed board contributes NO scope, so its existing jobs are never mistaken
 * for delisted.
 */
export async function fetchGreenhouse(companies: string[]): Promise<SourceResult> {
  const results = await Promise.allSettled(companies.map(fetchBoard));
  const jobs: Job[] = [];
  const scopes: string[] = [];
  for (const [i, r] of results.entries()) {
    if (r.status === "fulfilled") {
      jobs.push(...r.value.jobs);
      scopes.push(r.value.scope);
    } else {
      console.warn(`  ! greenhouse/${companies[i]}: ${r.reason}`);
    }
  }
  return { jobs, scopes };
}
