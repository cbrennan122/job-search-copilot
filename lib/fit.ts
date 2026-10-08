// Two-tier fit scoring:
//   1) a free keyword/title prefilter (runs on everything)
//   2) an LLM score (Sonnet) only on jobs that clear the prefilter threshold
// Jobs below threshold get a stored prefilter score so they aren't re-scored
// every run and still appear (filterable) in the queue.

import { anthropic, MODELS, textOf } from "./anthropic";
import { locationBucket } from "./locations";
import { mapPool } from "./pool";
import type { Profile } from "./profile";
import { loadResumeBase } from "./profile";
import { FALLBACK_MODEL, saveFitScore, unscoredJobs } from "./store";
import type { Job } from "./types";

const includesAny = (haystack: string, needles: string[]) =>
  needles.some((n) => n && haystack.includes(n.toLowerCase()));

/** Cheap heuristic 0-100. No network. */
export function prefilterScore(job: Job, profile: Profile): number {
  const title = job.title.toLowerCase();
  const text = `${title}\n${job.description.toLowerCase()}`;
  const loc = job.location.toLowerCase();
  const m = profile.match;

  let score = 0;
  if (includesAny(title, m.titles)) score += 45;
  else if (includesAny(text, m.titles)) score += 20;

  const kwHits = m.keywords.filter((k) => text.includes(k.toLowerCase())).length;
  score += Math.min(35, kwHits * 7);

  const remote = job.remote === true || /remote|anywhere/.test(loc);
  if (m.remote_only && !remote) return 0;
  // Asks the country classifier rather than substring-matching a list of
  // location words, so the prefilter and the queue's ranking agree on what
  // counts as reachable. `unknown` gets no bonus and no penalty.
  if (locationBucket(job.location, job.source) === "allowed" || remote) score += 10;

  if (includesAny(title, m.deprioritize)) score -= 40;
  else if (includesAny(text, m.deprioritize)) score -= 15;

  return Math.max(0, Math.min(100, score));
}

const SCORE_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "integer" },
    reason: { type: "string" },
  },
  required: ["score", "reason"],
  additionalProperties: false,
} as const;

/** LLM fit score for one job. Returns 0-100 and a one-line reason. */
async function llmScore(
  job: Job,
  profile: Profile,
  resume: string,
): Promise<{ score: number; reason: string }> {
  // The bands are stated as a scale on purpose. Naming them as three buckets is
  // what produced the old clustering — 90 jobs on exactly 28, spanning roles as
  // unrelated as Data Analyst and TPM — which left `ORDER BY` nothing to sort on
  // and made the category weights in lib/categories.ts wider than the score's own
  // resolution.
  const system =
    "You score how well a candidate fits a job, 0-100, based only on their real " +
    "resume and stated targeting. Be honest and calibrated: 80+ is a strong match, " +
    "50-79 plausible, below 50 a stretch. Penalize roles the candidate is targeting " +
    "away from. Never assume skills not in the resume.\n\n" +
    "Those bands are a scale, not buckets — discriminate INSIDE a band. Two postings " +
    "that are both a stretch should rarely land on the same number: judge how much of " +
    "each job the candidate could do on day one and let that set the exact score. Do " +
    "not fall back on the same handful of values across different postings.\n\n" +
    "Reply with the score and one concise sentence naming the specific thing that put " +
    "it at that number rather than five points higher or lower.";

  const user = [
    "## Candidate resume",
    resume.slice(0, 4000),
    "",
    "## Candidate targeting",
    `Wants titles like: ${profile.match.titles.join(", ")}`,
    `Values skills: ${profile.match.keywords.join(", ")}`,
    `Avoiding: ${profile.match.deprioritize.join(", ")}`,
    "",
    "## Job",
    `Title: ${job.title}`,
    `Company: ${job.company}`,
    `Location: ${job.location}`,
    "Description:",
    job.description.slice(0, 6000),
  ].join("\n");

  // max_tokens is 2048, not 256, because Sonnet 5 runs adaptive thinking when
  // `thinking` is omitted (Haiku 4.5 did not) and thinking tokens count against
  // the cap — at 256 the JSON gets truncated before it is written. `effort: "low"`
  // is the cost knob to reach for before ever changing model tier again.
  const msg = await anthropic().messages.create({
    model: MODELS.scoring,
    max_tokens: 2048,
    system,
    messages: [{ role: "user", content: user }],
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: SCORE_SCHEMA },
    },
  });

  const parsed = JSON.parse(textOf(msg)) as { score: number; reason: string };
  return {
    score: Math.max(0, Math.min(100, Math.round(parsed.score))),
    reason: parsed.reason,
  };
}

/**
 * How many LLM scoring calls run at once. Six was tuned against Haiku's rate
 * limits; Sonnet's are a different tier, so treat this as unverified on the
 * current model — the SDK retries the odd 429 on its own, and a run that starts
 * throwing them is the signal to lower it.
 */
const SCORING_CONCURRENCY = 6;

/**
 * What a scoring pass would do, split by what it costs. Selection lives here and
 * ONLY here: `scoreUnscored` runs it for real, and `scripts/rescore.ts` runs it
 * over the open queue to price the job before spending. When those were two
 * implementations the quote was wrong — rescore priced 564 LLM calls for a run
 * that made 374, because it applied the prefilter but not the country filter.
 * A preview that can disagree with the run it previews is worse than none.
 */
export interface ScorePlan {
  /** Never reach the LLM: a country `match.countries` does not name. */
  foreign: Job[];
  /** Settled free, with a stored prefilter verdict. */
  prefilterOnly: Array<{ job: Job; pre: number }>;
  /** The only jobs that cost an LLM call. */
  needsLlm: Array<{ job: Job; pre: number }>;
}

/** Bucket `jobs` by what scoring them would cost. Pure: no DB writes, no network. */
export function planScoring(jobs: Job[], profile: Profile): ScorePlan {
  const threshold = profile.match.prefilter_threshold;
  const plan: ScorePlan = { foreign: [], prefilterOnly: [], needsLlm: [] };

  for (const job of jobs) {
    // Country is checked FIRST, so no LLM call is ever spent on a country the
    // profile rules out. Those jobs are left UNSCORED rather than written a fake
    // 0: the queue still shows them under the "All" location filter, and
    // widening `countries` picks them up for real, because unscoredJobs()
    // re-queues never-scored rows. Note the asymmetry — rows already scored
    // under the old targeting keep their scores; only newly-fetched foreign jobs
    // stay blank. Making that uniform would cost a call per row for jobs being
    // hidden anyway.
    if (locationBucket(job.location, job.source) === "foreign") {
      plan.foreign.push(job);
      continue;
    }
    const pre = prefilterScore(job, profile);
    if (pre < threshold) plan.prefilterOnly.push({ job, pre });
    else plan.needsLlm.push({ job, pre });
  }

  return plan;
}

/** Outcome of a scoring pass. `llmFailed` is what tells a caller the run was hollow. */
export interface ScoreResult {
  /** Rows written, however they were arrived at. */
  scored: number;
  /** Jobs that cleared the prefilter and were sent to the LLM. */
  llmAttempted: number;
  /** Of those, how many fell back because the call threw. */
  llmFailed: number;
}

/**
 * Score every unscored job.
 * Prefilter losers are recorded with model "prefilter" (no LLM spend) and are
 * settled up front, so the concurrency pool only ever holds real network work.
 */
export async function scoreUnscored(
  profile: Profile,
  opts: { onProgress?: (done: number, total: number) => void } = {},
): Promise<ScoreResult> {
  // Split before any I/O: the prefilter is pure CPU, so mixing it into the async
  // pool would have workers "busy" doing no network work.
  const plan = planScoring(unscoredJobs(), profile);
  if (plan.prefilterOnly.length === 0 && plan.needsLlm.length === 0) {
    return { scored: 0, llmAttempted: 0, llmFailed: 0 };
  }

  const resume = loadResumeBase();
  let count = 0;
  let llmFailed = 0;

  for (const { job, pre } of plan.prefilterOnly) {
    saveFitScore({
      jobId: job.id,
      score: pre,
      reason: "Below keyword prefilter threshold — not LLM-scored.",
      model: "prefilter",
      scoredAt: new Date().toISOString(),
    });
    count++;
  }

  await mapPool(
    plan.needsLlm,
    SCORING_CONCURRENCY,
    async ({ job, pre }) => {
      const now = new Date().toISOString();
      try {
        const { score, reason } = await llmScore(job, profile, resume);
        saveFitScore({
          jobId: job.id,
          score,
          reason,
          model: MODELS.scoring,
          scoredAt: now,
        });
      } catch (err) {
        // Fall back to the prefilter score so the job still surfaces, and never
        // rethrow — one bad job must not abandon the rest of the run. Counted,
        // because "every call failed" is a broken run, not a scored one.
        llmFailed++;
        saveFitScore({
          jobId: job.id,
          score: pre,
          reason: `LLM scoring failed (${(err as Error).message}); prefilter score shown.`,
          model: FALLBACK_MODEL,
          scoredAt: now,
        });
      }
      count++;
    },
    { onProgress: opts.onProgress },
  );

  return { scored: count, llmAttempted: plan.needsLlm.length, llmFailed };
}
