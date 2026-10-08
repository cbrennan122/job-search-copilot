import { strict as assert } from "node:assert";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
// A static import is safe here even though the fixture is written below it:
// lib/store resolves JOB_COPILOT_DB lazily, on the first connection rather than
// at module load, so nothing touches the file until a test calls into it.
import * as store from "../../lib/store";

// A database created by the ORIGINAL (pre-migration-runner) schema, so this
// exercises the real upgrade path a returning user hits — not a fresh file that
// happens to be built by the same code we're testing.
const DB = path.join(tmpdir(), `job-copilot-migrate-${randomUUID()}.db`);
process.env.JOB_COPILOT_DB = DB;

const FETCHED_AT = "2026-01-01T00:00:00.000Z";

function seedV1Database(): void {
  const raw = new Database(DB);
  raw.exec(`
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, sourceJobId TEXT NOT NULL,
      title TEXT NOT NULL, company TEXT NOT NULL, location TEXT NOT NULL,
      remote INTEGER, description TEXT NOT NULL, url TEXT NOT NULL,
      postedAt TEXT, fetchedAt TEXT NOT NULL
    );
    CREATE TABLE fit_scores (
      jobId TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
      score INTEGER NOT NULL, reason TEXT NOT NULL, model TEXT NOT NULL, scoredAt TEXT NOT NULL
    );
    CREATE TABLE applications (
      jobId TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
      status TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    CREATE TABLE resume_versions (
      id TEXT PRIMARY KEY, jobId TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      content TEXT NOT NULL, draftedAnswers TEXT NOT NULL, model TEXT NOT NULL, createdAt TEXT NOT NULL
    );
  `);
  raw
    .prepare(
      `INSERT INTO jobs (id, source, sourceJobId, title, company, location, remote,
                         description, url, postedAt, fetchedAt)
       VALUES ('legacy1','greenhouse','g1','Staff SRE','Acme','Remote',1,'d','https://e.com',NULL,?)`,
    )
    .run(FETCHED_AT);
  raw
    .prepare(`INSERT INTO applications (jobId, status, updatedAt) VALUES ('legacy1','applied',?)`)
    .run(FETCHED_AT);
  assert.equal(raw.pragma("user_version", { simple: true }), 0, "fixture must start at v0");
  raw.close();
}

// Runs at load time, before any test body — so the first store call migrates it.
seedV1Database();

after(() => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${DB}${suffix}`, { force: true });
});

describe("schema migration", () => {
  it("upgrades a pre-existing v1 database in place", () => {
    const job = store.getJob("legacy1");
    assert.ok(job, "the legacy row must survive the upgrade");
    assert.equal(job.title, "Staff SRE");
    assert.equal(store.getApplication("legacy1").status, "applied");
  });

  it("backfills lastSeenAt from fetchedAt rather than leaving it NULL", () => {
    // A NULL here would make every legacy job invisible to the maxAgeDays filter.
    const row = store
      .db()
      .prepare(`SELECT lastSeenAt, closedAt FROM jobs WHERE id = 'legacy1'`)
      .get() as { lastSeenAt: string | null; closedAt: string | null };
    assert.equal(row.lastSeenAt, FETCHED_AT);
    assert.equal(row.closedAt, null, "an existing job must not be born closed");
  });

  it("stamps user_version so the steps do not run twice", () => {
    const v = store.db().pragma("user_version", { simple: true }) as number;
    assert.ok(v >= 2, `expected user_version >= 2, got ${v}`);
  });

  it("is idempotent — reopening a migrated database is a no-op", () => {
    // Re-running the ALTER TABLE steps would throw "duplicate column name".
    const reopened = new Database(DB);
    const before = reopened.pragma("user_version", { simple: true });
    reopened.close();
    assert.doesNotThrow(() => {
      const again = new Database(DB);
      assert.equal(again.pragma("user_version", { simple: true }), before);
      again.close();
    });
  });

  it("leaves the new tracker columns queryable", () => {
    store.updateApplication("legacy1", { notes: "n", contact: "c", followUpAt: "2026-09-01" });
    const a = store.getApplication("legacy1");
    assert.equal(a.notes, "n");
    assert.equal(a.contact, "c");
    assert.equal(a.followUpAt, "2026-09-01");
    assert.equal(a.status, "applied", "an unrelated patch must not reset status");
  });
});
