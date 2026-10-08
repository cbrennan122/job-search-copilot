// Adzuna adapter — free tier (registration required) aggregating public postings
// across a country. Needs ADZUNA_APP_ID and ADZUNA_APP_KEY.
//
// GET https://api.adzuna.com/v1/api/jobs/<country>/search/<page>
// Docs: https://developer.adzuna.com/overview
//
// Verified live 2026-08-25: the endpoint answers, but it returns an HTML error
// page (not JSON) on a bad/missing key — including on /v1/api/version. So this
// adapter checks status AND content-type before parsing; calling res.json()
// straight away turns a plain auth failure into an unrelated JSON syntax error.
// The success-path field mapping follows the published schema and has NOT been
// checked against a real keyed response — re-verify once a key is present.

import { cleanField, htmlToText } from "../html";
import { formatSalaryRange } from "../money";
import { makeJobId } from "../store";
import type { Job, SourceResult } from "../types";

interface AdzunaJob {
  id?: string;
  title?: string;
  description?: string;
  created?: string;
  redirect_url?: string;
  salary_min?: number;
  salary_max?: number;
  /** "1" when the number is Adzuna's own estimate rather than the employer's. */
  salary_is_predicted?: string;
  company?: { display_name?: string };
  location?: { display_name?: string };
  category?: { label?: string };
  contract_time?: string; // full_time | part_time
  contract_type?: string; // permanent | contract
}

const CURRENCY: Record<string, string> = {
  gb: "GBP",
  us: "USD",
  ca: "CAD",
  au: "AUD",
  nz: "AUD",
  de: "EUR",
  fr: "EUR",
  es: "EUR",
  it: "EUR",
  nl: "EUR",
  at: "EUR",
  be: "EUR",
};

/** "full_time" + "permanent" -> "Full time, Permanent". */
function employmentType(j: AdzunaJob): string | null {
  const parts = [j.contract_time, j.contract_type]
    .filter(Boolean)
    .map((s) => s!.replace(/_/g, " "))
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1));
  return parts.length ? parts.join(", ") : null;
}

async function fetchPage(
  country: string,
  query: string,
  page: number,
  perPage: number,
): Promise<Job[]> {
  const appId = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_APP_KEY;
  if (!appId || !appKey) throw new Error("ADZUNA_APP_ID and ADZUNA_APP_KEY must both be set");

  const url = new URL(`https://api.adzuna.com/v1/api/jobs/${country}/search/${page}`);
  url.searchParams.set("app_id", appId);
  url.searchParams.set("app_key", appKey);
  url.searchParams.set("what", query);
  url.searchParams.set("results_per_page", String(perPage));
  url.searchParams.set("content-type", "application/json");

  const res = await fetch(url);
  if (!res.ok) throw new Error(`adzuna "${query}" p${page}: HTTP ${res.status}`);

  // A 200 with an HTML body has been observed too; parsing it would surface as
  // "Unexpected token '<'", which points nowhere near the actual problem.
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("json"))
    throw new Error(`adzuna "${query}" p${page}: expected JSON, got ${type || "no content-type"}`);

  const data = (await res.json()) as { results?: AdzunaJob[] };
  const now = new Date().toISOString();
  const currency = CURRENCY[country.toLowerCase()] ?? "USD";

  return (data.results ?? []).flatMap((j) => {
    if (!j.title) return [];
    const title = cleanField(j.title);
    const company = cleanField(j.company?.display_name ?? "") || "Unknown";
    const location = cleanField(j.location?.display_name ?? "") || "Unspecified";
    const predicted = j.salary_is_predicted === "1";
    const pay = formatSalaryRange(j.salary_min, j.salary_max, currency);

    return [
      {
        id: makeJobId(title, company, location),
        source: "adzuna" as const,
        sourceJobId: String(j.id ?? title),
        title,
        company,
        location,
        remote: /\bremote\b/i.test(`${title} ${location}`) || null,
        // Adzuna returns a ~200-char snippet, not the full JD — it ends in an
        // ellipsis. Enough to triage on, thin input for the fit scorer; the
        // redirect_url is where the real posting lives.
        description: htmlToText(j.description ?? ""),
        url: j.redirect_url ?? "",
        postedAt: j.created ?? null,
        fetchedAt: now,
        // Flagging the estimate matters: an unmarked predicted range looks like
        // the employer published a number they never published.
        compensation: pay && predicted ? `${pay} (est.)` : pay,
        employmentType: employmentType(j),
        department: cleanField(j.category?.label ?? "") || null,
      },
    ];
  });
}

export async function fetchAdzuna(
  country: string,
  queries: string[],
  pages: number,
  perPage: number,
): Promise<SourceResult> {
  const calls: Array<{ query: string; page: number }> = [];
  for (const query of queries)
    for (let page = 1; page <= pages; page++) calls.push({ query, page });

  const results = await Promise.allSettled(
    calls.map((c) => fetchPage(country, c.query, c.page, perPage)),
  );
  const jobs: Job[] = [];
  for (const [i, r] of results.entries()) {
    if (r.status === "fulfilled") jobs.push(...r.value);
    else console.warn(`  ! adzuna/"${calls[i].query}" p${calls[i].page}: ${r.reason}`);
  }
  // Paged keyword search over an aggregator, not a company's full open roles —
  // no scopes, so nothing from Adzuna is ever auto-delisted.
  return { jobs, scopes: [] };
}
