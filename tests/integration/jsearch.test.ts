import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";
import { fetchJSearch } from "../../lib/sources/jsearch";

// The adapter imports makeJobId from lib/store, which opens a database on first
// use. Point it somewhere disposable so a unit test can never touch the queue.
process.env.JOB_COPILOT_DB = "/tmp/job-copilot-jsearch-test.db";
process.env.OPENWEBNINJA_API_KEY = "test-key";

/**
 * Trimmed from a real OpenWeb Ninja response captured 2026-08-25. The details
 * that matter are structural: jobs live under data.jobs (NOT a bare data array,
 * which is what the RapidAPI version of this endpoint returned), and the
 * city/state/country fields are null on remote listings while job_location
 * carries the only usable value.
 */
const LIVE_SHAPE = {
  status: "OK",
  data: {
    cursor: "abc",
    jobs: [
      {
        job_id: "x".repeat(402),
        job_uid: "kf-oTXxjdLOXvx74AAAAAA==",
        job_title: "Senior DevOps Engineer",
        employer_name: "Entefy",
        job_location: "Anywhere",
        job_city: null,
        job_state: null,
        job_country: null,
        job_is_remote: true,
        job_apply_link: "https://example.com/apply/1",
        job_description: "We are looking for an exceptional DevOps Engineer.",
        job_posted_at_datetime_utc: "2026-07-31T00:00:00.000Z",
        job_employment_type: "Full-time",
        job_min_salary: 120000,
        job_max_salary: 150000,
        job_salary_period: "YEAR",
        job_salary_string: null,
      },
    ],
  },
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stub(handler: (url: string) => { status?: number; body?: unknown; contentType?: string }) {
  globalThis.fetch = (async (input: string | URL) => {
    const { status = 200, body = {}, contentType = "application/json" } = handler(String(input));
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": contentType },
    });
  }) as typeof fetch;
}

describe("jsearch adapter", () => {
  it("reads jobs from data.jobs and maps the live field names", async () => {
    stub(() => ({ body: LIVE_SHAPE }));
    const { jobs } = await fetchJSearch(["devops"], 1);

    assert.equal(jobs.length, 1);
    const j = jobs[0];
    assert.equal(j.title, "Senior DevOps Engineer");
    assert.equal(j.company, "Entefy");
    // job_location, not the city/state/country join — those are null here, and
    // falling back to them is what produced "Unspecified" on every remote row.
    assert.equal(j.location, "Anywhere");
    assert.equal(j.remote, true);
    assert.equal(j.compensation, "$120K – $150K / year");
    assert.equal(j.employmentType, "Full-time");
    // job_uid (24 chars), not the ~400-char job_id blob.
    assert.equal(j.sourceJobId, "kf-oTXxjdLOXvx74AAAAAA==");
  });

  it("prefers job_location when the city fields are ALSO populated", async () => {
    // Not redundant with the test above: there both sources of location were
    // absent, so the fallback order could be reversed without changing the
    // result. Only a row where the two DISAGREE pins the precedence, and an
    // on-site listing is exactly that row.
    stub(() => ({
      body: {
        status: "OK",
        data: {
          jobs: [
            {
              ...LIVE_SHAPE.data.jobs[0],
              job_location: "New York, NY",
              job_city: "Brooklyn",
              job_state: "NY",
              job_country: "US",
              job_is_remote: false,
            },
          ],
        },
      },
    }));
    const { jobs } = await fetchJSearch(["devops"], 1);
    assert.equal(jobs[0].location, "New York, NY");
  });

  it("returns nothing for the old RapidAPI shape instead of throwing", async () => {
    // The endpoint this adapter used to call answered with a bare data[] array.
    // If that shape ever comes back, the run must degrade to zero jobs for this
    // source rather than take down the whole fetch.
    stub(() => ({ body: { status: "OK", data: [{ job_title: "Nope" }] } }));
    const { jobs } = await fetchJSearch(["devops"], 1);
    assert.deepEqual(jobs, []);
  });

  it("NEVER declares a delisting scope, even on a clean fetch", async () => {
    // This is the contract that stops a keyword feed from closing live jobs:
    // a search result page is a moving slice, never an enumeration of anyone's
    // open roles. A non-empty scopes array here would silently close listings.
    stub(() => ({ body: LIVE_SHAPE }));
    const clean = await fetchJSearch(["a", "b"], 1);
    assert.deepEqual(clean.scopes, []);

    stub(() => ({ status: 500 }));
    const failed = await fetchJSearch(["a"], 1);
    assert.deepEqual(failed.scopes, []);
  });

  it("says 'not subscribed' on a 403 rather than blaming the key alone", async () => {
    // The account key is shared across every OpenWeb Ninja API, so a 403 most
    // often means this one API was never activated — sending the reader to
    // regenerate a working key wastes the whole debugging session.
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]) => void warnings.push(a.join(" "));
    try {
      stub(() => ({ status: 403 }));
      const { jobs } = await fetchJSearch(["devops"], 1);
      assert.deepEqual(jobs, []);
    } finally {
      console.warn = realWarn;
    }
    assert.match(warnings.join("\n"), /403/);
    assert.match(warnings.join("\n"), /subscription/i);
  });

  it("keeps the good queries when one fails", async () => {
    const realWarn = console.warn;
    console.warn = () => {};
    try {
      stub((url) => (url.includes("bad") ? { status: 500 } : { body: LIVE_SHAPE }));
      const { jobs } = await fetchJSearch(["bad", "good"], 1);
      assert.equal(jobs.length, 1, "the healthy query's result must survive");
    } finally {
      console.warn = realWarn;
    }
  });

  it("rejects a non-JSON body instead of parsing it as jobs", async () => {
    const realWarn = console.warn;
    console.warn = () => {};
    try {
      stub(() => ({ body: "<html>error</html>", contentType: "text/html" }));
      const { jobs } = await fetchJSearch(["devops"], 1);
      assert.deepEqual(jobs, []);
    } finally {
      console.warn = realWarn;
    }
  });
});
