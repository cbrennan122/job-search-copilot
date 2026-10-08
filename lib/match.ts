// The one term-matching rule, shared by every classifier that looks for a
// pattern inside a free-text field (role families in lib/categories.ts,
// countries in lib/locations.ts).
//
// It lives on its own because reimplementing it is exactly how the
// "intern"/"internal" bug happened: a second, subtly different matcher is worse
// than no second matcher at all.

const ALNUM = /[a-z0-9]/;

/**
 * Does `pattern` occur in `text` as a real term rather than as a fragment of a
 * longer word?
 *
 * Substring matching is what put "intern" in `deprioritize` and silently docked
 * every job whose description said "internal" — 70% of them. So the pattern
 * must start on a non-alphanumeric boundary (not `\b`, which is defined on
 * [A-Za-z0-9_] and misplaces the edge on "ci/cd" and "node.js").
 *
 * The END boundary is required only for SINGLE-word patterns, and that
 * asymmetry is deliberate: it is what keeps "qa" off "Qatar" while still
 * letting "site reliability engineer" match "Site Reliability Engineering" and
 * "software engineer" match "Software Engineers". A multi-word pattern is
 * already specific enough that a trailing suffix cannot make it a false hit.
 *
 * `text` must already be lowercased; `pattern` is lowercased here.
 */
export function matchesTerm(text: string, pattern: string): boolean {
  const p = pattern.toLowerCase().trim();
  if (!p) return false;
  const multiWord = /\s/.test(p);
  for (let from = 0; ; from++) {
    const i = text.indexOf(p, from);
    if (i === -1) return false;
    const end = i + p.length;
    const startOk = i === 0 || !ALNUM.test(text[i - 1]);
    const endOk = multiWord || end === text.length || !ALNUM.test(text[end]);
    if (startOk && endOk) return true;
    from = i;
  }
}
