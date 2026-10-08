// CLI entry for the daily fetch (cron target).
//   npx tsx scripts/fetch.ts                    # fetch + score
//   npx tsx scripts/fetch.ts --no-score         # fetch + store only (no API key needed)
//   npx tsx scripts/fetch.ts --prune-after 30   # also delete jobs closed >30 days ago

import { loadLocalEnv, requireEnv } from "../lib/env";
import { runPipeline } from "../lib/pipeline";

loadLocalEnv();

function numFlag(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  const v = Number(process.argv[i + 1]);
  if (!Number.isFinite(v) || v < 0) {
    console.error(`${name} needs a non-negative number, got ${process.argv[i + 1]}`);
    process.exit(1);
  }
  return v;
}

async function main() {
  const score = !process.argv.includes("--no-score");
  const pruneAfterDays = numFlag("--prune-after", 0);
  // Check up front. Scoring catches per-job errors and falls back to the
  // prefilter score, so a missing key otherwise costs a full fetch and leaves
  // every job wearing a fake score, with exit code 0.
  if (score) requireEnv("ANTHROPIC_API_KEY");

  console.log(`Running pipeline (scoring: ${score ? "on" : "off"})…`);
  const started = Date.now();
  // Scoring is the long pole (hundreds of LLM calls); without this the CLI
  // looks hung for minutes.
  let lastLogged = 0;
  const result = await runPipeline({
    score,
    pruneAfterDays,
    onScoreProgress: (done, total) => {
      if (done === total || done - lastLogged >= 25) {
        lastLogged = done;
        process.stdout.write(`  scoring ${done}/${total}\r`);
      }
    },
  });
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  console.log("\nPer source:");
  for (const [name, count] of Object.entries(result.perSource)) {
    // -1 is the sentinel for "the whole source threw", which is very different
    // from "the source ran and returned nothing".
    console.log(`  ${name.padEnd(12)} ${count === -1 ? "FAILED" : count}`);
  }

  console.log(`\nFetched ${result.fetched} — ${result.inserted} new, ${result.updated} refreshed.`);
  console.log(
    `Closed ${result.closed} delisted${result.pruned ? `, pruned ${result.pruned}` : ""}. ` +
      `Scored ${result.scored}. (${secs}s)`,
  );

  // A run where every LLM call 401s still writes a score for each job (the
  // prefilter fallback), so without this it prints "Scored 480" and exits 0.
  const { llmAttempted, llmFailed } = result.scoring;
  if (llmAttempted > 0 && llmFailed === llmAttempted) {
    console.error(
      `\nEVERY LLM scoring call failed (${llmFailed}/${llmAttempted}). The scores above are ` +
        `keyword prefilter values, not real fit scores.\n` +
        `Check ANTHROPIC_API_KEY, then re-run — failed jobs are re-queued automatically.`,
    );
    process.exit(1);
  }
  if (llmFailed > 0) {
    console.warn(
      `Warning: ${llmFailed}/${llmAttempted} LLM calls failed; those jobs kept a ` +
        `prefilter score and will be retried on the next run.`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
