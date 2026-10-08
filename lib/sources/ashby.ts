// Ashby public job-board API adapter.
// GET https://api.ashbyhq.com/posting-api/job-board/{org}?includeCompensation=true

import { cleanField, htmlToText } from "../html";
import { makeJobId, scopeKey } from "../store";
import type { Job, SourceResult } from "../types";

interface AshbyJob {
  id: string;
  title: string;
  location?: string;
  isRemote?: boolean;
  isListed?: boolean;
  publishedAt?: string;
  jobUrl?: string;
  applyUrl?: string;
  descriptionPlain?: string;
  descriptionHtml?: string;
  employmentType?: string;
  department?: string;
  team?: string;
  compensation?: {
    compensationTierSummary?: string;
    scrapeableCompensationSalarySummary?: string;
  };
}

async function fetchOrg(org: string): Promise<{ jobs: Job[]; scope: string }> {
  const res = await fetch(
    `https://api.ashbyhq.com/posting-api/job-board/${org}?includeCompensation=true`,
  );
  if (!res.ok) throw new Error(`ashby ${org}: HTTP ${res.status}`);
  const data = (await res.json()) as { jobs?: AshbyJob[] };
  const now = new Date().toISOString();
  const jobs = (data.jobs ?? [])
    // isListed === false means the org pulled the post from its public board.
    .filter((j) => j.isListed !== false)
    .map((j) => {
      const location = cleanField(j.location ?? "") || "Unspecified";
      const title = cleanField(j.title);
      const description =
        j.descriptionPlain ?? (j.descriptionHtml ? htmlToText(j.descriptionHtml) : "");
      return {
        id: makeJobId(title, org, location),
        source: "ashby" as const,
        sourceJobId: j.id,
        title,
        company: org,
        location,
        remote: j.isRemote ?? (/remote|anywhere/i.test(location) || null),
        description,
        url: j.applyUrl || j.jobUrl || "",
        postedAt: j.publishedAt ?? null,
        fetchedAt: now,
        // We were already asking for this with includeCompensation=true and
        // throwing it away. Ashby publishes e.g. "$211.4K - $290.6K".
        compensation:
          cleanField(
            j.compensation?.scrapeableCompensationSalarySummary ??
              j.compensation?.compensationTierSummary ??
              "",
          ) || null,
        employmentType: cleanField(j.employmentType ?? "") || null,
        department: cleanField(j.department ?? j.team ?? "") || null,
      };
    });
  return { jobs, scope: scopeKey("ashby", org) };
}

export async function fetchAshby(orgs: string[]): Promise<SourceResult> {
  const results = await Promise.allSettled(orgs.map(fetchOrg));
  const jobs: Job[] = [];
  const scopes: string[] = [];
  for (const [i, r] of results.entries()) {
    if (r.status === "fulfilled") {
      jobs.push(...r.value.jobs);
      scopes.push(r.value.scope);
    } else console.warn(`  ! ashby/${orgs[i]}: ${r.reason}`);
  }
  return { jobs, scopes };
}
