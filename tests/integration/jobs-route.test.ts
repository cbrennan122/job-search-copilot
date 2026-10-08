import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

// Must be set before the first store connection — see tests/store.test.ts.
const DB = path.join(tmpdir(), `job-copilot-route-${randomUUID()}.db`);
process.env.JOB_COPILOT_DB = DB;
// Point the profile dir at nothing so activeCategories() falls back to the built-in
// DEFAULT_CATEGORIES. profile/ is gitignored and absent in CI, but present locally — without
// this the expected labels below would depend on whatever targeting the developer has set.
process.env.JOB_COPILOT_PROFILE_DIR = path.join(tmpdir(), `job-copilot-no-profile-${randomUUID()}`);

import { NextRequest } from "next/server";
import { GET } from "../../app/api/jobs/route";
import { makeJobId, upsertJobs } from "../../lib/store";
import type { Job } from "../../lib/types";

after(() => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${DB}${suffix}`, { force: true });
});

function job(title: string, company: string): Job {
  return {
    source: "greenhouse",
    sourceJobId: title,
    id: makeJobId(title, company, "Remote"),
    title,
    company,
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
}

// One per role family, so the category filter has something to exclude. Titles are chosen
// to land in a known family via the built-in patterns, not to be realistic postings.
const JOBS: Job[] = [
  job("Site Reliability Engineer", "Northwind Systems"), // devops
  job("Senior Backend Engineer", "Contoso"), // swe
  job("SDET II", "Fabrikam"), // sdet
  job("Account Executive", "Initech"), // other
];

upsertJobs(JOBS);

const get = async (qs: string) =>
  (await GET(new NextRequest(`http://localhost/api/jobs${qs}`))).json();

describe("GET /api/jobs", () => {
  it("returns jobs when no paging params are supplied", async () => {
    // Regression: intParam did Number(null) === 0, so an absent ?limit= became
    // LIMIT 0 — an empty page served alongside a non-zero total. Every caller
    // that is not the dashboard (curl, a script, a new UI path) hit this.
    const body = await get("");
    assert.equal(body.total, JOBS.length);
    assert.equal(body.limit, 50, "falls back to DEFAULT_LIMIT, not 0");
    assert.equal(body.jobs.length, JOBS.length, "an omitted limit must not empty the page");
  });

  it("still honours an explicit limit", async () => {
    const body = await get("?limit=1&offset=0");
    assert.equal(body.limit, 1);
    assert.equal(body.jobs.length, 1);
  });

  it("falls back when the limit is not a usable integer", async () => {
    for (const qs of ["?limit=", "?limit=abc", "?limit=-5", "?limit=1.5"]) {
      const body = await get(qs);
      assert.equal(body.limit, 50, `${qs} should fall back to the default`);
    }
  });

  it("treats an explicit limit=0 as the caller's choice", async () => {
    // Distinct from absence: someone asking for zero rows gets zero rows.
    const body = await get("?limit=0");
    assert.equal(body.limit, 0);
    assert.equal(body.jobs.length, 0);
  });
});

describe("GET /api/jobs — role families", () => {
  it("ships the category list with every page, most-preferred first", async () => {
    // app/page.tsx builds its entire Role dropdown from this. If the route stopped
    // sending it the filter would silently become an empty list, with nothing else failing.
    const body = await get("");
    assert.deepEqual(
      body.categories.map((c: { id: string }) => c.id),
      ["swe", "devops", "sdet", "other"],
      "ordered by preference weight, descending",
    );
    assert.equal(
      body.categories.find((c: { id: string }) => c.id === "swe")?.label,
      "Software Engineer",
      "labels ship too — the client renders these verbatim",
    );
  });

  it("labels every row with its family", async () => {
    const body = await get("");
    const byTitle = Object.fromEntries(
      body.jobs.map((j: { title: string; category: string }) => [j.title, j.category]),
    );
    assert.deepEqual(byTitle, {
      "Senior Backend Engineer": "swe",
      "Site Reliability Engineer": "devops",
      "SDET II": "sdet",
      "Account Executive": "other",
    });
  });

  it("filters to one family, and the total agrees with the page", async () => {
    for (const [id, title] of [
      ["swe", "Senior Backend Engineer"],
      ["devops", "Site Reliability Engineer"],
      ["sdet", "SDET II"],
    ] as const) {
      const body = await get(`?category=${id}`);
      assert.equal(body.jobs.length, 1, `${id} should match exactly one fixture`);
      assert.equal(body.jobs[0].title, title);
      // countJobs runs the same filter separately; a mismatch means the UI would page
      // through rows that aren't there.
      assert.equal(body.total, 1, `${id} total must match the filtered page`);
    }
  });

  it("does not fall open on an unknown category", async () => {
    // A filter that silently returns everything is worse than one that returns nothing:
    // the dropdown would look like it worked.
    const body = await get("?category=nonesuch");
    assert.equal(body.jobs.length, 0);
    assert.equal(body.total, 0);
  });
});

describe("GET /api/jobs — search and country scope", () => {
  // Inserted in a before() rather than at module load: the suites above assert
  // on the unfiltered total, and node:test runs suites in declaration order, so
  // adding rows any earlier would break them.
  const geo = (title: string, company: string, location: string): Job => ({
    ...job(title, company),
    id: makeJobId(title, company, location),
    location,
    source: "remoteok",
  });
  const austin = geo("Platform Engineer", "Umbrella", "Austin, TX");
  const london = geo("Platform Engineer", "Cyberdyne", "London, United Kingdom");

  before(() => {
    upsertJobs([austin, london]);
  });

  const ids = (body: { jobs: Array<{ id: string }> }) => body.jobs.map((j) => j.id);

  it("hides foreign postings unless locations=all", async () => {
    const mine = await get("?limit=200");
    assert.ok(ids(mine).includes(austin.id));
    assert.ok(!ids(mine).includes(london.id), "a UK posting is out of the default queue");

    const all = await get("?limit=200&locations=all");
    assert.ok(ids(all).includes(london.id), "locations=all reveals it again");
    assert.equal(all.total, mine.total + 1);
  });

  it("only widens the scope on an exact 'all'", async () => {
    // An absent or misspelled param must not quietly reopen the queue to the
    // world — the default is the narrow one, and anything unrecognised means it.
    for (const qs of ["?limit=200", "?limit=200&locations=", "?limit=200&locations=ALL"]) {
      const body = await get(qs);
      assert.ok(!ids(body).includes(london.id), `${qs} must stay scoped`);
    }
  });

  it("filters by q across title, company and location", async () => {
    const byCompany = await get("?limit=200&q=umbrella");
    assert.deepEqual(ids(byCompany), [austin.id]);

    const byLocation = await get("?limit=200&q=austin");
    assert.deepEqual(ids(byLocation), [austin.id]);

    // The count must track the filter, or the pager offers a page that is not there.
    assert.equal(byCompany.total, 1);
  });

  it("combines q with the country scope rather than overriding it", async () => {
    // "Platform Engineer" matches both rows; only one of them is reachable.
    assert.equal((await get("?limit=200&q=platform+engineer")).total, 1);
    assert.equal((await get("?limit=200&q=platform+engineer&locations=all")).total, 2);
  });

  it("returns nothing for a query that matches nothing", async () => {
    const body = await get("?limit=200&q=zzzznotathing");
    assert.equal(body.total, 0);
    assert.deepEqual(body.jobs, []);
  });
});

describe("GET /api/jobs — maxAgeDays", () => {
  // Two rows differing ONLY in when a source last returned them. A single-row
  // fixture cannot see this class at all: a filter that drops everything and a
  // filter that drops nothing both look correct against one job.
  const seen = (title: string, daysAgo: number): Job => ({
    ...job(title, "Vandelay"),
    id: makeJobId(title, "Vandelay", "Remote"),
    source: "remoteok",
    // upsertJobs binds lastSeenAt to @fetchedAt on INSERT, so this ages the row
    // through the supported path rather than a hand-written UPDATE.
    fetchedAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
  });
  const fresh = seen("Reliability Engineer", 0);
  const stale = seen("Resilience Engineer", 40);

  before(() => {
    upsertJobs([fresh, stale]);
  });

  const ids = (body: { jobs: Array<{ id: string }> }) => body.jobs.map((j) => j.id);

  it("returns both when no age filter is given", async () => {
    // The positive control. Without it, a filter that hid everything would pass
    // the next test for entirely the wrong reason.
    const body = await get("?limit=200&q=vandelay");
    assert.deepEqual(ids(body).sort(), [fresh.id, stale.id].sort());
  });

  it("hides a listing no source has returned lately", async () => {
    const body = await get("?limit=200&q=vandelay&maxAgeDays=7");
    assert.deepEqual(ids(body), [fresh.id]);
    assert.equal(body.total, 1, "the count must track the filter, or the pager lies");
  });

  it("ignores a malformed value rather than 500ing", async () => {
    // Regression: a non-numeric value fell through as NaN into
    // `new Date(Date.now() - NaN * 86_400_000).toISOString()`, which throws
    // RangeError — one bad query string took out the whole queue.
    // A FINITE value is not automatically safe: a Date more than ~1e8 days from
    // the epoch throws the same RangeError, so `1e9` reproduced the original
    // 500 exactly after the first fix — which had rejected the value that was
    // tried rather than the class.
    for (const bad of ["abc", "-5", "NaN", "1e", "1e9", "300000000", "99999999999999999999"]) {
      const body = await get(`?limit=200&q=vandelay&maxAgeDays=${bad}`);
      assert.equal(body.total, 2, `maxAgeDays=${bad} must be ignored, not fatal`);
    }
  });
});
