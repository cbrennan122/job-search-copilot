// JSearch adapter — aggregates Google for Jobs results, which is how LinkedIn,
// Indeed, Glassdoor and ZipRecruiter listings reach this pipeline compliantly.
// We call OpenWeb Ninja (the API's publisher) DIRECTLY rather than through the
// RapidAPI marketplace: same data, free tier of 200 requests/month, and no
// marketplace margin. Requires OPENWEBNINJA_API_KEY.
//
// GET https://api.openwebninja.com/jsearch/search-v2   (header: x-api-key)
// Docs: https://www.openwebninja.com/api/jsearch/docs
//
// Verified live 2026-08-25 against a real keyed response. Two shape differences
// from the RapidAPI version this replaced, both of which silently produced zero
// jobs before they were fixed:
//   - the payload is { data: { jobs: [...], cursor } }, NOT a bare data[] array;
//   - job_city / job_state / job_country came back null on every remote listing.
//     job_location ("Anywhere") is the field that is actually populated.
// The min/max/period salary path IS verified: 6 of 28 stored rows rendered as
// "$120K - $150K / year" through formatSalaryRange. What is NOT yet exercised is
// the job_salary_string fallback below it -- no sampled listing had a salary
// string without also having the numbers.

import { cleanField, htmlToText } from "../html";
import { formatSalaryRange } from "../money";
import { makeJobId } from "../store";
import type { Job, SourceResult } from "../types";

interface JSearchJob {
  job_id?: string;
  /** Short stable id (24 chars); job_id is a ~400-char base64 blob. */
  job_uid?: string;
  job_title?: string;
  employer_name?: string;
  job_location?: string;
  job_city?: string | null;
  job_state?: string | null;
  job_country?: string | null;
  job_is_remote?: boolean;
  job_apply_link?: string;
  job_description?: string;
  job_posted_at_datetime_utc?: string | null;
  job_employment_type?: string;
  job_min_salary?: number | null;
  job_max_salary?: number | null;
  job_salary_period?: string | null;
  /** Publisher's own pre-formatted string, e.g. "$120K - $150K a year". */
  job_salary_string?: string | null;
}

interface JSearchResponse {
  status?: string;
  data?: { jobs?: JSearchJob[] };
}

async function fetchQuery(query: string, pages: number): Promise<Job[]> {
  const key = process.env.OPENWEBNINJA_API_KEY;
  if (!key) throw new Error("OPENWEBNINJA_API_KEY not set");

  const url = new URL("https://api.openwebninja.com/jsearch/search-v2");
  url.searchParams.set("query", query);
  url.searchParams.set("country", "us");
  url.searchParams.set("num_pages", String(pages));

  const res = await fetch(url, { headers: { "x-api-key": key } });
  // A 403 here means "subscribed to the account but not to THIS API" at least as
  // often as it means a bad key — the account key is shared across every
  // OpenWeb Ninja product, so say both rather than sending the reader after the
  // key when the plan is what is missing.
  if (res.status === 403)
    throw new Error(
      `jsearch "${query}": HTTP 403 — key rejected, or the account has no ` +
        `JSearch subscription (the free plan still has to be activated)`,
    );
  if (!res.ok) throw new Error(`jsearch "${query}": HTTP ${res.status}`);

  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("json"))
    throw new Error(`jsearch "${query}": expected JSON, got ${type || "no content-type"}`);

  const body = (await res.json()) as JSearchResponse;
  const items = body.data?.jobs ?? [];
  const now = new Date().toISOString();

  return items.flatMap((j) => {
    if (!j.job_title) return [];

    const title = cleanField(j.job_title);
    const company = cleanField(j.employer_name ?? "") || "Unknown";
    // job_location first: on remote listings it is the only populated one, and
    // the city/state/country join collapses to "" exactly when job_is_remote is
    // true — which is most of what these queries return.
    const location =
      cleanField(j.job_location ?? "") ||
      [j.job_city, j.job_state, j.job_country].filter(Boolean).join(", ") ||
      (j.job_is_remote ? "Remote" : "Unspecified");

    const range = formatSalaryRange(
      j.job_min_salary,
      j.job_max_salary,
      "USD", // no currency field in the payload; this feed is queried country=us
      j.job_salary_period?.toLowerCase(),
    );

    return [
      {
        id: makeJobId(title, company, location),
        source: "jsearch" as const,
        sourceJobId: j.job_uid ?? j.job_id ?? title,
        title,
        company,
        location,
        remote: j.job_is_remote ?? null,
        // Plain text in every sampled response, but htmlToText is a no-op on
        // clean text and the upstream publishers are not consistent.
        description: htmlToText(j.job_description ?? ""),
        url: j.job_apply_link ?? "",
        postedAt: j.job_posted_at_datetime_utc ?? null,
        fetchedAt: now,
        // Fall back to the publisher's own string when the numbers are absent:
        // it is posted data, so dropping it would discard real pay information.
        compensation: range ?? (cleanField(j.job_salary_string ?? "") || null),
        employmentType: cleanField(j.job_employment_type ?? "") || null,
        department: null,
      },
    ];
  });
}

export async function fetchJSearch(queries: string[], pages: number): Promise<SourceResult> {
  const results = await Promise.allSettled(queries.map((q) => fetchQuery(q, pages)));
  const jobs: Job[] = [];
  for (const [i, r] of results.entries()) {
    if (r.status === "fulfilled") jobs.push(...r.value);
    else console.warn(`  ! jsearch/"${queries[i]}": ${r.reason}`);
  }
  // No scopes — a keyword search returns a ranked slice, never a company's
  // complete open roles, so absence from the results proves nothing.
  return { jobs, scopes: [] };
}
