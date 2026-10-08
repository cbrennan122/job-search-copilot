// What the market keeps asking for that your résumé doesn't mention.
//
//   npx tsx scripts/gap-report.ts                  # jobs scoring 60+
//   npx tsx scripts/gap-report.ts --min-fit 75     # only strong matches
//   npx tsx scripts/gap-report.ts --limit 300 --out gaps.md
//
// No API key needed — this is pure counting over stored descriptions.

import { loadLocalEnv } from "../lib/env";
import { buildGapReport, formatGapReport } from "../lib/gaps";
import { writeOutput } from "../lib/outfile";
import { loadResumeBase } from "../lib/profile";
import { listJobTexts } from "../lib/store";

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function main() {
  loadLocalEnv();
  const minFit = Number(flag("min-fit", "60"));
  const limit = Number(flag("limit", "500"));

  // Only open jobs: a gap report built on listings that closed months ago
  // describes a market that has moved on.
  const jobs = listJobTexts({ minFit, limit });
  const report = buildGapReport(jobs, loadResumeBase());
  const text = formatGapReport(report);

  const out = flag("out", "");
  if (out) {
    writeOutput(out, `${text}\n`);
    console.error(`Wrote ${out} (${report.sampled} jobs, min fit ${minFit}).`);
  } else {
    console.log(text);
  }
}

main();
