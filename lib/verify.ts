// Deterministic anti-fabrication check for a tailored résumé.
//
// Tailoring is allowed to re-emphasize, reorder, and reword the master résumé.
// It is NOT allowed to invent an employer, a date, or a metric — that is the one
// guardrail in lib/tailor.ts's system prompt, and a prompt is not a guarantee.
// This verifies the output instead of trusting it, with no LLM call and no
// network, so it can gate every generated document.
//
// It reports *unsupported* claims, not "lies": a flagged item means "this hard
// fact is not in your master résumé, go look at it", which is exactly the review
// step you would otherwise have to do by eye.
//
// Skills are checked for the same reason employers are, and they are the most
// likely thing to be invented: the job description names the tool, the model is
// trying to match the job description, and one more comma-separated entry on a
// skills line looks like nothing. Against this résumé and queue, Grafana and
// Prometheus were the two most-demanded tools NOT on the master résumé — exactly
// the pair a tailoring model has the most reason to add.

export type ClaimKind = "employer" | "date" | "metric" | "skill";

export interface Claim {
  kind: ClaimKind;
  value: string;
  /** The line it came from, for eyeballing the context. */
  context: string;
}

export interface VerifyReport {
  ok: boolean;
  unsupported: Claim[];
  checked: number;
}

/** Compare on a shape that survives reformatting: case, spacing, punctuation. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‐-―]/g, "-") // en/em dashes -> hyphen
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9%$.+/-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const YEAR = /\b(?:19|20)\d{2}\b/g;
// 55%, 1.8s, 240ms, 40M, 6+, 4.5x — the shapes a résumé metric actually takes.
const METRIC = /\b\d+(?:\.\d+)?\s*(?:%|x\b|[KMB]\b|ms\b|s\b|m\b|h\b|\+)/gi;

/** Headings and bold lines are where employer and role names live. */
function employers(md: string): Claim[] {
  const out: Claim[] = [];
  for (const line of md.split("\n")) {
    const heading = line.match(/^#{2,4}\s+(.+?)\s*$/);
    if (heading) {
      // "### Northwind Systems – Austin, TX / Remote" -> the org, not the city.
      const org = heading[1].split(/[–—|]|\s-\s/)[0].trim();
      if (org && !/^(summary|skills|experience|education|projects)/i.test(org))
        out.push({ kind: "employer", value: org, context: line.trim() });
    }
  }
  return out;
}

/**
 * Split a skills line's value on commas that are NOT inside parentheses, so
 * "Kubernetes (EKS, GKE), Terraform" is two entries rather than three.
 */
function splitTopLevel(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * Tool/skill claims from skills lines — "**CI/CD & Cloud:** Docker, Terraform".
 * A name and its parenthetical gloss are checked separately: in "Flux (GitOps)"
 * the tool is real and only the label is new, and saying so beats flagging the
 * whole entry as though Flux were invented.
 */
function skills(md: string): Claim[] {
  const out: Claim[] = [];
  for (const line of md.split("\n")) {
    // Column 0 only: a bullet that happens to contain "**Note:** ..." is prose,
    // and splitting a sentence on its commas would flag every clause.
    const m = line.match(/^\*\*([^*]+):\*\*\s*(.+?)\s*$/);
    if (!m) continue;
    for (const entry of splitTopLevel(m[2])) {
      const paren = entry.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
      // A gloss can itself be a list — "Kubernetes (EKS, GKE)" is three real
      // claims, and checking "EKS, GKE" as one string flags both together.
      const parts = paren ? [paren[1], ...paren[2].split(",")] : [entry];
      for (const part of parts) {
        const value = part.trim().replace(/\*+/g, "");
        // Long fragments are prose, not tool names; checking them as a unit
        // produces noise, and noise is how a checker gets ignored.
        if (!value || value.length > 60) continue;
        out.push({ kind: "skill", value, context: line.trim() });
      }
    }
  }
  return out;
}

/**
 * Employers named in running prose — "At Northwind I rebuilt…". A cover letter
 * has no headings at all, so without this `employers()` finds nothing and the
 * whole letter verifies as clean; a draft claiming a job at Netflix passed.
 * Companies in prose are nearly always introduced by a preposition, which is a
 * far tighter net than "any capitalised phrase".
 */
// Case is spelt out per-preposition on purpose: an /i flag would also apply
// to the [A-Z] below and match lowercase prose as if it were a company name.
const PROSE_ORG =
  /\b(?:[Aa]t|[Ww]ith|[Ff]or)\s+((?:[A-Z][A-Za-z0-9&.'-]+)(?:\s+[A-Z][A-Za-z0-9&.'-]+){0,2})/g;
// Sentence-initial words and role nouns that follow a preposition without
// naming a company. Cheap to extend; a false alarm here costs the user trust.
const NOT_ORG =
  /^(I|The|A|An|My|This|That|These|Those|We|It|Their|Its|Remote|Senior|Junior|Staff|Lead|Present|Scale|Speed|Time|Both|Each|Every|New|Most|More|Least)$/;

function proseEmployers(md: string, allow: Set<string>): Claim[] {
  const out: Claim[] = [];
  for (const line of md.split("\n")) {
    if (/^\s*#/.test(line)) continue; // headings are handled by employers()
    for (const m of line.matchAll(PROSE_ORG)) {
      // Drop the possessive and any trailing non-org words ("GitLab's" -> GitLab,
      // "CyberQP I" -> CyberQP).
      const words = m[1].replace(/'s\b/g, "").split(/\s+/).filter(Boolean);
      while (words.length && NOT_ORG.test(words[words.length - 1])) words.pop();
      // A sentence ending on the company name captures the period, and the next
      // sentence's first word with it: "…at Cobalt Data. My role…". Both have to
      // come off or every such sentence flags a real employer.
      const org = words
        .join(" ")
        .trim()
        .replace(/[.,;:]+$/, "");
      if (!org || NOT_ORG.test(org)) continue;
      // The company being applied TO is named all over a cover letter and is
      // not a claim of having worked there.
      if (allow.has(normalize(org))) continue;
      out.push({ kind: "employer", value: org, context: line.trim() });
    }
  }
  return out;
}

/**
 * Does `needle` occur in `haystack` as a whole name rather than as letters
 * inside a longer one?
 *
 * The boundary is "not alphanumeric", which is deliberately narrower than the
 * token: it has to split "TypeScript/JavaScript" into two supported skills and
 * let a trailing period off "pytest-xdist.", while still refusing to support
 * "Java" from "JavaScript" or "Go" from "background". \b cannot do this job —
 * it is defined on [A-Za-z0-9_], so it misplaces the boundary on every tool
 * name containing punctuation ("c++", "ci/cd", "node.js").
 */
function appearsWholeIn(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\\/-]/g, "\\$&");
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`).test(haystack);
}

/**
 * The distinct numbers in a document: "$1.40M saved, Mar 2023" -> {"1.40", "2023"}.
 *
 * A set of whole tokens, never a concatenated blob. Substring-testing the blob
 * reported a fabricated "23%" as supported because the base said "Mar 2023" —
 * and since every résumé carries years, that quietly blessed a large share of
 * invented percentages.
 */
function numericTokens(s: string): Set<string> {
  return new Set(
    s
      .replace(/[^0-9.]/g, " ")
      .split(/\s+/)
      // "v1.2." and "1.8s." leave a dangling dot that would fail an equality
      // test against the same figure written without one.
      .map((t) => t.replace(/^\.+|\.+$/g, ""))
      .filter(Boolean),
  );
}

function matches(md: string, re: RegExp, kind: ClaimKind): Claim[] {
  const out: Claim[] = [];
  for (const line of md.split("\n")) {
    for (const m of line.matchAll(re)) {
      out.push({ kind, value: m[0].trim(), context: line.trim() });
    }
  }
  return out;
}

/**
 * Check a tailored résumé against the master. Every employer, year, metric, and
 * listed skill in `tailored` must also appear in `base`.
 */
export function verifyAgainstBase(
  tailored: string,
  base: string,
  /** Names that may appear without being a claim — chiefly the company being applied to. */
  mentionable: string[] = [],
): VerifyReport {
  const haystack = normalize(base);
  const allow = new Set(mentionable.map(normalize).filter(Boolean));
  // Numbers alone, so "40M events" in the base still supports "40 M events".
  const baseNumbers = numericTokens(base);

  const claims = [
    ...employers(tailored),
    ...proseEmployers(tailored, allow),
    ...matches(tailored, YEAR, "date"),
    ...matches(tailored, METRIC, "metric"),
    ...skills(tailored),
  ];

  const seen = new Set<string>();
  const unsupported: Claim[] = [];

  for (const c of claims) {
    const key = `${c.kind}:${normalize(c.value)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const norm = normalize(c.value);
    if (!norm) continue;

    const digits = norm.replace(/[^0-9.]/g, "").replace(/^\.+|\.+$/g, "");
    const supported =
      // Boundary-anchored, not a raw substring: "Java" must not be supported
      // by "JavaScript", nor "Go" by "background".
      appearsWholeIn(haystack, norm) ||
      // Fall back to the bare number: the base may render the same figure with
      // different units or spacing ("40M events" vs "40 M events"). Equality
      // against a whole number, so "23%" is not supported by "2023". Requires
      // an actual digit — "".includes("") is true, so without this guard every
      // wordy claim (i.e. every skill) is silently reported as supported.
      (c.kind !== "employer" && digits !== "" && baseNumbers.has(digits));

    if (!supported) unsupported.push(c);
  }

  return { ok: unsupported.length === 0, unsupported, checked: seen.size };
}

/** Human-readable report for the CLI. */
export function formatReport(r: VerifyReport): string {
  if (r.checked === 0) {
    // "Nothing was wrong" and "nothing was examined" must not look alike. A
    // cover letter with no headings, years or figures yields zero claims, and
    // printing a tick there is how an invented employer ships unread.
    return (
      "· Nothing checkable found (no employer, date, metric or skill claims).\n" +
      "  This is NOT a pass — read the document yourself before sending it."
    );
  }
  if (r.ok) {
    return `✓ No unsupported claims. Checked ${r.checked} employer/date/metric/skill claims against the master résumé.`;
  }
  const lines = [
    `!! ${r.unsupported.length} of ${r.checked} claims are NOT in your master résumé:`,
    "",
  ];
  for (const c of r.unsupported) {
    lines.push(`  [${c.kind}] ${c.value}`);
    lines.push(`      ${c.context}`);
  }
  lines.push("");
  lines.push(
    "Each of these is either a real detail missing from profile/resume_base.md,",
    "or something the model invented. Fix the master résumé or the output — do",
    "not send this until every line above is accounted for.",
  );
  return lines.join("\n");
}
