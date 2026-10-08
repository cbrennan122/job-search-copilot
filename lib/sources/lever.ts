// Lever public postings API adapter.
// GET https://api.lever.co/v0/postings/{company}?mode=json  (public, no auth)

import { cleanField } from "../html";
import { makeJobId, scopeKey } from "../store";
import type { Job, SourceResult } from "../types";

interface LeverPosting {
  id: string;
  text: string; // title
  hostedUrl: string;
  applyUrl?: string;
  createdAt?: number;
  descriptionPlain?: string;
  categories?: {
    location?: string;
    team?: string;
    department?: string;
    commitment?: string;
  };
  workplaceType?: string; // "remote" | "hybrid" | "onsite"
}

async function fetchCompany(company: string): Promise<{ jobs: Job[]; scope: string }> {
  const res = await fetch(`https://api.lever.co/v0/postings/${company}?mode=json`);
  if (!res.ok) throw new Error(`lever ${company}: HTTP ${res.status}`);
  const postings = (await res.json()) as LeverPosting[];
  const now = new Date().toISOString();
  const jobs = postings.map((p) => {
    const location = cleanField(p.categories?.location ?? "") || "Unspecified";
    const title = cleanField(p.text);
    const remote = p.workplaceType === "remote" || /remote|anywhere/i.test(location) || null;
    return {
      id: makeJobId(title, company, location),
      source: "lever" as const,
      sourceJobId: p.id,
      title,
      company,
      location,
      remote,
      description: p.descriptionPlain ?? "",
      url: p.applyUrl || p.hostedUrl,
      postedAt: p.createdAt ? new Date(p.createdAt).toISOString() : null,
      fetchedAt: now,
      compensation: null,
      employmentType: p.categories?.commitment ? cleanField(p.categories.commitment) : null,
      department: cleanField(p.categories?.department ?? p.categories?.team ?? "") || null,
    };
  });
  return { jobs, scope: scopeKey("lever", company) };
}

export async function fetchLever(companies: string[]): Promise<SourceResult> {
  const results = await Promise.allSettled(companies.map(fetchCompany));
  const jobs: Job[] = [];
  const scopes: string[] = [];
  for (const [i, r] of results.entries()) {
    if (r.status === "fulfilled") {
      jobs.push(...r.value.jobs);
      scopes.push(r.value.scope);
    } else console.warn(`  ! lever/${companies[i]}: ${r.reason}`);
  }
  return { jobs, scopes };
}
