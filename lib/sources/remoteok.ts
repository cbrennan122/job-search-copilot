// RemoteOK public API adapter.
// GET https://remoteok.com/api  -> array; first element is a legal notice.
// A descriptive User-Agent is expected.

import { cleanField, htmlToText } from "../html";
import { matchesTerm } from "../match";
import { formatSalaryRange } from "../money";
import type { Profile } from "../profile";
import { makeJobId } from "../store";
import type { SourceResult } from "../types";

interface RokJob {
  id?: string;
  slug?: string;
  position?: string;
  company?: string;
  location?: string;
  url?: string;
  apply_url?: string;
  description?: string;
  date?: string;
  tags?: string[];
  salary_min?: number;
  salary_max?: number;
}

/**
 * Is this posting plausibly one you are targeting?
 *
 * RemoteOK is a general job board, not a tech one. Unfiltered it contributed 223
 * of the queue's open rows and not one of them scored 70 or better: Fire
 * Fighter, Specimen Collector, Accounts Receivable Clerk, Construction
 * Inspector. Every other source here is a company board or a keyword-queried
 * API, so this was the only feed with no targeting applied at all.
 *
 * Filtering at the ADAPTER rather than in the prefilter is deliberate — a row
 * dropped here never enters the store, so it costs no row, no LLM call, and no
 * space in the review queue. The test is intentionally loose (title OR tags, any
 * single hit): the prefilter and the LLM still rank what survives, and this only
 * needs to remove work that is not in the field at all.
 */
function targeted(title: string, tags: string[], profile: Profile): boolean {
  const t = title.toLowerCase();
  const terms = [...profile.match.titles, ...profile.match.keywords];
  // matchesTerm for the title, so the boundary rules hold and "qa" misses
  // "Qatar". Tags are already single normalized terms, so an equality test on
  // the lowercased value is both correct and cheaper.
  const tagged = new Set(tags.map((g) => g.toLowerCase().trim()));
  return terms.some((term) => tagged.has(term.toLowerCase()) || matchesTerm(t, term));
}

export async function fetchRemoteOk(profile: Profile): Promise<SourceResult> {
  const res = await fetch("https://remoteok.com/api", {
    headers: { "User-Agent": "job-copilot/1.0 (personal job search tool)" },
  });
  if (!res.ok) throw new Error(`remoteok: HTTP ${res.status}`);
  const rows = (await res.json()) as RokJob[];
  const now = new Date().toISOString();
  const jobs = rows
    .filter((r) => r.position && r.company) // drops the legal-notice element
    .filter((r) => targeted(cleanField(r.position!), r.tags ?? [], profile))
    .map((r) => {
      // RemoteOK ships entity-encoded and Latin-1-mangled names ("H&amp;M",
      // "GEA PerÃº"); cleanField fixes both before they reach the dedup hash.
      const title = cleanField(r.position!);
      const company = cleanField(r.company!);
      const location = cleanField(r.location ?? "") || "Remote";
      return {
        id: makeJobId(title, company, location),
        source: "remoteok" as const,
        sourceJobId: String(r.id ?? r.slug ?? title),
        title,
        company,
        location,
        remote: true,
        description: r.description ? htmlToText(r.description) : "",
        url: r.apply_url || r.url || "",
        postedAt: r.date ?? null,
        fetchedAt: now,
        compensation: formatSalaryRange(r.salary_min, r.salary_max),
        employmentType:
          r.tags?.find((t) => /full.?time|part.?time|contract|intern/i.test(t)) ?? null,
        department: null,
      };
    });
  // No scopes: this is a rolling feed of the ~100 newest posts, so a job leaving
  // it means "scrolled off", not "closed". Auto-delisting here would close jobs
  // that are still open. Staleness is handled by listJobs({ maxAgeDays }).
  return { jobs, scopes: [] };
}
