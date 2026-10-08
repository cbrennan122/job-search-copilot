// Re-score the open queue against the CURRENT targeting config.
//
//   npx tsx scripts/rescore.ts              # dry run: what would change, and what it costs
//   npx tsx scripts/rescore.ts --yes        # clear the stored scores
//   npx tsx scripts/rescore.ts --yes --score  # clear, then score straight away
//
// Why this exists: a real LLM score is final by design. `unscoredJobs` re-queues
// only never-scored jobs and failed-call FALLBACK_MODEL rows, so `npm run fetch`
// will never revisit a job it has already judged. That is correct while the
// config is stable, and wrong the moment targeting changes — every stored score
// was computed against the titles, keywords and deprioritize list in force when
// it ran, and no other code path expires it.
//
// Deleting is the whole mechanism, so it defaults to a dry run and needs --yes.
// Closed listings are skipped: you cannot apply to a delisted job, so re-scoring
// one is pure spend.

import { activeCategories, categoryOf } from "../lib/categories";
import { loadLocalEnv, requireEnv } from "../lib/env";
import { planScoring, scoreUnscored } from "../lib/fit";
import { loadProfile } from "../lib/profile";
import { clearFitScores, countJobs, listJobs, db } from "../lib/store";
import type { Job } from "../lib/types";

// JOB_COPILOT_DB can be set in .env.local, and bare tsx does not read it.
// Clearing scores in a different database from the one the dashboard reads
// would look like a no-op and be anything but.
loadLocalEnv();

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const includeClosed = has("--include-closed");
const confirmed = has("--yes");
const alsoScore = has("--score");

async function main() {
  const profile = loadProfile();
  const threshold = profile.match.prefilter_threshold;

  // Full rows, not the list view: the prefilter reads the description.
  const jobs = db()
    .prepare(`SELECT * FROM jobs ${includeClosed ? "" : "WHERE closedAt IS NULL"}`)
    .all() as Array<Job & { remote: number | null }>;
  const open = jobs.map((r) => ({ ...r, remote: r.remote === null ? null : r.remote === 1 }));

  // The prefilter is free, so the LLM bill is knowable before spending a cent.
  // Reporting it up front is the point of the dry run — which means it has to be
  // the SAME selection the run will make. This used to filter on the prefilter
  // alone and quoted 564 calls for a run that made 374, because scoreUnscored
  // also drops jobs in a country the profile does not name.
  const plan = planScoring(open, profile);

  const stored = db()
    .prepare(
      `SELECT COUNT(*) AS n FROM fit_scores f JOIN jobs j ON j.id = f.jobId
       ${includeClosed ? "" : "WHERE j.closedAt IS NULL"}`,
    )
    .get() as { n: number };

  const byCategory = new Map<string, number>();
  for (const j of open) {
    const id = categoryOf(j.title).id;
    byCategory.set(id, (byCategory.get(id) ?? 0) + 1);
  }

  console.error(`Jobs in scope:      ${open.length}${includeClosed ? " (incl. closed)" : " open"}`);
  console.error(`Stored scores:      ${stored.n}  <- deleted by --yes`);
  console.error(
    `Clear the prefilter threshold (${threshold}): ${plan.needsLlm.length}  <- LLM calls`,
  );
  console.error(`Free prefilter verdicts: ${plan.prefilterOnly.length}`);
  console.error(`Skipped, out of country: ${plan.foreign.length}  (left unscored, no spend)`);
  console.error("");
  console.error("By role family (current config):");
  for (const c of activeCategories().concat([
    { id: "other", label: "Other", weight: 0, patterns: [] },
  ])) {
    const n = byCategory.get(c.id) ?? 0;
    if (n) console.error(`  ${c.label.padEnd(20)} ${String(n).padStart(5)}`);
  }
  console.error("");

  if (!confirmed) {
    console.error("Dry run — nothing deleted. Re-run with --yes to clear, or --yes --score");
    console.error("to clear and score in one go. Without --score, `npm run fetch` picks them up.");
    return;
  }

  const cleared = clearFitScores({ includeClosed });
  console.error(`Cleared ${cleared} score rows.`);

  if (!alsoScore) {
    console.error("Run `npm run fetch` (or re-run with --score) to score them.");
    return;
  }

  // Only this path spends money, so only this path demands the key — the same
  // reason to-docx.ts loads env on the --job-id branch alone.
  requireEnv("ANTHROPIC_API_KEY");
  const res = await scoreUnscored(profile, {
    onProgress: (done, total) => {
      if (done % 25 === 0 || done === total) console.error(`  scored ${done}/${total}`);
    },
  });
  console.error(
    `Scored ${res.scored} (LLM attempted ${res.llmAttempted}, failed ${res.llmFailed}).`,
  );

  // A run where every call failed writes a full set of rows and exits 0, which
  // reads as success. Same guard as scripts/fetch.ts.
  if (res.llmAttempted > 0 && res.llmFailed === res.llmAttempted) {
    console.error("Every LLM call failed — these are prefilter fallbacks, not fit scores.");
    process.exit(1);
  }

  console.error(`Top of the queue now: ${countJobs({ minFit: 70 })} jobs at 70+.`);
  for (const j of listJobs({ minFit: 70, limit: 10 })) {
    console.error(
      `  ${String(j.fit?.score).padStart(3)}  [${j.category}] ${j.title} — ${j.company}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
