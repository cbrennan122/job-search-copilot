// Role families: the "which kind of job is this" axis, kept deliberately
// separate from the fit score's "how well does the résumé match it" axis.
//
// These are two different questions, and one number cannot answer both. A fit
// score says how well you match a posting; it says nothing about which family
// of role you would rather do. Folding preference into the score would destroy
// the first answer in order to express the second — and the score is also what
// `minFit` filters on and what the digest reports, so corrupting it there would
// leak everywhere. Preference therefore lives here, as a `weight` that shifts
// ORDER BY only. The number on a card is still the honest fit.
//
// Nothing is stored: a category is derived from the title on read, so editing
// the patterns below (or in profile.toml) re-classifies the whole queue with no
// migration and no backfill.

// The dependency runs one way — categories -> profile, never back — so this is a
// plain static import with no cycle to work around.
import { matchesTerm } from "./match";
import { loadProfile, MissingProfileError } from "./profile";

/** One role family. `id` is the filter value, `weight` the ranking preference. */
export interface RoleCategory {
  id: string;
  label: string;
  /**
   * Added to the fit score for ranking only. Higher = shown sooner. The gap
   * between two weights is how many points of real fit a lower-preference role
   * must beat a higher-preference one by before it outranks it.
   */
  weight: number;
  /** Title patterns, matched case-insensitively (see `matchesTerm`). */
  patterns: string[];
}

/** Anything unclassified. Weight 0, so it is the floor and nothing is penalized. */
export const OTHER: RoleCategory = { id: "other", label: "Other", weight: 0, patterns: [] };

/**
 * Built-in families, in MATCH order: the first whose pattern hits the title wins.
 *
 * Match order is specificity, NOT preference — preference is `weight`, and the
 * two are independent. SDET is checked first precisely because it is the most
 * specific: "QA Software Engineer" contains "software engineer" too, and would
 * otherwise classify as SWE. Preference order (swe > devops > sdet) falls out of
 * the weights and does not depend on this array's order at all.
 *
 * The gaps are the tuning knob. swe(18) − devops(10) = 8 means a DevOps role
 * must out-fit a software engineering one by more than 8 points to outrank it —
 * a thumb on the scale, not a veto. `other` sits at 0 so unclassified roles are
 * never pushed down, only passed by.
 */
export const DEFAULT_CATEGORIES: RoleCategory[] = [
  {
    id: "sdet",
    label: "SDET / Automation",
    weight: 4,
    patterns: [
      "sdet",
      "software development engineer in test",
      "software engineer in test",
      "engineer in test",
      "qa",
      "quality assurance",
      "quality engineer",
      "test engineer",
      "test automation",
      "automation engineer",
      "test lead",
    ],
  },
  {
    id: "devops",
    label: "DevOps / SRE",
    weight: 10,
    patterns: [
      "devops",
      "dev ops",
      "site reliability",
      "sre",
      "platform engineer",
      "infrastructure engineer",
      "cloud engineer",
      "systems engineer",
      "build engineer",
      "release engineer",
      "observability engineer",
      // Single tokens, because the role word is often not adjacent to the
      // discriminator: "Senior Staff Platform & CI/CD Engineer" classified as
      // Other on real data until these were added, since no multi-word pattern
      // survives the "&". These three are unambiguous infra markers in a TITLE
      // (they would not be in a description).
      "ci/cd",
      "gitops",
      "kubernetes",
    ],
  },
  {
    id: "swe",
    label: "Software Engineer",
    weight: 18,
    patterns: [
      "software engineer",
      "software developer",
      "backend engineer",
      "back end engineer",
      "back-end engineer",
      "frontend engineer",
      "front end engineer",
      "front-end engineer",
      "full stack engineer",
      "fullstack engineer",
      "full-stack engineer",
      "application engineer",
      "product engineer",
      "api engineer",
    ],
  },
];

/**
 * Re-exported so this module still owns the name its callers and tests use. The
 * rule itself lives in lib/match.ts because lib/locations.ts needs the very same
 * boundary semantics — "qa" must miss "Qatar" and "us" must miss "usa".
 */
export const matchesTitle = matchesTerm;

/** Classify a job title. First matching family wins; unmatched titles are OTHER. */
export function categoryOf(title: string, cats: RoleCategory[] = activeCategories()): RoleCategory {
  const t = title.toLowerCase();
  for (const c of cats) {
    if (c.patterns.some((p) => matchesTitle(t, p))) return c;
  }
  return OTHER;
}

/** Families plus OTHER, most-preferred first — the order the UI lists them in. */
export function rankedCategories(cats: RoleCategory[] = activeCategories()): RoleCategory[] {
  return [...cats, OTHER].sort((a, b) => b.weight - a.weight);
}

let cached: RoleCategory[] | null = null;

/**
 * The categories in force: profile.toml's `[[match.categories]]` if it defines
 * any, otherwise DEFAULT_CATEGORIES.
 *
 * Falls back ONLY when profile.toml is absent — the fresh-clone and CI case,
 * where the file is gitignored. A malformed profile.toml still throws, because
 * silently ignoring a config someone actually wrote is how a targeting change
 * appears to do nothing.
 *
 * Cached for the life of the process: this is called once per row from the
 * `job_category` SQL function. Editing profile.toml needs a restart of `npm run
 * dev` to take effect.
 */
export function activeCategories(): RoleCategory[] {
  if (cached) return cached;
  let resolved: RoleCategory[];
  try {
    const configured = loadProfile().match.categories;
    resolved = configured && configured.length ? configured : DEFAULT_CATEGORIES;
  } catch (err) {
    if (!(err instanceof MissingProfileError)) throw err;
    resolved = DEFAULT_CATEGORIES;
  }
  cached = resolved;
  return resolved;
}

/** Test seam: drop the cached read of profile.toml. */
export function resetCategoryCache(): void {
  cached = null;
}
