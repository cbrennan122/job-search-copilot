import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

// Must be set before the first store connection — see tests/store.test.ts.
const DB = path.join(tmpdir(), `job-copilot-apply-${randomUUID()}.db`);
process.env.JOB_COPILOT_DB = DB;

import { NextRequest } from "next/server";
import { POST } from "../../app/api/apply/route";
import { makeJobId, upsertJobs } from "../../lib/store";
import type { Job } from "../../lib/types";

after(() => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${DB}${suffix}`, { force: true });
});

const JOB: Job = {
  source: "greenhouse",
  sourceJobId: "x",
  id: makeJobId("Platform Engineer", "Cobalt Data", "Remote"),
  title: "Platform Engineer",
  company: "Cobalt Data",
  location: "Remote",
  remote: true,
  url: "https://example.com/jobs/1",
  description: "Build the platform.",
  postedAt: null,
  fetchedAt: new Date().toISOString(),
  compensation: null,
  employmentType: null,
  department: null,
};

upsertJobs([JOB]);

async function post(body: unknown) {
  const res = await POST(
    new NextRequest("http://localhost/api/apply", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: await res.json() };
}

describe("POST /api/apply", () => {
  it("updates the application for a job that exists", async () => {
    // The positive control for the 404 test below: the same call shape has to
    // still succeed, or "returns 404" would just mean "the route is broken".
    const { status, body } = await post({ jobId: JOB.id, status: "applied" });
    assert.equal(status, 200);
    assert.equal(body.application.status, "applied");
    assert.ok(body.application.appliedAt, "appliedAt stamped");
  });

  it("answers 404 for a jobId that is not in the queue", async () => {
    // applications.jobId is an FK onto jobs, and getApplication() returns a
    // default row rather than throwing, so an unknown id got all the way to the
    // INSERT and surfaced as an unhandled framework 500.
    const { status, body } = await post({ jobId: "no-such-job", status: "applied" });
    assert.equal(status, 404, "a missing job is the caller's error, not a server fault");
    assert.match(body.error, /no job with id/);
  });

  it("still rejects a missing jobId with 400", async () => {
    const { status } = await post({ status: "applied" });
    assert.equal(status, 400);
  });

  it("still rejects an unknown status with 400", async () => {
    const { status } = await post({ jobId: JOB.id, status: "ghosted" });
    assert.equal(status, 400);
  });
});
