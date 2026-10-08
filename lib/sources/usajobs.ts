// USAJobs adapter — the official U.S. federal jobs API. Free, but key-gated:
// needs USAJOBS_API_KEY and USAJOBS_EMAIL (the API requires a contact address
// in the User-Agent, and rejects the request without it).
//
// GET https://data.usajobs.gov/api/search
// Docs: https://developer.usajobs.gov/api-reference/get-api-search
//
// Verified live 2026-08-25 only as far as an unauthenticated call goes: the host
// resolves and returns a clean JSON 401 body. The success-path field mapping
// below follows the published schema and has NOT been checked against a real
// keyed response — re-verify the first time a key is present.

import { cleanField, htmlToText } from "../html";
import { formatSalaryRange } from "../money";
import { makeJobId } from "../store";
import type { Job, SourceResult } from "../types";

interface UsaJobsDescriptor {
  PositionID?: string;
  PositionTitle?: string;
  PositionURI?: string;
  ApplyURI?: string[];
  PositionLocationDisplay?: string;
  OrganizationName?: string;
  DepartmentName?: string;
  PublicationStartDate?: string;
  QualificationSummary?: string;
  PositionSchedule?: Array<{ Name?: string }>;
  PositionRemuneration?: Array<{
    MinimumRange?: string;
    MaximumRange?: string;
    RateIntervalCode?: string;
  }>;
  UserArea?: {
    Details?: {
      JobSummary?: string;
      MajorDuties?: string[];
      TeleworkEligible?: boolean;
      RemoteIndicator?: boolean;
    };
  };
}

interface UsaJobsResponse {
  SearchResult?: {
    SearchResultItems?: Array<{ MatchedObjectDescriptor?: UsaJobsDescriptor }>;
  };
}

// USAJobs reports pay per "rate interval"; a GS salary is annual but wage-grade
// roles are hourly, and showing "$28 – $34" with no unit reads as a typo.
const INTERVAL: Record<string, string | undefined> = {
  PA: undefined, // per annum — the default reading, so leave it unlabelled
  PH: "hour",
  PD: "day",
  PW: "week",
  BW: "2 weeks",
  PM: "month",
};

async function fetchQuery(query: string, resultsPerPage: number): Promise<Job[]> {
  const key = process.env.USAJOBS_API_KEY;
  const email = process.env.USAJOBS_EMAIL;
  if (!key || !email) throw new Error("USAJOBS_API_KEY and USAJOBS_EMAIL must both be set");

  const url = new URL("https://data.usajobs.gov/api/search");
  url.searchParams.set("Keyword", query);
  url.searchParams.set("ResultsPerPage", String(Math.min(resultsPerPage, 500)));

  const res = await fetch(url, {
    headers: {
      "Authorization-Key": key,
      "User-Agent": email,
      Host: "data.usajobs.gov",
    },
  });
  if (!res.ok) throw new Error(`usajobs "${query}": HTTP ${res.status}`);

  const data = (await res.json()) as UsaJobsResponse;
  const items = data.SearchResult?.SearchResultItems ?? [];
  const now = new Date().toISOString();

  return items.flatMap((item) => {
    const d = item.MatchedObjectDescriptor;
    if (!d?.PositionTitle) return [];

    const title = cleanField(d.PositionTitle);
    const company =
      cleanField(d.OrganizationName ?? d.DepartmentName ?? "") || "U.S. Federal Government";
    const location = cleanField(d.PositionLocationDisplay ?? "") || "Unspecified";

    const details = d.UserArea?.Details;
    // Descriptions come back as several separate prose fields; the queue and the
    // fit scorer both want one blob, so join them rather than picking one.
    const description = htmlToText(
      [details?.JobSummary, d.QualificationSummary, ...(details?.MajorDuties ?? [])]
        .filter(Boolean)
        .join("\n\n"),
    );

    const pay = d.PositionRemuneration?.[0];
    const remote =
      details?.RemoteIndicator ??
      (/\bremote\b/i.test(location) ? true : (details?.TeleworkEligible ?? null));

    return [
      {
        id: makeJobId(title, company, location),
        source: "usajobs" as const,
        sourceJobId: d.PositionID ?? d.PositionURI ?? title,
        title,
        company,
        location,
        remote,
        description,
        url: d.ApplyURI?.[0] ?? d.PositionURI ?? "",
        postedAt: d.PublicationStartDate ?? null,
        fetchedAt: now,
        compensation: formatSalaryRange(
          Number(pay?.MinimumRange),
          Number(pay?.MaximumRange),
          "USD",
          INTERVAL[pay?.RateIntervalCode ?? "PA"],
        ),
        employmentType: cleanField(d.PositionSchedule?.[0]?.Name ?? "") || null,
        department: cleanField(d.DepartmentName ?? "") || null,
      },
    ];
  });
}

export async function fetchUsaJobs(
  queries: string[],
  resultsPerPage: number,
): Promise<SourceResult> {
  const results = await Promise.allSettled(queries.map((q) => fetchQuery(q, resultsPerPage)));
  const jobs: Job[] = [];
  for (const [i, r] of results.entries()) {
    if (r.status === "fulfilled") jobs.push(...r.value);
    else console.warn(`  ! usajobs/"${queries[i]}": ${r.reason}`);
  }
  // Keyword search over a moving federal-wide result set, not an exhaustive
  // listing for any employer — so no scopes, and nothing here is auto-closed.
  return { jobs, scopes: [] };
}
