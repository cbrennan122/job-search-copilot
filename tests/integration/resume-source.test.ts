import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

// Set before the first store connection — see tests/integration/store.test.ts.
const DB = path.join(tmpdir(), `job-copilot-resume-source-${randomUUID()}.db`);
process.env.JOB_COPILOT_DB = DB;

import { writeOutput } from "../../lib/outfile";
import { resumeMdPathFor } from "../../lib/paths";
import { commitResumeEdit, resolveResumeMarkdown } from "../../lib/resume-source";
import {
  latestResume,
  makeJobId,
  saveArtifact,
  saveResumeVersion,
  upsertJobs,
} from "../../lib/store";
import type { Job, ResumeVersion } from "../../lib/types";

// Résumé files are found through each job's own resume-md ARTIFACT row, so a
// test can point them at a temp directory. Nothing here writes into the real
// resumes/markdown/, which the previous version of this file did.
const dir = mkdtempSync(path.join(tmpdir(), `job-copilot-resume-src-${randomUUID()}-`));
const RESUME = `# Connor Brennan\n\n## Summary\n\nReal résumé body.\n`;

after(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(DB, { force: true });
});

function job(title: string, company: string, location = "Remote"): Job {
  const j: Job = {
    source: "greenhouse",
    sourceJobId: randomUUID(),
    id: makeJobId(title, company, location),
    title,
    company,
    location,
    remote: true,
    url: "https://example.com/jobs/1",
    description: "Keep things running.",
    postedAt: null,
    fetchedAt: new Date().toISOString(),
    compensation: null,
    employmentType: null,
    department: null,
  };
  upsertJobs([j]);
  return j;
}

function version(jobId: string, content: string): ResumeVersion {
  const v: ResumeVersion = {
    id: randomUUID(),
    jobId,
    content,
    draftedAnswers: "**Salary?** [FILL IN]",
    coverLetter: "",
    model: "claude-sonnet-5",
    createdAt: new Date().toISOString(),
  };
  saveResumeVersion(v);
  return v;
}

/** Write a résumé file and register it as this job's, the way tailorForJob does. */
function place(j: Job, text: string, name = `${randomUUID()}.md`): string {
  const p = path.join(dir, name);
  writeFileSync(p, text);
  saveArtifact(j.id, "resume-md", p);
  return p;
}

describe("resolveResumeMarkdown", () => {
  it("returns null for a job with neither a row nor a file", () => {
    assert.equal(resolveResumeMarkdown(job("Nothing", "Cobalt")), null);
  });

  it("falls back to the stored row when no file exists", () => {
    const j = job("Row Only", "Cobalt");
    version(j.id, RESUME);
    const got = resolveResumeMarkdown(j)!;
    assert.equal(got.from, "row");
    assert.equal(got.markdown, RESUME);
    assert.equal(got.diverged, false);
  });

  it("does NOT report a freshly written file as edited, despite the wrapper heading", () => {
    // tailorForJob() writes "# Tailored résumé\n\n" + content, so the file and
    // the row are never byte-identical.
    const j = job("Wrapper", "Cobalt");
    version(j.id, RESUME);
    place(j, `# Tailored résumé\n\n${RESUME}\n`);
    const got = resolveResumeMarkdown(j)!;
    assert.equal(got.from, "file");
    assert.equal(got.diverged, false, "wrapper heading alone must not count as an edit");
  });

  it("ignores cosmetic resaves: CRLF, BOM, trailing spaces, decomposed accents", () => {
    const j = job("Cosmetic", "Cobalt");
    version(j.id, `# Connor Brennan\n\nWorked on résumé tooling.\n`);
    // BOM + CRLF + trailing spaces + "résumé" with a COMBINING acute accent.
    place(j, "﻿# Tailored résumé\r\n\r\n# Connor Brennan   \r\n\r\nWorked on résumé tooling.\r\n");
    const got = resolveResumeMarkdown(j)!;
    assert.equal(got.from, "file");
    assert.equal(got.diverged, false, "a resave that changes no words is not an edit");
  });

  it("prefers the edited file over the stale row, and flags the divergence", () => {
    const j = job("Edited", "Cobalt");
    version(j.id, `${RESUME}\n- Added Pytest coverage for an AI chat service.\n`);
    place(j, `# Tailored résumé\n\n${RESUME}`);
    const got = resolveResumeMarkdown(j)!;
    assert.equal(got.from, "file");
    assert.equal(got.diverged, true);
    assert.ok(!got.markdown.includes("AI chat service"), "must render the reviewed file");
    assert.ok(got.version!.content.includes("AI chat service"), "the stale row is still there");
  });

  it("does not let one job's file be served for another at the same company and title", () => {
    // Two distinct jobs that differ only in location. This exercises the
    // RESOLVER in isolation — the files are at unrelated paths — so it proves
    // resolution goes through each job's own artifact row and cannot cross
    // over. Where those files actually land is covered separately, below.
    const a = job("Senior SDET", "Acme", "Remote");
    const b = job("Senior SDET", "Acme", "New York, NY");
    assert.notEqual(a.id, b.id, "same company+title, different location = different jobs");

    version(a.id, RESUME);
    version(b.id, RESUME);
    place(a, `# Tailored résumé\n\n${RESUME}\nTAILORED FOR THE REMOTE ROLE\n`);
    place(b, `# Tailored résumé\n\n${RESUME}\nTAILORED FOR THE NEW YORK ROLE\n`);

    const ra = resolveResumeMarkdown(a)!;
    const rb = resolveResumeMarkdown(b)!;
    assert.ok(ra.markdown.includes("REMOTE ROLE"), "job A must get job A's résumé");
    assert.ok(!ra.markdown.includes("NEW YORK"), "job A must NOT get job B's résumé");
    assert.ok(rb.markdown.includes("NEW YORK ROLE"), "job B must get job B's résumé");
  });

  it("refuses an empty file and falls back to the row rather than rendering a blank document", () => {
    const j = job("Empty File", "Cobalt");
    version(j.id, RESUME);
    place(j, "   \n\n  \n");
    const got = resolveResumeMarkdown(j)!;
    assert.equal(got.from, "row", "an empty file is corruption, not an edit");
    assert.equal(got.markdown, RESUME);
    assert.ok(got.from === "row" && got.warning?.includes("empty"), "and it says why");
  });

  it("survives a directory sitting at the recorded path", () => {
    const j = job("Dir At Path", "Cobalt");
    version(j.id, RESUME);
    const p = path.join(dir, `${randomUUID()}.md`);
    mkdirSync(p);
    saveArtifact(j.id, "resume-md", p);
    // EISDIR from readFileSync must not escape as an unhandled throw.
    const got = resolveResumeMarkdown(j)!;
    assert.equal(got.from, "row");
  });

  it("ignores a recorded file that no longer exists", () => {
    const j = job("Deleted File", "Cobalt");
    version(j.id, RESUME);
    saveArtifact(j.id, "resume-md", path.join(dir, "gone-forever.md"));
    assert.equal(resolveResumeMarkdown(j)!.from, "row");
  });
});

describe("commitResumeEdit", () => {
  it("writes the edited body back as a new version, leaving the old one in history", () => {
    const j = job("Commit", "Cobalt");
    const original = version(j.id, `${RESUME}\n- A claim the review removed.\n`);
    place(j, `# Tailored résumé\n\n${RESUME}`);

    const committed = commitResumeEdit(j)!;
    assert.ok(committed, "an edited file must produce a new version");
    assert.ok(!committed.content.includes("A claim the review removed"));
    assert.ok(!committed.content.startsWith("# Tailored résumé"), "wrapper must not be stored");
    // Answers are a separate column and must survive a résumé-only reconcile.
    assert.equal(committed.draftedAnswers, original.draftedAnswers);
    assert.equal(latestResume(j.id)!.content, committed.content, "it is now the latest");

    // And the file no longer diverges, because the row caught up.
    assert.equal(resolveResumeMarkdown(j)!.diverged, false);
  });

  it("is a no-op when the file matches the row", () => {
    const j = job("No Op", "Cobalt");
    version(j.id, RESUME);
    place(j, `# Tailored résumé\n\n${RESUME}\n`);
    assert.equal(commitResumeEdit(j), null);
  });

  it("is a no-op when there is no file at all", () => {
    const j = job("No File", "Cobalt");
    version(j.id, RESUME);
    assert.equal(commitResumeEdit(j), null);
  });
});

describe("the real on-disk write path", () => {
  // Everything above places files at random paths, which proves the RESOLVER
  // cannot serve one job's file to another but says nothing about where the
  // writer puts them. That gap hid a live bug for a week: tailorForJob keyed the
  // filename on company+title alone, so tailoring job B overwrote job A's file
  // IN PLACE — and job A then read job B's résumé back through its own, still
  // valid artifact row, flagged `diverged` as though a human had reviewed it.
  // Reproduced 2026-09-03. Hence a test that uses the real path builder.
  const COMPANY = `ZZ Test Co ${randomUUID().slice(0, 8)}`;
  const written: string[] = [];

  after(() => {
    for (const p of written) rmSync(p, { force: true });
  });

  /** Exactly what tailorForJob does: write to the computed path, record it. */
  function tailorTo(j: Job, marker: string): string {
    const p = resumeMdPathFor(j);
    writeOutput(p, `# Tailored résumé\n\n${RESUME}\n${marker}\n`);
    written.push(p);
    saveArtifact(j.id, "resume-md", p);
    return p;
  }

  it("gives two jobs at one company and title their own files, and keeps them apart", () => {
    const a = job("Senior SDET", COMPANY, "Remote");
    const b = job("Senior SDET", COMPANY, "New York, NY");
    assert.notEqual(a.id, b.id);
    version(a.id, RESUME);
    version(b.id, RESUME);

    const pa = tailorTo(a, "TAILORED FOR THE REMOTE ROLE");
    const pb = tailorTo(b, "TAILORED FOR THE NEW YORK ROLE");
    assert.notEqual(pa, pb, "two jobs must never share one file on disk");

    // Job A resolves AFTER job B was tailored: the old bug is a write that has
    // already happened by this point.
    const ra = resolveResumeMarkdown(a)!;
    assert.equal(ra.from, "file");
    assert.equal(ra.from === "file" && ra.path, pa);
    assert.ok(ra.markdown.includes("REMOTE ROLE"), "job A must get job A's résumé");
    assert.ok(!ra.markdown.includes("NEW YORK"), "job A must NOT be served job B's résumé");

    const rb = resolveResumeMarkdown(b)!;
    assert.ok(rb.markdown.includes("NEW YORK ROLE"), "job B must get job B's résumé");
  });
});
