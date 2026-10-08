---
name: add-source
description: Add a new job-board source adapter to Job Search Copilot. Use when integrating another job API (Greenhouse/Lever/Ashby-style company board, or a keyword search feed like Adzuna/JSearch/USAJobs) into the aggregation pipeline. Covers the SourceResult delisting contract, the adapter template, config wiring, live slug verification, and how to verify without an API key.
---

# Add a job source

A source adapter fetches listings from one job board/API and returns a
`SourceResult` — normalized jobs **plus the delisting scopes it can vouch for**.
All adapters share that shape; follow it exactly.

```ts
export interface SourceResult {
  jobs: Job[];
  scopes: string[];
}
```

## The scopes contract — get this right before writing any code

`scopes` decides which of your jobs the pipeline is allowed to mark closed when
they stop appearing. It is deliberately narrow. List a scope key **only if this
run enumerated every open job for it, and the fetch succeeded.**

|                          | Declares scopes? | Why                                                                 |
| ------------------------ | ---------------- | ------------------------------------------------------------------- |
| Company boards — Greenhouse, Lever, Ashby | **Yes**, one per company | The endpoint returns that company's complete open list, so a job that vanishes really is closed. |
| Search feeds — RemoteOK, JSearch, Adzuna, USAJobs | **No** — return `scopes: []` | You get a slice of a moving result set. A job dropping off page 1 means nothing. |

Two failure modes this prevents, both of which silently delete the user's queue:

- Declaring a scope for a **failed** fetch closes every job that company has, on
  one transient 500.
- Declaring a scope for a **search feed** closes almost everything each run,
  because tomorrow's page 1 is not today's page 1.

If you are unsure which kind of source you have, return `scopes: []`. The cost is
that stale jobs linger (the `maxAgeDays` filter handles them); the cost of the
wrong call is deleting live listings.

## Step 0 — Verify endpoints/slugs LIVE first (do not skip)

Board slugs guessed from company names are frequently wrong — `hashicorp`,
`netlify`, and `brex` all 404'd. Probe before adding anything to `profile.toml`:

```bash
# Greenhouse
curl -s -o /dev/null -w "%{http_code}\n" https://boards-api.greenhouse.io/v1/boards/<slug>/jobs
# Lever
curl -s https://api.lever.co/v0/postings/<slug>?mode=json | head -c 200
# Ashby
curl -s https://api.ashbyhq.com/posting-api/job-board/<slug> | head -c 200
```

A 200 with a non-empty job list means the slug is good. Confirm the API is a
**public/official endpoint** — never HTML-scrape. LinkedIn and Indeed are only
reachable via aggregators like JSearch.

**Check the error shape too.** Adzuna returns an HTML error page rather than JSON
on a bad key, so `res.json()` throws a parse error that reads like a bug in your
mapping. Guard on status *and* content-type when the API does this:

```ts
if (!res.ok) throw new Error(`<name> "${query}": HTTP ${res.status}`);
const type = res.headers.get("content-type") ?? "";
if (!type.includes("json"))
  throw new Error(`<name> "${query}": expected JSON, got ${type || "no content-type"}`);
```

## Step 1 — Write the adapter

Create `lib/sources/<name>.ts`. Rules:

- `id` = `makeJobId(title, company, location)` (from `lib/store.ts`) — the cross-source dedup key.
- Run HTML descriptions through `htmlToText` (`lib/html.ts`); it decodes entities,
  strips tags, then decodes again, which is what handles double-encoded boards.
  Use `cleanField` for short fields (title/company/location).
- Populate `compensation`, `employmentType`, `department` when the API has them —
  discarding pay data was a real bug. Use `formatSalaryRange` (`lib/money.ts`) so
  ranges render consistently, and mark estimates (`"$120K - $150K (est.)"`) when
  the number is model-predicted rather than posted.
- Set `remote` from an explicit API flag when available, else infer from location, else `null`.
- Wrap multi-target fetches in `Promise.allSettled` so one bad slug can't sink the run.
- Gate keyed sources on their env vars, and skip cleanly when absent.

Template — multi-company board (declares scopes; mirror `greenhouse.ts`):

```ts
import { cleanField, htmlToText } from "../html";
import { makeJobId, scopeKey } from "../store";
import type { Job, SourceResult } from "../types";

async function fetchBoard(slug: string): Promise<{ jobs: Job[]; scope: string }> {
  const res = await fetch(`https://api.example.com/${slug}/jobs`);
  if (!res.ok) throw new Error(`<name> ${slug}: HTTP ${res.status}`);
  const data = (await res.json()) as { jobs?: unknown[] };
  const now = new Date().toISOString();
  const company = cleanField(slug);
  const jobs = (data.jobs ?? []).map((j: any) => {
    const location = cleanField(j.location ?? "") || "Unspecified";
    const title = cleanField(j.title);
    return {
      id: makeJobId(title, company, location),
      source: "<name>" as const,
      sourceJobId: String(j.id),
      title,
      company,
      location,
      remote: j.isRemote ?? (/remote|anywhere/i.test(location) || null),
      description: j.descriptionHtml ? htmlToText(j.descriptionHtml) : (j.description ?? ""),
      url: j.applyUrl || j.jobUrl || "",
      postedAt: j.publishedAt ?? null,
      fetchedAt: now,
      compensation: null,
      employmentType: null,
      department: null,
    };
  });
  // Scope is declared here, inside the success path only.
  return { jobs, scope: scopeKey("<name>", company) };
}

export async function fetch<Name>(slugs: string[]): Promise<SourceResult> {
  const results = await Promise.allSettled(slugs.map(fetchBoard));
  const jobs: Job[] = [];
  const scopes: string[] = [];
  for (const [i, r] of results.entries()) {
    if (r.status === "fulfilled") {
      jobs.push(...r.value.jobs);
      scopes.push(r.value.scope);   // only fulfilled boards contribute a scope
    } else {
      console.warn(`  ! <name>/${slugs[i]}: ${r.reason}`);
    }
  }
  return { jobs, scopes };
}
```

Template — keyword search feed (declares **no** scopes; mirror `adzuna.ts`):

```ts
export async function fetch<Name>(queries: string[], pages = 1): Promise<SourceResult> {
  if (!process.env.<NAME>_API_KEY) return { jobs: [], scopes: [] };
  const results = await Promise.allSettled(/* one task per query/page */);
  const jobs: Job[] = [];
  for (const [i, r] of results.entries()) {
    if (r.status === "fulfilled") jobs.push(...r.value);
    else console.warn(`  ! <name>/${queries[i]}: ${r.reason}`);
  }
  // Never scopes: this is a slice of a moving result set, not an enumeration.
  return { jobs, scopes: [] };
}
```

Add the new source string to the `JobSource` union in `lib/types.ts`.

## Step 2 — Add config

- `lib/profile.ts`: add a zod block (company list, or queries + pages/options).
  Give every field a `.default()` so an older `profile.toml` still parses.
- `profile/profile.toml` **and** `profile/profile.example.toml`: add the matching
  `[<name>]` section. The example is the committed one — a new clone only gets
  that, so a section missing there is invisible to everyone but you.

## Step 3 — Wire into the pipeline

In `lib/pipeline.ts` → `fetchAllSources`, push a task guarded on config **and**
env presence, so an unconfigured source is skipped rather than failed:

```ts
if (profile.<name>.queries.length && process.env.<NAME>_API_KEY)
  tasks.push({ name: "<name>", run: () => fetch<Name>(profile.<name>.queries) });
```

`fetchAllSources` already collects scopes from fulfilled tasks only, and records
`-1` in `perSource` for a source that threw outright. You do not need to handle
either at the adapter level.

## Step 4 — Pin the response shape with a fixture test

Capture one real response and test the mapping against it. A published API can
change shape under you, and the failure is silent: JSearch moved from a bare
`data[]` array to `{ data: { jobs: [...] } }`, which made the adapter return zero
jobs while the run still reported success.

Stub `globalThis.fetch` — no new dependencies, no network in CI (see
`tests/jsearch.test.ts`):

```ts
process.env.JOB_COPILOT_DB = "/tmp/job-copilot-<name>-test.db";  // makeJobId opens a DB
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

globalThis.fetch = (async () =>
  new Response(JSON.stringify(LIVE_SHAPE), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;
```

Cover at minimum: the happy-path field mapping, **`scopes` is `[]` on both a
clean fetch and a failed one** (for a search feed), one query failing without
taking the others down, and a non-JSON body.

**Then mutate the adapter and confirm each test fails.** A test that passes
against a broken adapter is worse than no test. Reversing the `job_location`
fallback order left every assertion green until a fixture was added where the
two location sources actually disagree — with both fields null, precedence is
unobservable.

## Step 5 — Verify live

```bash
npx tsc --noEmit
npm run lint
npm test
npx tsx scripts/fetch.ts --no-score      # no ANTHROPIC_API_KEY needed
```

Then spot-check the DB — run from the repo root:

```bash
npx tsx -e "
import { db } from './lib/store';
console.table(db().prepare('SELECT source, COUNT(*) n FROM jobs GROUP BY source').all());
console.log(db().prepare(\"SELECT title, compensation, substr(description,1,120) d FROM jobs WHERE source='<name>' AND description != '' LIMIT 2\").all());
"
```

Confirm: the source appears with a sane count; the sampled description is clean
plain text with no leftover `<tags>` or `&amp;` entities; and compensation is
populated if the API provides it.

**Then run it a second time.** The pipeline is meant to be idempotent, so the
second run must report `0 new`, everything refreshed, and — this is the one that
matters — **`Closed 0`**, or a single-digit count that genuine churn explains.

Boards really do pull a posting between two back-to-back runs, so one closure is
not automatically a bug: `curl` the board and check whether that id is actually
gone before you go looking for one. A scopes bug does not look like this — it
closes *hundreds* at once, because it is asserting that a feed slice or a failed
fetch was a complete enumeration.
