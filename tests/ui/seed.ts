// Build the fixture database the e2e run serves from.
//
// Run via playwright.config.ts BEFORE the web server starts, with
// JOB_COPILOT_DB pointing at a throwaway file. The real queue is never touched:
// `dbFile()` honours JOB_COPILOT_DB, which is the same escape hatch the unit
// tests use. The dev server the developer already has on :3000 is a different
// process against the real DB — the config uses its own port for that reason.
//
// The data is deliberately small and fixed. Assertions quote these exact strings,
// so a test that passes because the developer happens to have a matching job in
// their own queue is impossible.

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import {
  makeJobId,
  saveArtifact,
  saveFitScore,
  saveResumeVersion,
  upsertJobs,
} from "../../lib/store";
import type { Job } from "../../lib/types";

const NOW = "2026-08-28T00:00:00.000Z";

function job(over: Partial<Job> & Pick<Job, "title" | "company" | "location">): Job {
  return {
    id: makeJobId(over.title, over.company, over.location),
    source: "greenhouse",
    sourceJobId: `${over.company}-${over.title}`.replace(/\s+/g, "-").toLowerCase(),
    remote: null,
    description: `Job description for ${over.title} at ${over.company}.`,
    url: `https://example.test/${encodeURIComponent(over.title)}`,
    postedAt: NOW,
    fetchedAt: NOW,
    compensation: null,
    employmentType: "FullTime",
    department: null,
    ...over,
  };
}

/** The fixture. Exported so specs assert against the same strings the seed wrote. */
export const FIXTURE = {
  /** High fit, has a tailored résumé + artifacts — drives the detail-page tests. */
  tailored: job({
    title: "Staff Platform Engineer",
    company: "Fixture Labs",
    location: "Remote, United States",
    remote: true,
    compensation: "$200K – $250K",
  }),
  /** High fit, no résumé — proves Download .docx is absent until one exists. */
  untailored: job({
    title: "Senior Backend Engineer",
    company: "Seedworks",
    location: "Boston, MA",
  }),
  /** Low fit, so a minFit filter can be shown to actually remove a row. */
  lowFit: job({
    title: "Warehouse Associate",
    company: "Dockside Freight",
    location: "Boston, MA",
  }),
  /**
   * A fresh/stale PAIR for the "Seen" age filter, which needs two rows of
   * different ages to say anything: with one row, a filter that hides
   * everything and a filter that hides nothing look identical.
   *
   * Their ages are relative to now, unlike the fixed NOW the rest of the
   * fixture uses. A literal date drifts — every fixture row silently ages past
   * "last 7 days" as real time passes, so an age assertion written against one
   * would pass today and fail next week for no reason in the diff.
   */
  freshlySeen: job({
    title: "Platform Reliability Engineer",
    company: "Freshfield",
    location: "Remote, United States",
    remote: true,
    fetchedAt: new Date().toISOString(),
  }),
  /** Last returned by a source 60 days ago: what "Seen" must hide. */
  longStale: job({
    title: "Legacy Systems Engineer",
    company: "Dustbowl",
    location: "Remote, United States",
    remote: true,
    fetchedAt: new Date(Date.now() - 60 * 86_400_000).toISOString(),
  }),
} as const;

export const RESUME_MARKER = "FIXTURE-RESUME-BODY-MARKER";
export const ANSWERS_MARKER = "FIXTURE-ANSWERS-MARKER";

export function seed(dbPath: string): void {
  // Start from nothing every run: a fixture DB that accumulates rows across runs
  // would let a stale row satisfy an assertion the current seed no longer makes.
  if (existsSync(dbPath)) rmSync(dbPath);
  mkdirSync(dirname(dbPath), { recursive: true });

  const jobs = [
    FIXTURE.tailored,
    FIXTURE.untailored,
    FIXTURE.lowFit,
    FIXTURE.freshlySeen,
    FIXTURE.longStale,
  ];
  upsertJobs(jobs);

  saveFitScore({
    jobId: FIXTURE.tailored.id,
    score: 88,
    reason: "Fixture reason: strong match on platform and infrastructure work.",
    model: "claude-sonnet-5",
    scoredAt: NOW,
  });
  saveFitScore({
    jobId: FIXTURE.untailored.id,
    score: 74,
    reason: "Fixture reason: solid backend overlap.",
    model: "claude-sonnet-5",
    scoredAt: NOW,
  });
  saveFitScore({
    jobId: FIXTURE.lowFit.id,
    score: 4,
    reason: "Fixture reason: unrelated role.",
    model: "claude-sonnet-5",
    scoredAt: NOW,
  });

  // Both above the default minFit of 50, so the age filter is the only thing
  // that can remove them from the queue.
  saveFitScore({
    jobId: FIXTURE.freshlySeen.id,
    score: 81,
    reason: "Fixture reason: seen in the latest fetch.",
    model: "claude-sonnet-5",
    scoredAt: NOW,
  });
  saveFitScore({
    jobId: FIXTURE.longStale.id,
    score: 80,
    reason: "Fixture reason: not returned by a source in months.",
    model: "claude-sonnet-5",
    scoredAt: NOW,
  });

  saveResumeVersion({
    id: "fixture-resume-version",
    jobId: FIXTURE.tailored.id,
    content: `# Connor Brennan\n\nBoston, MA\n\n## Experience\n\n${RESUME_MARKER}\n`,
    draftedAnswers: `**Why this company?**\n\n${ANSWERS_MARKER}\n`,
    coverLetter: "",
    model: "claude-sonnet-5",
    createdAt: NOW,
  });

  // One of each kind, so the Generated files list can be checked for the
  // prep-only tag that must appear on answers-md and nowhere else.
  saveArtifact(FIXTURE.tailored.id, "resume-md", "resumes/markdown/Fixture-Labs-Staff.md");
  saveArtifact(FIXTURE.tailored.id, "answers-md", "resumes/markdown/Fixture-Labs-Staff-answers.md");
}

if (require.main === module) {
  const target = process.env.JOB_COPILOT_DB;
  if (!target) {
    console.error("JOB_COPILOT_DB must be set — refusing to seed the real queue.");
    process.exit(1);
  }
  seed(target);
  console.error(`Seeded fixture database at ${target}`);
}
