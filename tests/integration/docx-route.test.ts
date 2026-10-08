import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { NextRequest } from "next/server";

// Must be set before the first store connection — see tests/integration/store.test.ts.
const DB = path.join(tmpdir(), `job-copilot-docx-route-${randomUUID()}.db`);
process.env.JOB_COPILOT_DB = DB;

import { GET as DOCX } from "../../app/api/jobs/[id]/docx/route";
import { GET as DETAIL } from "../../app/api/jobs/[id]/route";
import { makeJobId, saveArtifact, saveResumeVersion, upsertJobs } from "../../lib/store";
import type { Job, ResumeVersion } from "../../lib/types";

const dir = mkdtempSync(path.join(tmpdir(), `job-copilot-docx-route-${randomUUID()}-`));
const ROW = `# Connor Brennan\n\n## Summary\n\nStored row body.\n- A claim the review removed.\n`;
const FILE = `# Tailored résumé\n\n# Connor Brennan\n\n## Summary\n\nStored row body.\n`;

after(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${DB}${suffix}`, { force: true });
});

function seed(title: string, withFile: boolean): Job {
  const j: Job = {
    source: "greenhouse",
    sourceJobId: randomUUID(),
    id: makeJobId(title, "Cobalt Data", "Remote"),
    title,
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
  upsertJobs([j]);
  const v: ResumeVersion = {
    id: randomUUID(),
    jobId: j.id,
    content: ROW,
    draftedAnswers: "**Salary?** [FILL IN]",
    coverLetter: "",
    model: "claude-sonnet-5",
    createdAt: new Date().toISOString(),
  };
  saveResumeVersion(v);
  if (withFile) {
    const p = path.join(dir, `${randomUUID()}.md`);
    writeFileSync(p, FILE);
    saveArtifact(j.id, "resume-md", p);
  }
  return j;
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("GET /api/jobs/[id]/docx", () => {
  it("reports x-resume-source: row when only the stored row exists", async () => {
    const j = seed("Row Only", false);
    const res = await DOCX(new Request("http://localhost/x"), ctx(j.id));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-resume-source"), "row");
  });

  it("reports file-edited and renders the FILE when the row is stale", async () => {
    const j = seed("Edited", true);
    const res = await DOCX(new Request("http://localhost/x"), ctx(j.id));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-resume-source"), "file-edited");

    // Anchor on the bytes, not on the resolver that produced them: unzip the
    // document and read its text, so a bug shared with the resolver cannot
    // confirm itself.
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    const xml = await zip.file("word/document.xml")!.async("string");
    const text = xml.replace(/<[^>]+>/g, " ");
    assert.ok(/Connor Brennan/.test(text), "positive control: the name is in the document");
    assert.ok(!/A claim the review removed/.test(text), "must not render the stale row");
    assert.ok(!/Tailored r/.test(text), "the wrapper heading must not leak into the document");
  });

  it("names the download after the file it wrote, location included", async () => {
    const j = seed("Named", false);
    const res = await DOCX(new Request("http://localhost/x"), ctx(j.id));
    const filename = res.headers.get("content-disposition")!.match(/filename="(.+?)"/)![1];
    // Company, title and location stay readable; the job-id suffix is what makes
    // it unique, because slugging is lossy (punctuation, the 60-char cap, and
    // the "-" join all collapse distinct jobs onto one stem).
    assert.match(filename, /^Cobalt-Data-Named-Remote-[0-9a-f]{8}\.docx$/);
    assert.ok(filename.startsWith(`Cobalt-Data-Named-Remote-${j.id.slice(0, 8)}`));
  });

  it("says WHY it fell back when the file on disk is empty", async () => {
    const j = seed("Empty File", false);
    const p = path.join(dir, `${randomUUID()}.md`);
    writeFileSync(p, "   \n\n");
    saveArtifact(j.id, "resume-md", p);

    const res = await DOCX(new Request("http://localhost/x"), ctx(j.id));
    assert.equal(res.headers.get("x-resume-source"), "row", "an empty file is not an edit");
    // The CLI has always printed this; the button used to swallow it and hand
    // over the stale row with nothing to say why. Percent-encoded, because the
    // message contains an em dash and a raw header value is latin-1 only —
    // assigning it directly threw and 500'd the whole download.
    const warning = decodeURIComponent(res.headers.get("x-resume-warning") ?? "");
    assert.match(warning, /empty/);
    assert.ok(warning.includes("—"), "the message survives the encoding intact");
  });

  it("409s when the job has no résumé at all", async () => {
    const j: Job = {
      ...seed("No Resume", false),
      id: makeJobId("No Resume 2", "Cobalt Data", "Remote"),
    };
    upsertJobs([j]);
    const res = await DOCX(new Request("http://localhost/x"), ctx(j.id));
    assert.equal(res.status, 409);
  });
});

describe("GET /api/jobs/[id] — preview agrees with the download", () => {
  it("serves the edited file's body, not the stale row", async () => {
    const j = seed("Preview", true);
    const body = await (await DETAIL(new NextRequest("http://localhost/x"), ctx(j.id))).json();
    assert.equal(body.resumeSource.from, "file");
    assert.equal(body.resumeSource.diverged, true);
    assert.ok(
      !body.resume.content.includes("A claim the review removed"),
      "the on-page preview must not show the pre-review draft",
    );
    assert.ok(
      !body.resume.content.startsWith("# Tailored résumé"),
      "the wrapper heading is not part of the résumé",
    );
    assert.equal(body.resumeSource.warning, null, "nothing was rejected here");
    assert.equal(body.resumeSource.path, undefined, "the server's disk layout stays server-side");
  });

  it("passes the rejected-file warning to the page, not just to the CLI", async () => {
    const j = seed("Preview Empty", false);
    const p = path.join(dir, `${randomUUID()}.md`);
    writeFileSync(p, "\n \n");
    saveArtifact(j.id, "resume-md", p);

    const body = await (await DETAIL(new NextRequest("http://localhost/x"), ctx(j.id))).json();
    assert.equal(body.resumeSource.from, "row");
    assert.match(body.resumeSource.warning ?? "", /empty/);
  });
});
