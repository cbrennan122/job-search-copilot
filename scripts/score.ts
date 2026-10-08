// CLI entry for scoring alone — no board fetch, no delisting, no clearing.
//
//   npx tsx scripts/score.ts             # score whatever is still unscored
//   npx tsx scripts/score.ts --dry-run   # what it would cost, without spending
//
// Why this exists: neither other entry point can resume a run that died partway.
// `fetch.ts` hits every board first, so finishing 115 stranded jobs also pulls in
// new ones and bills for them; `rescore.ts --score` is welded to --yes, which
// CLEARS every stored score and re-spends on the whole queue. This does exactly
// the calls still owed: unscoredJobs() re-queues never-scored rows and
// FALLBACK_MODEL retries, so a run cut short by an expired key or an empty credit
// balance picks up precisely where it stopped. A half-scored queue is worse than
// an unscored one — fallback rows keep their keyword prefilter score, which
// outranks real fit scores and puts artifacts at the top of the queue.

import { loadLocalEnv, requireEnv } from "../lib/env";
import { planScoring, scoreUnscored } from "../lib/fit";
import { loadProfile } from "../lib/profile";
import { unscoredJobs } from "../lib/store";

loadLocalEnv();

const dryRun = process.argv.includes("--dry-run");

async function main() {
  const profile = loadProfile();
  // Same selection the run itself makes — see planScoring's contract.
  const plan = planScoring(unscoredJobs(), profile);
  const queued = plan.foreign.length + plan.prefilterOnly.length + plan.needsLlm.length;

  console.error(`Re-queued by unscoredJobs(): ${queued}`);
  console.error(`  skipped, out of country:   ${plan.foreign.length}  (left unscored, no spend)`);
  console.error(`  free prefilter verdicts:   ${plan.prefilterOnly.length}`);
  console.error(`  LLM calls:                 ${plan.needsLlm.length}  <- the only cost`);

  if (dryRun) {
    console.error("\nDry run — nothing scored. Re-run without --dry-run to spend.");
    return;
  }
  if (plan.prefilterOnly.length === 0 && plan.needsLlm.length === 0) {
    console.error("\nNothing to score.");
    return;
  }

  // Check up front. Scoring catches per-job errors and falls back to the
  // prefilter score, so a missing key otherwise leaves every job wearing a fake
  // score and still exits 0 — the same reason fetch.ts checks before running.
  if (plan.needsLlm.length > 0) requireEnv("ANTHROPIC_API_KEY");

  const started = Date.now();
  const res = await scoreUnscored(profile, {
    onProgress: (done, total) => {
      if (done === total || done % 25 === 0) console.error(`  scored ${done}/${total}`);
    },
  });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.error(
    `\nScored ${res.scored} (LLM attempted ${res.llmAttempted}, failed ${res.llmFailed}). (${secs}s)`,
  );

  // A run where every call failed writes a full set of rows and exits 0, which
  // reads as success. Same guard as scripts/fetch.ts and scripts/rescore.ts.
  if (res.llmAttempted > 0 && res.llmFailed === res.llmAttempted) {
    console.error(
      `\nEVERY LLM scoring call failed (${res.llmFailed}/${res.llmAttempted}). Those jobs are ` +
        `wearing keyword prefilter values, not fit scores.\n` +
        `Fix the cause, then re-run — they are re-queued automatically.`,
    );
    process.exit(1);
  }
  if (res.llmFailed > 0) {
    console.warn(
      `Warning: ${res.llmFailed}/${res.llmAttempted} LLM calls failed; those jobs kept a ` +
        `prefilter score and are re-queued for the next run.`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
