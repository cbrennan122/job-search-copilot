import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";
import { fetchRemoteOk } from "../../lib/sources/remoteok";
import type { Profile } from "../../lib/profile";

// The adapter imports makeJobId from lib/store, which opens a database on first
// use. Point it somewhere disposable so a unit test can never touch the queue.
process.env.JOB_COPILOT_DB = "/tmp/job-copilot-remoteok-test.db";

const profile = {
  match: {
    titles: ["devops", "site reliability", "software engineer", "sdet"],
    keywords: ["kubernetes", "terraform", "ci/cd", "python"],
    deprioritize: [] as string[],
    countries: ["United States"],
    remote_only: false,
    prefilter_threshold: 25,
  },
} as Profile;

/**
 * Shaped from the live feed. The first element really is a legal notice with no
 * `position`, and the non-technical rows really are what the feed ships: 223 of
 * these were in the queue, and not one scored 70 or better.
 */
const FEED = [
  { legal: "See remoteok.com/terms" },
  {
    id: "1",
    position: "Senior DevOps Engineer",
    company: "Acme",
    location: "Remote",
    tags: ["devops", "aws"],
    description: "<p>Run the platform.</p>",
    date: "2026-08-20",
  },
  {
    id: "2",
    // Title says nothing this profile targets; the TAGS are what save it.
    position: "Backend Developer",
    company: "Globex",
    location: "Remote, US",
    tags: ["python", "kubernetes"],
    description: "Build services.",
  },
  {
    id: "3",
    position: "Fire Fighter",
    company: "City of Managua",
    location: "Managua,",
    tags: ["non tech", "emergency"],
    description: "Respond to fires.",
  },
  {
    id: "4",
    position: "Accounts Receivable Clerk",
    company: "Initech",
    location: "Mangaluru,",
    tags: ["finance", "accounting"],
    description: "Chase invoices.",
  },
  {
    id: "5",
    // Boundary control: "Qatar" must not be read as a hit on a short pattern,
    // and "Sales" is not "sdet". Nothing here is targeted.
    position: "Sales Development Rep",
    company: "Hooli",
    location: "Doha, Qatar",
    tags: ["sales"],
    description: "Book meetings.",
  },
];

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stub(body: unknown, status = 200) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

describe("remoteok adapter", () => {
  it("keeps only postings the profile targets", async () => {
    stub(FEED);
    const { jobs } = await fetchRemoteOk(profile);

    // RemoteOK is a general job board, not a tech one, and it is the only source
    // here with no server-side query narrowing it. Filtering at the adapter is
    // what stops a Fire Fighter posting from costing a row and an LLM call.
    assert.deepEqual(
      jobs.map((j) => j.title),
      ["Senior DevOps Engineer", "Backend Developer"],
    );
  });

  it("matches on tags as well as on the title", async () => {
    // "Backend Developer" contains none of the profile's title patterns —
    // "backend engineer" is the configured one — so this row survives on its
    // tags alone. Drop the tag half of the filter and this goes red.
    stub(FEED);
    const { jobs } = await fetchRemoteOk(profile);
    assert.ok(
      jobs.some((j) => j.title === "Backend Developer"),
      "a tags-only match must still be kept",
    );
  });

  it("keeps nothing when the profile targets nothing in the feed", async () => {
    // The control that proves the filter is doing work rather than letting
    // everything through: same feed, different targeting, zero survivors.
    stub(FEED);
    const other = {
      match: { ...profile.match, titles: ["marine biologist"], keywords: ["plankton"] },
    } as Profile;
    const { jobs } = await fetchRemoteOk(other);
    assert.deepEqual(jobs, []);
  });

  it("still maps the surviving rows correctly", async () => {
    stub(FEED);
    const { jobs } = await fetchRemoteOk(profile);
    const j = jobs[0];
    assert.equal(j.company, "Acme");
    assert.equal(j.source, "remoteok");
    assert.equal(j.remote, true);
    assert.equal(j.location, "Remote");
    // htmlToText, not raw markup.
    assert.equal(j.description, "Run the platform.");
    assert.equal(j.postedAt, "2026-08-20");
  });

  it("NEVER declares a delisting scope", async () => {
    // Unchanged by the filter, and it must stay that way: this is a rolling feed
    // of the newest posts, so a job leaving it means "scrolled off", not
    // "closed". A non-empty scopes array here would close live listings — and
    // now that the adapter drops rows itself, an enumeration claim would be
    // doubly wrong.
    stub(FEED);
    const { scopes } = await fetchRemoteOk(profile);
    assert.deepEqual(scopes, []);
  });

  it("throws on a non-OK response rather than reporting an empty feed", async () => {
    // fetchAllSources wraps each source in Promise.allSettled and records -1 for
    // a rejection. Returning [] instead would look like a successful run that
    // found nothing.
    stub({}, 500);
    await assert.rejects(() => fetchRemoteOk(profile), /HTTP 500/);
  });
});
