import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  categoryOf,
  DEFAULT_CATEGORIES,
  matchesTitle,
  OTHER,
  rankedCategories,
  type RoleCategory,
} from "../../lib/categories";

// Classify against the built-in defaults, never activeCategories(): that reads
// profile/profile.toml, which is gitignored — so it exists on a developer's
// machine and not in CI, and a test leaning on it would assert different things
// in the two places.
const of = (title: string, cats: RoleCategory[] = DEFAULT_CATEGORIES) => categoryOf(title, cats).id;

describe("matchesTitle", () => {
  // The rule this whole module exists to get right. "intern" was a real
  // deprioritize entry and fired on "internal", which 70% of descriptions
  // contain — a silent penalty on nearly every job in the queue.
  it("does not match a single-word pattern inside a longer word", () => {
    assert.equal(matchesTitle("internal tools engineer", "intern"), false);
    assert.equal(matchesTitle("qatar operations lead", "qa"), false);
    assert.equal(matchesTitle("stress test analyst", "sre"), false);
  });

  it("matches a single-word pattern standing alone", () => {
    assert.equal(matchesTitle("qa engineer", "qa"), true);
    assert.equal(matchesTitle("sre, payments", "sre"), true);
    assert.equal(matchesTitle("staff sdet", "sdet"), true);
  });

  // The asymmetry: a multi-word pattern is specific enough that a trailing
  // suffix cannot make it a false hit, and requiring an end boundary would drop
  // every "...Engineering" title on the floor.
  it("lets a multi-word pattern absorb a suffix on its last word", () => {
    assert.equal(matchesTitle("director, software engineering", "software engineer"), true);
    assert.equal(
      matchesTitle("site reliability engineering ii", "site reliability engineer"),
      true,
    );
    assert.equal(matchesTitle("software engineers, core", "software engineer"), true);
  });

  it("treats punctuation as a boundary, not as part of a word", () => {
    assert.equal(matchesTitle("senior staff platform & ci/cd engineer", "ci/cd"), true);
    assert.equal(matchesTitle("(sdet) remote", "sdet"), true);
  });

  it("keeps scanning past a boundary-failed hit instead of giving up", () => {
    // "sdetx" fails the end-boundary check; the real "sdet" comes after it, and
    // an implementation that returned on the first indexOf would miss it.
    assert.equal(matchesTitle("sdetx tooling, sdet", "sdet"), true);
  });
});

describe("categoryOf", () => {
  it("classifies the three families", () => {
    assert.equal(of("Senior Software Engineer, Payments"), "swe");
    assert.equal(of("Staff Backend Engineer"), "swe");
    assert.equal(of("Site Reliability Engineer"), "devops");
    assert.equal(of("Sr. DevOps Engineer (Remote Position)"), "devops");
    assert.equal(of("Senior Test Automation Engineer / SDET (Remote)"), "sdet");
    assert.equal(of("Software Quality Assurance Engineer"), "sdet");
  });

  it("falls back to OTHER rather than guessing", () => {
    assert.equal(of("Forward Deployed Engineer - EMEA"), OTHER.id);
    assert.equal(of("Account Executive"), OTHER.id);
  });

  /**
   * The load-bearing property of DEFAULT_CATEGORIES' array order. A title can
   * satisfy two families at once — "QA Software Engineer" contains both "qa"
   * and "software engineer" — and only the more specific answer is useful.
   *
   * Asserting the reversed array gives the WRONG answer is the point: it proves
   * this test would be red if the ordering were lost, rather than passing
   * because every arrangement happens to work.
   */
  it("resolves an overlapping title by specificity, first match winning", () => {
    assert.equal(of("QA Software Engineer"), "sdet");
    assert.equal(of("Software Engineer in Test"), "sdet");

    const reversed = [...DEFAULT_CATEGORIES].reverse();
    assert.equal(of("QA Software Engineer", reversed), "swe", "reversing the array must break it");
  });
});

describe("preference weights", () => {
  // The stated preference: software engineering first, then DevOps, then
  // SDET/automation, with unclassified roles at the floor.
  it("orders swe > devops > sdet > other", () => {
    const w = (id: string) => DEFAULT_CATEGORIES.find((c) => c.id === id)!.weight;
    assert.ok(w("swe") > w("devops"), "swe outranks devops");
    assert.ok(w("devops") > w("sdet"), "devops outranks sdet");
    assert.ok(w("sdet") > OTHER.weight, "sdet outranks unclassified");
  });

  // Weight is a boost, never a penalty: nothing sorts below where it would have
  // sat on score alone, so no family is suppressed by this feature.
  it("never assigns a negative weight", () => {
    for (const c of [...DEFAULT_CATEGORIES, OTHER]) {
      assert.ok(c.weight >= 0, `${c.id} must not be penalized`);
    }
  });

  it("lists families most-preferred first, with OTHER included", () => {
    const ids = rankedCategories(DEFAULT_CATEGORIES).map((c) => c.id);
    assert.deepEqual(ids, ["swe", "devops", "sdet", "other"]);
  });
});
