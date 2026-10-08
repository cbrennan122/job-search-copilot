// Daily standup for the job search — a plain-text digest you can read in a
// terminal or pipe into mail/cron. Reads the DB only: no API key, no network.
//
//   npx tsx scripts/digest.ts                  # last 1 day, fit >= 70
//   npx tsx scripts/digest.ts --days 7         # a week's worth
//   npx tsx scripts/digest.ts --min-fit 50 --limit 40
//   npx tsx scripts/digest.ts --out digest.txt
//
// Three sections, in the order you'd act on them:
//   1. Follow-ups due  — commitments you already made, so they come first.
//   2. New high-fit    — jobs FIRST seen in the window (not merely re-seen).
//   3. Pipeline        — where everything stands, plus what went stale.

import { loadLocalEnv } from "../lib/env";
import { writeOutput } from "../lib/outfile";
import { countFallbackScores, countJobs, dueFollowUps, listJobs } from "../lib/store";
import { APPLICATION_STATUSES, SUBMITTED_STATUSES } from "../lib/types";

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

function strFlag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** Whole days from an ISO date to now; negative means the date is still ahead. */
function daysAgo(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

function overdueLabel(followUpAt: string): string {
  const d = daysAgo(followUpAt);
  if (d > 0) return `${d}d overdue`;
  return d === 0 ? "today" : `in ${-d}d`;
}

function main() {
  loadLocalEnv();
  const days = numFlag("--days", 1);
  const minFit = numFlag("--min-fit", 70);
  const limit = numFlag("--limit", 25);
  const out = strFlag("--out");

  const lines: string[] = [];
  const say = (s = "") => lines.push(s);

  const now = new Date();
  say(`Job search digest — ${now.toISOString().slice(0, 16).replace("T", " ")}`);
  say("=".repeat(60));

  // ---- 1. Follow-ups you owe someone -------------------------------------
  const due = dueFollowUps(now.toISOString());
  say();
  say(`FOLLOW-UPS DUE (${due.length})`);
  if (due.length === 0) {
    say("  Nothing due.");
  } else {
    for (const f of due) {
      say(`  [${f.status}] ${f.title} — ${f.company}  (${overdueLabel(f.followUpAt!)})`);
      if (f.contact) say(`      contact: ${f.contact}`);
      // One line only: notes are free-form and can run long.
      if (f.notes) say(`      ${f.notes.split("\n")[0].slice(0, 100)}`);
    }
  }

  // ---- 2. New high-fit jobs ----------------------------------------------
  // firstSeenDays, not maxAgeDays: a job re-seen in today's fetch is not new.
  const fresh = listJobs({
    minFit,
    firstSeenDays: days,
    status: "new",
    limit,
  });
  const freshTotal = countJobs({ minFit, firstSeenDays: days, status: "new" });

  say();
  say(`NEW MATCHES — fit >= ${minFit}, first seen in the last ${days}d (${freshTotal})`);
  if (fresh.length === 0) {
    say("  Nothing new. (Run `npm run fetch` if today's pipeline hasn't gone yet.)");
  } else {
    for (const j of fresh) {
      const fit = j.fit ? String(j.fit.score).padStart(3) : "  ?";
      say(`  ${fit}  ${j.title} — ${j.company}`);
      const meta = [j.remote ? "remote" : j.location, j.compensation ?? undefined, j.source].filter(
        Boolean,
      );
      say(`       ${meta.join(" · ")}`);
      say(`       ${j.url}`);
    }
    if (freshTotal > fresh.length) {
      say(`  … and ${freshTotal - fresh.length} more (raise --limit to see them).`);
    }
  }

  // ---- 3. Where the pipeline stands --------------------------------------
  say();
  say("PIPELINE");
  const counts = APPLICATION_STATUSES.map((s) => ({
    status: s,
    n: countJobs({ status: s }),
  })).filter((c) => c.n > 0);
  say("  " + (counts.map((c) => `${c.status} ${c.n}`).join("  ·  ") || "empty"));

  const live = SUBMITTED_STATUSES.filter((s) => s !== "rejected");
  const inFlight = live.reduce((n, s) => n + countJobs({ status: s }), 0);
  say(`  ${inFlight} application${inFlight === 1 ? "" : "s"} still live.`);

  // Open + unseen for a while: feed sources can't be authoritatively delisted,
  // so these are the ones worth eyeballing before you spend effort on them.
  const total = countJobs({});
  const stale = total - countJobs({ maxAgeDays: 7 });
  if (stale > 0) {
    say(`  ${stale} open job${stale === 1 ? "" : "s"} not seen in a fetch for 7d+.`);
  }

  // Unscored rows COALESCE to -1, so `minFit: 0` is exactly "has a score".
  const noScore = total - countJobs({ minFit: 0 });
  if (noScore > 0) {
    say(`  ${noScore} unscored — run \`npm run fetch\` with an API key to score them.`);
  }

  // A fallback row HAS a score, so it is not "unscored" — but the number came
  // from the keyword prefilter after the LLM call failed, not from a fit
  // judgement. Without this line a whole failed scoring run is invisible here:
  // the queue looks ranked, and the ranking is keyword noise.
  const provisional = countFallbackScores();
  if (provisional > 0) {
    say(
      `  ${provisional} PROVISIONAL score${provisional === 1 ? "" : "s"} — ` +
        `the LLM call failed, so these show a keyword score. ` +
        `Re-run \`npm run fetch\` with a working key to replace them.`,
    );
  }

  const text = lines.join("\n") + "\n";
  if (out) {
    writeOutput(out, text);
    console.log(`Wrote ${out}`);
  } else {
    process.stdout.write(text);
  }
}

main();
