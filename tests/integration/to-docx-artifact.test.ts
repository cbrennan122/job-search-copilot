import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

// Set before the first store connection — see tests/store.test.ts. The CLI runs
// as a subprocess, so it is passed through the child's env as well.
const DB = path.join(tmpdir(), `job-copilot-artifact-${randomUUID()}.db`);
process.env.JOB_COPILOT_DB = DB;

import {
  latestResume,
  listArtifacts,
  makeJobId,
  saveArtifact,
  saveResumeVersion,
  upsertJobs,
} from "../../lib/store";
import type { Job, ResumeVersion } from "../../lib/types";

const ROOT = path.resolve(import.meta.dirname, "../..");
const dir = mkdtempSync(path.join(tmpdir(), `job-copilot-artifact-${randomUUID()}-`));
const md = path.join(dir, "tailored.md");
const out = path.join(dir, "tailored.docx");

const JOB: Job = {
  source: "greenhouse",
  sourceJobId: "x",
  id: makeJobId("Site Reliability Engineer", "Cobalt Data", "Remote"),
  title: "Site Reliability Engineer",
  company: "Cobalt Data",
  location: "Remote",
  remote: true,
  url: "https://example.com/jobs/1",
  description: "Keep things running.",
  postedAt: null,
  fetchedAt: new Date().toISOString(),
  compensation: null,
  employmentType: null,
  department: null,
};

upsertJobs([JOB]);
writeFileSync(md, `# Jane Doe\njane@example.com\n\n## Experience\n\n- Did the work\n`);

after(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${DB}${suffix}`, { force: true });
});

/**
 * Run the real CLI, with the throwaway DB handed to the child process.
 *
 * spawnSync rather than execFileSync: the latter *returns stdout* and signals
 * failure by throwing, so the exit status of a successful run is not available
 * to assert on. This script reports on stderr and its exit code is the thing
 * under test.
 */
function toDocx(args: string[]): { status: number | null; stderr: string } {
  const r = spawnSync("npx", ["tsx", "scripts/to-docx.ts", ...args], {
    cwd: ROOT,
    env: { ...process.env, JOB_COPILOT_DB: DB },
    encoding: "utf8",
  });
  return { status: r.status, stderr: r.stderr ?? "" };
}

describe("to-docx --job-id", () => {
  it("records the .docx it wrote against the job", () => {
    // The point of the whole feature: "applied" should be able to say which
    // file was attached, not just that a résumé was generated at some point.
    const r = toDocx([md, "--out", out, "--job-id", JOB.id]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(out), "the .docx was written");

    const rows = listArtifacts(JOB.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, "resume-docx");
    assert.equal(rows[0].path, path.resolve(out), "stored as an absolute path");
  });

  it("records nothing when no --job-id is given", () => {
    // Without the flag this stays a pure formatter that never opens the DB.
    const other = path.join(dir, "plain.docx");
    const r = toDocx([md, "--out", other]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(other));
    assert.equal(listArtifacts(JOB.id).length, 1, "still just the one from above");
  });

  it("with NO .md, renders the edited file and commits it back as a version", () => {
    // The branch the resume-source change rewired, and previously untested: no
    // positional .md, so the résumé is resolved from the job. The stored row is
    // the pre-review draft; the file on disk is what the review left behind.
    const j: Job = {
      ...JOB,
      id: makeJobId("Resolved Role", "Cobalt Data", "Remote"),
      title: "Resolved Role",
      sourceJobId: "resolved",
    };
    upsertJobs([j]);
    const stale: ResumeVersion = {
      id: "stale-version",
      jobId: j.id,
      content: `# Jane Doe\n\n## Experience\n\n- Did the work\n- A claim the review removed\n`,
      draftedAnswers: "**Salary?** [FILL IN]",
      coverLetter: "",
      model: "claude-sonnet-5",
      createdAt: new Date().toISOString(),
    };
    saveResumeVersion(stale);
    const reviewed = path.join(dir, "reviewed.md");
    writeFileSync(reviewed, `# Tailored résumé\n\n# Jane Doe\n\n## Experience\n\n- Did the work\n`);
    saveArtifact(j.id, "resume-md", reviewed);

    const built = path.join(dir, "resolved.docx");
    const r = toDocx(["--job-id", j.id, "--out", built]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(built), "a .docx was produced with no .md argument");
    assert.match(r.stderr, /edited since it was tailored/, "it says which copy it used");

    // The row caught up, so resume_versions stays real history instead of
    // freezing at the pre-review draft.
    const now = latestResume(j.id)!;
    assert.ok(!now.content.includes("A claim the review removed"), "row was reconciled");
    assert.equal(now.draftedAnswers, stale.draftedAnswers, "answers survived the reconcile");
  });

  it("refuses an unknown job id, and writes no file", () => {
    // Validated before rendering: a mistyped id should cost nothing and explain
    // itself, not fail with "FOREIGN KEY constraint failed" after the document
    // is already on disk.
    const ghost = path.join(dir, "ghost.docx");
    const r = toDocx([md, "--out", ghost, "--job-id", "no-such-job"]);
    assert.equal(r.status, 1, "exits non-zero");
    assert.match(r.stderr, /No job with id no-such-job/);
    assert.ok(!existsSync(ghost), "nothing was written for a bad id");
  });
});
