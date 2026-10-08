import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import * as store from "../../lib/store";
import { APPLICATION_STATUSES, TERMINAL_STATUSES } from "../../lib/types";
import type { Job } from "../../lib/types";

// Point the store at a throwaway file before any store call — lib/store resolves
// JOB_COPILOT_DB lazily, on the first connection, so what matters is that this
// runs before a test touches the DB, not before the import.
const DB = path.join(tmpdir(), `job-copilot-test-${randomUUID()}.db`);
process.env.JOB_COPILOT_DB = DB;

// Point the profile loader at a directory that does not exist, so the category
// classifier falls back to its built-in defaults. profile/profile.toml is
// gitignored: it exists on a developer's machine and not in CI, so without this
// the ranking assertions below would be testing whatever targeting the developer
// happens to have configured — passing here and failing there, or worse.
process.env.JOB_COPILOT_PROFILE_DIR = path.join(tmpdir(), `job-copilot-no-profile-${randomUUID()}`);

const {
  countJobs,
  listJobs,
  makeJobId,
  markDelisted,
  pruneClosed,
  scopeKey,
  updateApplication,
  upsertJobs,
} = store;

const daysAgoIso = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${DB}${suffix}`, { force: true });
  }
});

function job(over: Partial<Job> & { title: string; company: string }): Job {
  const location = over.location ?? "Remote";
  return {
    source: "greenhouse",
    sourceJobId: "x",
    remote: true,
    description: "d",
    url: "https://example.com",
    postedAt: null,
    fetchedAt: new Date().toISOString(),
    compensation: null,
    employmentType: null,
    department: null,
    ...over,
    location,
    id: makeJobId(over.title, over.company, location),
  };
}

describe("makeJobId", () => {
  it("is stable for the same role", () => {
    assert.equal(makeJobId("SRE", "Acme", "Remote"), makeJobId("SRE", "Acme", "Remote"));
  });

  it("normalizes case and whitespace so sources collapse", () => {
    assert.equal(makeJobId("SRE", "Acme", "Remote"), makeJobId("  sre ", "ACME", "remote"));
  });

  it("separates different roles", () => {
    assert.notEqual(makeJobId("SRE", "Acme", "Remote"), makeJobId("SWE", "Acme", "Remote"));
    assert.notEqual(makeJobId("SRE", "Acme", "Remote"), makeJobId("SRE", "Other", "Remote"));
  });
});

describe("upsertJobs", () => {
  it("counts inserts and updates separately, and refreshes content", () => {
    const a = job({ title: "Upsert Role", company: "UpCo", description: "first" });
    assert.deepEqual(upsertJobs([a]), { inserted: 1, updated: 0 });

    const b = { ...a, description: "second", url: "https://new.example" };
    assert.deepEqual(upsertJobs([b]), { inserted: 0, updated: 1 });

    const got = store.getJob(a.id);
    assert.equal(got?.description, "second", "description refreshed, not left stale");
    assert.equal(got?.url, "https://new.example");
  });
});

describe("markDelisted", () => {
  it("closes only jobs inside an enumerated scope", () => {
    const kept = job({ title: "Kept", company: "ScopeCo" });
    const gone = job({ title: "Gone", company: "ScopeCo" });
    // Same board, but this run did not enumerate OtherCo.
    const other = job({ title: "Other", company: "OtherCo" });
    upsertJobs([kept, gone, other]);

    const closed = markDelisted([scopeKey("greenhouse", "ScopeCo")], [kept.id, other.id]);

    assert.equal(closed, 1);
    assert.equal(store.getJob(gone.id) && store.getJobWithMeta(gone.id)?.closedAt !== null, true);
    assert.equal(store.getJobWithMeta(kept.id)?.closedAt, null);
    assert.equal(
      store.getJobWithMeta(other.id)?.closedAt,
      null,
      "a company this run never enumerated must not be closed",
    );
  });

  it("closes nothing when no scopes are declared", () => {
    // The safety property for feed sources (RemoteOK, JSearch, Adzuna, USAJobs):
    // a failed fetch returns no scopes, so one transient 500 cannot wipe a board.
    const feed = job({ title: "Feed Role", company: "FeedCo", source: "remoteok" });
    upsertJobs([feed]);
    assert.equal(markDelisted([], []), 0);
    assert.equal(store.getJobWithMeta(feed.id)?.closedAt, null);
  });

  it("reopens a job that comes back", () => {
    const j = job({ title: "Flaky", company: "BackCo" });
    upsertJobs([j]);
    markDelisted([scopeKey("greenhouse", "BackCo")], []);
    assert.notEqual(store.getJobWithMeta(j.id)?.closedAt, null);

    upsertJobs([{ ...j, fetchedAt: new Date().toISOString() }]);
    assert.equal(store.getJobWithMeta(j.id)?.closedAt, null, "re-listing clears closedAt");
  });
});

describe("pruneClosed", () => {
  it("keeps closed jobs you actually applied to", () => {
    const applied = job({ title: "Applied", company: "PruneCo" });
    const ignored = job({ title: "Ignored", company: "PruneCo" });
    upsertJobs([applied, ignored]);
    updateApplication(applied.id, { status: "applied" });
    markDelisted([scopeKey("greenhouse", "PruneCo")], []);

    // Backdate both closures so they are eligible for pruning.
    store
      .db()
      .prepare(
        `UPDATE jobs SET closedAt = '2000-01-01T00:00:00.000Z'
                        WHERE id IN (?, ?)`,
      )
      .run(applied.id, ignored.id);

    const pruned = pruneClosed(30);
    assert.equal(pruned, 1);
    assert.ok(store.getJob(applied.id), "applied job survives pruning");
    assert.equal(store.getJob(ignored.id), null);
  });
});

describe("updateApplication", () => {
  it("stamps appliedAt once, on first submitted status", () => {
    const j = job({ title: "Stamp", company: "StampCo" });
    upsertJobs([j]);

    assert.equal(updateApplication(j.id, { status: "new" }).appliedAt, null);
    const first = updateApplication(j.id, { status: "applied" });
    assert.ok(first.appliedAt, "appliedAt set when status becomes applied");

    const later = updateApplication(j.id, { status: "onsite" });
    assert.equal(later.appliedAt, first.appliedAt, "appliedAt is not re-stamped");
  });

  it("patches fields without clobbering the others", () => {
    const j = job({ title: "Patch", company: "PatchCo" });
    upsertJobs([j]);
    updateApplication(j.id, { notes: "spoke to recruiter", contact: "sam@example.com" });
    const after = updateApplication(j.id, { status: "screen" });
    assert.equal(after.notes, "spoke to recruiter");
    assert.equal(after.contact, "sam@example.com");
  });
});

describe("dueFollowUps", () => {
  // The exclusion list used to be spelled out as SQL literals inside the query,
  // a copy of a list that has already grown once. Drive the test off the shared
  // constant instead of restating it: adding a status to TERMINAL_STATUSES now
  // fails here until dueFollowUps honours it, which is the whole point of
  // hoisting it out of the SQL.
  it("chases every non-terminal status and no terminal one", () => {
    const yesterday = daysAgoIso(1);
    const ids = new Map<string, string>();
    for (const status of APPLICATION_STATUSES) {
      const j = job({ title: `Follow ${status}`, company: "ChaseCo" });
      upsertJobs([j]);
      updateApplication(j.id, { status, followUpAt: yesterday });
      ids.set(status, j.id);
    }

    const due = new Set(store.dueFollowUps().map((a) => a.jobId));
    assert.ok(TERMINAL_STATUSES.length > 0, "the constant is not empty");
    for (const status of APPLICATION_STATUSES) {
      const terminal = TERMINAL_STATUSES.includes(status);
      assert.equal(
        due.has(ids.get(status)!),
        !terminal,
        `${status} should ${terminal ? "not " : ""}be chased`,
      );
    }
  });

  it("leaves a follow-up that is not due yet alone", () => {
    const j = job({ title: "Later", company: "ChaseCo" });
    upsertJobs([j]);
    updateApplication(j.id, { status: "applied", followUpAt: daysAgoIso(-7) });
    assert.ok(
      !store.dueFollowUps().some((a) => a.jobId === j.id),
      "a future followUpAt is not due",
    );
  });
});

describe("listJobs date filters", () => {
  // fetchedAt = first seen, lastSeenAt = last refreshed. The digest leans on the
  // difference, so pin it down: an old listing refreshed today is NOT new.
  it("firstSeenDays keys off first sighting, not the latest refresh", () => {
    const old = job({
      title: "Longstanding",
      company: "DateCo",
      fetchedAt: daysAgoIso(40),
    });
    const recent = job({
      title: "Justposted",
      company: "DateCo",
      fetchedAt: daysAgoIso(1),
    });
    upsertJobs([old, recent]);
    // Re-seeing the old one advances lastSeenAt but must leave fetchedAt alone.
    upsertJobs([{ ...old, fetchedAt: new Date().toISOString() }]);

    const fresh = listJobs({ firstSeenDays: 7 }).map((j) => j.id);
    assert.ok(fresh.includes(recent.id), "recent listing is new");
    assert.ok(!fresh.includes(old.id), "refreshed old listing is not new");
    assert.equal(countJobs({ firstSeenDays: 7 }), fresh.length);
  });

  it("maxAgeDays keys off the latest refresh, not first sighting", () => {
    const stale = job({
      title: "Stalefeed",
      company: "AgeCo",
      fetchedAt: daysAgoIso(30),
    });
    upsertJobs([stale]);

    // Not re-seen since, so lastSeenAt is still 30 days back.
    const live = listJobs({ maxAgeDays: 7 }).map((j) => j.id);
    assert.ok(!live.includes(stale.id), "unrefreshed listing falls out of maxAgeDays");
    assert.ok(
      listJobs({ maxAgeDays: 60 })
        .map((j) => j.id)
        .includes(stale.id),
      "a wider window still finds it",
    );
  });
});

describe("unscoredJobs retry policy", () => {
  // A failed LLM call still writes a row (so the job stays visible), which used
  // to mean it was never scored again — one outage mislabelled a job forever.
  it("retries fallback scores but not genuine below-threshold verdicts", () => {
    const failed = job({ title: "Retryme", company: "ScoreCo" });
    const skipped = job({ title: "Belowbar", company: "ScoreCo" });
    const real = job({ title: "Properly", company: "ScoreCo" });
    upsertJobs([failed, skipped, real]);

    const at = new Date().toISOString();
    store.saveFitScore({
      jobId: failed.id,
      score: 40,
      reason: "LLM scoring failed; prefilter score shown.",
      model: store.FALLBACK_MODEL,
      scoredAt: at,
    });
    store.saveFitScore({
      jobId: skipped.id,
      score: 5,
      reason: "Below keyword prefilter threshold.",
      model: "prefilter",
      scoredAt: at,
    });
    store.saveFitScore({
      jobId: real.id,
      score: 80,
      reason: "Strong match.",
      model: "claude-haiku-4-5",
      scoredAt: at,
    });

    const queue = store.unscoredJobs().map((j) => j.id);
    assert.ok(queue.includes(failed.id), "fallback score is retried");
    assert.ok(!queue.includes(skipped.id), "deliberate prefilter skip is final");
    assert.ok(!queue.includes(real.id), "a real LLM score is final");
  });

  it("counts only open fallback scores, so a hollow run is visible", () => {
    // These three already exist from the test above: one fallback, one genuine
    // prefilter skip, one real LLM score.
    const before = store.countFallbackScores();
    assert.equal(before, 1, "a genuine prefilter verdict must not be counted");

    const closedFallback = job({ title: "Goneaway", company: "ScoreCo" });
    upsertJobs([closedFallback]);
    store.saveFitScore({
      jobId: closedFallback.id,
      score: 40,
      reason: "LLM scoring failed; prefilter score shown.",
      model: store.FALLBACK_MODEL,
      scoredAt: new Date().toISOString(),
    });
    assert.equal(store.countFallbackScores(), 2);

    // Closing it drops it from the count — you cannot re-score a dead listing,
    // so it is not outstanding work.
    markDelisted([scopeKey("greenhouse", "ScoreCo")], []);
    assert.equal(store.countFallbackScores(), 0, "closed jobs are excluded");
  });
});

describe("role-family ranking", () => {
  // Scoped to source "ashby", which no other test in this file uses, so the
  // assertions see only these four rows.
  const scored = (title: string, score: number) => {
    const j = job({ title, company: "RankCo", source: "ashby" });
    upsertJobs([j]);
    store.saveFitScore({
      jobId: j.id,
      score,
      reason: "fixture",
      model: "claude-haiku-4-5",
      scoredAt: new Date().toISOString(),
    });
    return j;
  };

  /**
   * The whole point of the feature: a preferred family outranks a better raw
   * score, by a bounded amount.
   *
   * Both orders are asserted. Checking only the final order would pass just as
   * well if the weights were all zero and the rows happened to come back in
   * insertion order — so the test first pins down that score order alone says
   * the opposite, which is what makes the second assertion evidence.
   */
  it("lets preference outrank a higher score, within the weight gap", () => {
    const swe = scored("Senior Software Engineer, Payments", 75);
    const devops = scored("Senior DevOps Engineer", 80);

    const byScore = [swe, devops].sort((a, b) => (a === swe ? 75 : 80) - (b === swe ? 75 : 80));
    assert.equal(byScore[1].id, devops.id, "on raw score alone, devops is ahead");

    const ranked = listJobs({ source: "ashby" }).map((j) => j.id);
    assert.deepEqual(
      ranked,
      [swe.id, devops.id],
      "swe(75)+18 = 93 beats devops(80)+10 = 90, so the preferred family surfaces first",
    );
  });

  it("does not let preference overturn a large score gap", () => {
    // 8 points is the swe/devops weight gap; a 20-point deficit must still lose,
    // or the feature would have stopped being a tie-break and become a veto.
    const weak = scored("Software Engineer, Internal Tools", 55);
    const strong = scored("Staff Site Reliability Engineer", 90);
    const ranked = listJobs({ source: "ashby" }).map((j) => j.id);
    assert.ok(
      ranked.indexOf(strong.id) < ranked.indexOf(weak.id),
      "a 35-point better fit outranks an 8-point preference edge",
    );
  });

  it("keeps an unscored job below a real low score", () => {
    // -1 must NOT become -1 + weight, or a never-scored job in a preferred
    // family would leapfrog a job the scorer actually judged badly.
    const unscoredSwe = job({
      title: "Backend Engineer, Unrated",
      company: "RankCo",
      source: "lever",
    });
    upsertJobs([unscoredSwe]);
    const lowOther = job({ title: "Account Executive", company: "RankCo", source: "lever" });
    upsertJobs([lowOther]);
    store.saveFitScore({
      jobId: lowOther.id,
      score: 3,
      reason: "fixture",
      model: "claude-haiku-4-5",
      scoredAt: new Date().toISOString(),
    });

    const ranked = listJobs({ source: "lever" }).map((j) => j.id);
    assert.deepEqual(ranked, [lowOther.id, unscoredSwe.id]);
  });

  it("filters to one family, and counts what it filtered", () => {
    const only = listJobs({ source: "ashby", category: "devops" });
    assert.ok(only.length > 0, "the fixture has devops rows to find");
    assert.ok(
      only.every((j) => j.category === "devops"),
      "every row returned is in the requested family",
    );
    assert.equal(countJobs({ source: "ashby", category: "devops" }), only.length);

    // A filter that excludes everything must return nothing, not fall open.
    assert.equal(listJobs({ source: "ashby", category: "sdet" }).length, 0);
  });

  it("labels each row with its family for the UI", () => {
    const byTitle = new Map(listJobs({ source: "ashby" }).map((j) => [j.title, j.category]));
    assert.equal(byTitle.get("Senior Software Engineer, Payments"), "swe");
    assert.equal(byTitle.get("Senior DevOps Engineer"), "devops");
  });
});

describe("country filtering and ranking", () => {
  // Scoped to source "remoteok", which no other test in this file uses — and
  // which is deliberately NOT one of the country-scoped feeds in SOURCE_SCOPE,
  // so an unplaceable location string here really is unplaceable. (A "Hybrid"
  // row from jsearch resolves to the US instead; that path is asserted below.)
  // JOB_COPILOT_PROFILE_DIR points at nothing above, so the countries in force
  // are the built-in default: the United States.
  const at = (title: string, location: string, score: number) => {
    const j = job({ title, company: "GeoCo", location, source: "remoteok" });
    upsertJobs([j]);
    store.saveFitScore({
      jobId: j.id,
      score,
      reason: "fixture",
      model: "claude-haiku-4-5",
      scoredAt: new Date().toISOString(),
    });
    return j;
  };

  const domestic = at("Platform Engineer, Austin", "Austin, TX", 80);
  const foreign = at("Platform Engineer, London", "London, United Kingdom", 80);
  const unplaceable = at("Platform Engineer, Hybrid", "Hybrid", 80);

  it("hides foreign postings by default and shows them on request", () => {
    const mine = listJobs({ source: "remoteok" }).map((j) => j.id);
    assert.ok(mine.includes(domestic.id));
    assert.ok(!mine.includes(foreign.id), "a UK posting is out of the default queue");
    assert.equal(countJobs({ source: "remoteok" }), mine.length);

    // Nothing was deleted — widening the filter brings it straight back.
    const all = listJobs({ source: "remoteok", locations: "all" }).map((j) => j.id);
    assert.ok(all.includes(foreign.id), "locations:'all' reveals it again");
    assert.equal(countJobs({ source: "remoteok", locations: "all" }), all.length);
    assert.ok(all.length > mine.length);
  });

  it("never hides a posting it could not place", () => {
    // "Hybrid" is 197 real rows, overwhelmingly domestic employers with a sloppy
    // field. A wrong "foreign" hides a job you could have taken.
    assert.ok(listJobs({ source: "remoteok" }).some((j) => j.id === unplaceable.id));
  });

  it("resolves a country-scoped feed's blank location by its source", () => {
    // The regression that matters most: lib/sources/jsearch.ts hardcodes
    // country=us and 66 real rows come back saying only "Anywhere". They are 41
    // of the 66 jobs scoring >= 70 in the whole queue, so classifying them as
    // unplaceable — let alone foreign — would bury the best of it. Asserted
    // through listJobs rather than countryOf() alone, because it is the SQL
    // function registration that has to pass the source through.
    const anywhere = job({
      title: "Senior DevOps Engineer, Anywhere",
      company: "GeoCo",
      location: "Anywhere",
      source: "jsearch",
    });
    upsertJobs([anywhere]);
    assert.ok(
      listJobs({ source: "jsearch" }).some((j) => j.id === anywhere.id),
      "a jsearch 'Anywhere' row stays in the default queue",
    );
  });

  it("ranks a reachable posting above an unplaceable one at equal fit", () => {
    // Same score, same role family, so the location weight is the only thing
    // separating them — allowed(20) over unknown(8).
    const ranked = listJobs({ source: "remoteok", locations: "all" }).map((j) => j.id);
    assert.ok(
      ranked.indexOf(domestic.id) < ranked.indexOf(unplaceable.id),
      "allowed outranks unknown",
    );
    assert.ok(
      ranked.indexOf(unplaceable.id) < ranked.indexOf(foreign.id),
      "unknown outranks foreign",
    );
  });
});

describe("search", () => {
  // Scoped to source "adzuna", unused elsewhere in this file.
  const rows = [
    job({
      title: "Reliability Engineer",
      company: "Northwind",
      location: "Boston",
      source: "adzuna",
    }),
    job({ title: "Data Engineer", company: "Contoso", location: "Denver", source: "adzuna" }),
    job({ title: "Support Lead", company: "Northwind", location: "Denver", source: "adzuna" }),
  ];
  upsertJobs(rows);
  const titles = (q: string) =>
    listJobs({ source: "adzuna", q })
      .map((j) => j.title)
      .sort();

  it("matches title, company and location", () => {
    assert.deepEqual(titles("reliability"), ["Reliability Engineer"]);
    assert.deepEqual(titles("northwind"), ["Reliability Engineer", "Support Lead"]);
    assert.deepEqual(titles("denver"), ["Data Engineer", "Support Lead"]);
  });

  it("is case-insensitive and matches mid-word", () => {
    assert.deepEqual(titles("NORTHWIND"), ["Reliability Engineer", "Support Lead"]);
    assert.deepEqual(titles("ngineer"), ["Data Engineer", "Reliability Engineer"]);
  });

  it("counts the same rows it lists", () => {
    assert.equal(countJobs({ source: "adzuna", q: "northwind" }), 2);
    assert.equal(countJobs({ source: "adzuna", q: "nothing here" }), 0);
  });

  it("treats LIKE metacharacters as literal text", () => {
    // Unescaped, "%" is LIKE's match-everything wildcard and "_" matches any
    // single character — so typing either into the search box would silently
    // return the whole queue instead of nothing.
    assert.equal(listJobs({ source: "adzuna", q: "%" }).length, 0);
    assert.equal(listJobs({ source: "adzuna", q: "_upport" }).length, 0);
    assert.equal(listJobs({ source: "adzuna", q: "Support" }).length, 1);
  });

  it("ignores a blank or whitespace-only query", () => {
    assert.equal(listJobs({ source: "adzuna", q: "   " }).length, rows.length);
    assert.equal(listJobs({ source: "adzuna" }).length, rows.length);
  });
});
