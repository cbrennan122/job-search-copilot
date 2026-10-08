import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

// No profile.toml here, so activeCountries() falls back to DEFAULT_COUNTRIES
// (United States). profile/ is gitignored — absent in CI, present locally — and
// without this every assertion below would depend on whatever countries the
// developer happens to have configured.
const NO_PROFILE = path.join(tmpdir(), `job-copilot-no-profile-${randomUUID()}`);
process.env.JOB_COPILOT_PROFILE_DIR = NO_PROFILE;

import {
  countryOf,
  locationBucket,
  locationWeight,
  LOCATION_WEIGHTS,
  resetCountryCache,
  UNKNOWN,
} from "../../lib/locations";

describe("countryOf, targeting the United States", () => {
  it("takes any allowed segment of a multi-location string", () => {
    // 208 rows in the real queue are semicolon-joined like this. A US job is a
    // US job even when it is also offered in four other countries — so the
    // check is any-allowed-wins, not first-segment-wins.
    assert.equal(countryOf("Remote, Canada; Remote, United Kingdom; Remote, US"), "us");
    assert.equal(
      countryOf(
        "Bangalore, India; Remote, Canada; Remote, Israel; " +
          "Remote, United Kingdom; Remote, United States",
      ),
      "us",
    );
    assert.equal(countryOf("US Remote,Toronto, CA-Remote-Ontario"), "us");
  });

  it("classifies an all-foreign multi-location string as foreign", () => {
    // The negative half of the test above: if the any-match rule were broken
    // into an always-return-the-first-country rule, this would still pass, so
    // the two assertions only mean something together.
    assert.equal(
      locationBucket("Amsterdam, The Netherlands; Dublin, Ireland; Paris, France"),
      "foreign",
    );
    assert.equal(locationBucket("Ireland / United Kingdom"), "foreign");
    assert.equal(locationBucket("CA-Toronto, CA-Montreal, CA-Vancouver"), "foreign");
  });

  it("does not confuse the United Kingdom with the United States", () => {
    assert.equal(countryOf("United States"), "us");
    assert.equal(countryOf("United Kingdom"), "gb");
    assert.equal(locationBucket("United Kingdom, Remote"), "foreign");
    assert.equal(locationBucket("Remote, United States"), "allowed");
  });

  it("puts Northern Ireland in the UK rather than Ireland", () => {
    // "ireland" matches inside "Northern Ireland" as a whole term, so the only
    // thing keeping this right is that the UK entry precedes Ireland in the
    // table. Reordering COUNTRIES turns this red.
    assert.equal(countryOf("Northern Ireland,"), "gb");
    assert.equal(countryOf("Dublin, Ireland"), "ie");
  });

  it("matches on term boundaries, not bare substrings", () => {
    // Each of these is a live pattern reaching into a word it must not claim.
    // A plain indexOf matcher makes every one of them wrong, which is the point:
    // these go red the moment matchesTerm loses its boundary rule.
    assert.notEqual(countryOf("Belarus, Remote"), "us"); //  "us" inside "Belarus"
    assert.equal(countryOf("Chile, Remote"), "cl"); //       "chi" inside "Chile"
    assert.equal(countryOf("Torino, Torino, Piemonte, Italia"), "it"); // "tor" inside "Torino"
    assert.equal(countryOf("Swansea,"), UNKNOWN); //         "sea" inside "Swansea"
    assert.equal(countryOf("Qatar"), "qa"); //               not the SDET "qa" pattern's problem

    // Positive controls for the very same patterns — without these, a matcher
    // that simply never matched anything would pass the block above.
    assert.equal(countryOf("Remote, US"), "us");
    assert.equal(countryOf("CHI, SEA, NYC, SF"), "us");
    assert.equal(countryOf("TOR"), "ca");
  });

  it("resolves a country-scoped feed's uninformative location by its source", () => {
    // lib/sources/jsearch.ts hardcodes country=us, and 66 rows come back saying
    // only "Anywhere". They are 41 of the 66 jobs scoring >= 70 in the queue.
    assert.equal(countryOf("Anywhere", "jsearch"), "us");
    assert.equal(locationBucket("Anywhere", "jsearch"), "allowed");

    // The same string from a company board says nothing about the country.
    assert.equal(countryOf("Anywhere", "greenhouse"), UNKNOWN);
    assert.equal(countryOf("Anywhere"), UNKNOWN);
  });

  it("lets a real location beat the source scope", () => {
    // Scope is step 3, not step 1: an aggregator that mostly returns US jobs
    // still returns the occasional foreign one, and it says so.
    assert.equal(countryOf("London, United Kingdom", "jsearch"), "gb");
    assert.equal(locationBucket("London, United Kingdom", "jsearch"), "foreign");
  });

  it("calls an unplaceable string unknown, never foreign", () => {
    // 299 greenhouse rows say one of these. They are overwhelmingly domestic
    // employers with a sloppy field, and guessing "foreign" would hide them.
    for (const s of ["Hybrid", "Distributed", "In-Office", "N/A", "n/a", "na", "LOCATION"]) {
      assert.equal(countryOf(s, "greenhouse"), UNKNOWN, s);
      assert.equal(locationBucket(s, "greenhouse"), "unknown", s);
    }
  });

  it("ranks allowed above unknown above foreign, and never below zero", () => {
    const allowed = locationWeight("San Francisco, CA");
    const unknown = locationWeight("Hybrid", "greenhouse");
    const foreign = locationWeight("Bengaluru, India");
    assert.ok(allowed > unknown, `${allowed} should beat ${unknown}`);
    assert.ok(unknown > foreign, `${unknown} should beat ${foreign}`);
    assert.ok(foreign >= 0, "a weight is added to a score, so it must not go negative");
    assert.equal(allowed, LOCATION_WEIGHTS.allowed);
  });
});

describe("re-targeting", () => {
  const dir = path.join(tmpdir(), `job-copilot-profile-${randomUUID()}`);

  after(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env.JOB_COPILOT_PROFILE_DIR = NO_PROFILE;
    resetCountryCache();
  });

  function retarget(toml: string) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "profile.toml"), toml);
    process.env.JOB_COPILOT_PROFILE_DIR = dir;
    resetCountryCache();
  }

  it("flips buckets when profile.toml names different countries", () => {
    // Nothing is stored, so widening the targeting re-classifies the whole queue
    // with no migration — and the memo inside countryOf must not outlive the
    // change, or the first answer for each string would be the stale one.
    assert.equal(locationBucket("London, United Kingdom"), "foreign");

    retarget('[match]\ncountries = ["United Kingdom"]\n');
    assert.equal(locationBucket("London, United Kingdom"), "allowed");
    assert.equal(locationBucket("Austin, TX"), "foreign");

    // The case that separates any-ALLOWED-wins from plain first-match-wins: a
    // job offered in both countries is one you can take, but the US entry comes
    // first in COUNTRIES, so a matcher that just returned the first hit would
    // call this a US job — now foreign — and drop it out of the queue.
    assert.equal(countryOf("Remote, US; Remote, United Kingdom"), "gb");
    assert.equal(locationBucket("Remote, US; Remote, United Kingdom"), "allowed");

    retarget('[match]\ncountries = ["United States", "gb"]\n');
    assert.equal(locationBucket("London, United Kingdom"), "allowed");
    assert.equal(locationBucket("Austin, TX"), "allowed");
    assert.equal(locationBucket("Bengaluru, India"), "foreign");
  });

  it("rejects a country name it does not recognise", () => {
    // Silently dropping a country someone actually wrote is how a targeting
    // change appears to do nothing at all.
    retarget('[match]\ncountries = ["Atlantis"]\n');
    assert.throws(() => locationBucket("Austin, TX"), /Atlantis/);
  });

  it("requires countries to be present at all", () => {
    // The "no anywhere option" rule, made structural: a profile that does not
    // name its countries fails to parse rather than defaulting to the world.
    retarget('[match]\ntitles = ["devops"]\n');
    assert.throws(() => locationBucket("Austin, TX"), /countries/);
  });
});
