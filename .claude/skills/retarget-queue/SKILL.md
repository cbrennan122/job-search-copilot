---
name: retarget-queue
description: Change what the job queue targets — titles, keywords, deprioritize terms, or role-family preference weights — and correctly propagate that change to jobs that were already scored. Use when the user wants different kinds of roles surfaced, wants the queue re-ranked or re-scored, says the rankings look wrong, or edits profile/profile.toml. Covers why stored scores never update themselves, pricing the re-score before spending, and proving the old targeting actually cleared.
---

# Retarget the queue

Two different things get called "change what I see", and they cost wildly different
amounts. Establish which one the user means **before** touching anything.

| The user wants | Knob | Costs |
| --- | --- | --- |
| Different roles *fetched and judged* — "stop showing me QA jobs", "I want more backend" | `profile/profile.toml` → `titles` / `keywords` / `deprioritize` | Re-score: one LLM call per surviving job |
| The same jobs *ordered differently* — "put software engineering first" | `lib/categories.ts` → per-family `weight` | **Free.** Nothing stored, nothing to re-run |

If it is only the ordering, stop after Step 2. Re-scoring for a weight change spends
money to produce identical scores.

## Step 0 — Know why this is not automatic

A real LLM score is **final by design**. `unscoredJobs` re-queues only never-scored rows
and failed-call `FALLBACK_MODEL` rows, so `npm run fetch` will never revisit a job it has
already judged. That is correct while config is stable and wrong the moment targeting
changes: every stored score was computed against the titles, keywords and deprioritize
list in force at the time, and **the reasons quote it back** — "explicitly avoiding
test-focused roles aligns with this platform position" outlives the config that produced
it. `scripts/rescore.ts` is the only thing that expires them.

The fit score and the preference weight are **separate axes on purpose**. The score
answers "how well does the résumé match this posting" — it is what `minFit` filters on
and what the digest reports. Preference is added in `store.ts`'s `RANK` expression, which
moves `ORDER BY` only; the stored and displayed number is never adjusted. Do not fold one
into the other, and do not add the preference to the LLM prompt as well — applying it in
both places double-counts it.

## Step 1 — Audit the classifier against real titles first

Never retune patterns from imagination. Look at what is actually in the queue, and check
where the current rules put it:

```bash
npx tsx -e "
import { db } from './lib/store';
import { categoryOf } from './lib/categories';
const rows = db().prepare('SELECT DISTINCT title FROM jobs WHERE closedAt IS NULL').all();
const by = new Map();
for (const r of rows) { const c = categoryOf(r.title).id; by.set(c, (by.get(c) ?? 0) + 1); }
console.log(Object.fromEntries(by));
console.log(rows.filter(r => categoryOf(r.title).id === 'other').slice(0, 40).map(r => r.title));
"
```

Read the `other` list before adding patterns. Some of it is legitimately other (Forward
Deployed Engineer, Professional Services, Security Engineer) and should stay there;
what you are hunting for is a title that clearly belongs to a family and was missed.

**The miss that actually happened:** "Senior Staff Platform & CI/CD Engineer" landed in
`other` because multi-word patterns require adjacency and the `&` breaks up
"platform engineer". The fix was single-token infra markers (`ci/cd`, `gitops`,
`kubernetes`), not a longer multi-word phrase.

## Step 2 — Edit the targeting

**Ordering only** (`lib/categories.ts`): change `weight`. Nothing is stored, so the whole
queue re-ranks on the next request with no migration and no re-score. The **gap** is the
knob — `swe(18) - devops(10) = 8` means a DevOps role must out-fit a software engineering
one by more than 8 points to rank higher. Flatten the weights to equal numbers to go back
to pure score order. Keep every weight `>= 0`: a negative weight demotes a family rather
than merely passing over it, which is a different decision than "I prefer X".

Two constraints on the category array itself:

- It is in **match order (specificity), not preference order** — first hit wins, so
  `sdet` must precede `swe` or "QA Software Engineer" is claimed by the wrong family.
  `rankedCategories()` re-sorts by weight for display; the array order is for matching.
- `matchesTitle` is boundary-anchored and **asymmetric on purpose**. Single-word patterns
  need a closing boundary (so `qa` misses "Qatar" and `intern` misses "internal");
  multi-word ones do not (so `software engineer` still catches "Software Engineering").
  The boundary is "not alphanumeric", not `\b` — `\b` is defined on `[A-Za-z0-9_]` and
  misplaces the edge on `c++`, `ci/cd`, `node.js`.

**Targeting** (`profile/profile.toml`): edit `titles` / `keywords` / `deprioritize`.
Remember these are substring matches in the prefilter — this is why `deprioritize` holds
`"internship"` and never `"intern"`. A term in both `titles` and `deprioritize` cancels
itself to roughly zero; check for that before blaming the scorer.

If you add or change a **category schema field**, it must land in both
`profile/profile.toml` and `profile/profile.example.toml` — the example is the only one a
fresh clone gets.

## Step 3 — Prove any new pattern can fail

Add cases to `tests/categories.test.ts`, then **mutate the classifier and watch them go
red**. A pattern test that passes against a broken classifier is worse than none. The
controls that must stay in the file, because each is a bug that shipped:

- `matchesTitle("internal tools engineer", "intern")` → **false**
- `matchesTitle("qatar operations lead", "qa")` → **false**
- `matchesTitle("stress test analyst", "sre")` → **false**
- reversing the category array must break the "QA Software Engineer" case

## Step 4 — Back up the scores before clearing

Deleting is the whole mechanism and there is no undo. JSON rather than a `.sql` dump,
because it needs no SQL string quoting at all:

```bash
npx tsx -e "
import { db } from './lib/store';
import { writeFileSync } from 'node:fs';
const rows = db().prepare('SELECT * FROM fit_scores').all();
writeFileSync('/tmp/fit_scores-backup.json', JSON.stringify(rows));
console.error(rows.length + ' rows backed up');
"
```

Restore, if the new targeting turns out worse:

```bash
npx tsx -e "
import { db } from './lib/store';
import { readFileSync } from 'node:fs';
const rows = JSON.parse(readFileSync('/tmp/fit_scores-backup.json', 'utf8'));
const ins = db().prepare('INSERT OR REPLACE INTO fit_scores (jobId,score,reason,model,scoredAt) VALUES (@jobId,@score,@reason,@model,@scoredAt)');
db().transaction(() => { for (const r of rows) ins.run(r); })();
console.error('restored ' + rows.length);
"
```

Run both from the **repo root** — `lib/store.ts` resolves `process.cwd()`. If a snippet
grows past one clause, put it in a scratchpad `.ts` file instead and import by
**absolute** path: relative imports resolve from the file, not the cwd.

## Step 5 — Price it, then spend

```bash
npm run rescore                 # dry run: nothing is deleted
```

It reports jobs in scope, how many stored scores `--yes` would delete, how many clear the
prefilter threshold (**that number is the LLM call count**), how many get a free prefilter
verdict, and the per-family breakdown under the current config. The prefilter is free, so
the bill is knowable before spending a cent — say the number out loud before proceeding.

```bash
npm run rescore -- --yes            # clear only; `npm run fetch` picks them up later
npm run rescore -- --yes --score    # clear and score now (needs ANTHROPIC_API_KEY)
```

`--include-closed` also re-scores delisted jobs. Don't: you cannot apply to them, so it is
pure spend.

Watch the tail of the `--score` run. It prints `Scored N (LLM attempted A, failed F)`.
**`failed` must be near zero.** Failures fall back to the prefilter score rather than
throwing, so a totally broken run still writes a full set of rows — the script exits 1
only when *every* call failed. A run that is 60% failures exits 0 and looks fine while
most of the queue is keyword noise tagged `FALLBACK_MODEL`.

## Step 5b — If the run dies partway, DO NOT re-run rescore

This is the expensive mistake. A scoring run can stop mid-flight — an expired key, a rate
limit, an exhausted credit balance. On 2026-08-27 one died 259 calls into 374 and every
one of the 50 jobs showing 70+ was a `prefilter-fallback` artifact, not a real score.

**A half-scored queue is worse than an unscored one.** Fallback rows keep their keyword
prefilter score, and those run *higher* than honest LLM scores — so the artifacts sort
straight to the top of the queue and the dashboard confidently shows you noise.

Three entry points score, and **only one of them resumes**:

| command | what it does | use to finish a dead run? |
|---|---|---|
| `npm run fetch` | hits every board first, then scores | no — pulls in new jobs and bills for them |
| `npm run rescore -- --yes --score` | **CLEARS every stored score**, then re-scores all | never — re-spends on the whole queue |
| `npm run score` | scores only what is still outstanding | **yes** |

```bash
npm run score -- --dry-run   # prices exactly the calls still owed; no key needed
npm run score                # does them
```

`unscoredJobs()` re-queues never-scored rows *and* `FALLBACK_MODEL` retries, so this picks
up precisely where the run stopped. Foreign-bucket jobs are dropped before any spend.

Then confirm no artifacts survived — this must return 0:

```bash
sqlite3 data/jobsearch.db "select count(*) from fit_scores where model='prefilter-fallback';"
```

Back up first if the run cleared scores (Step 4): `sqlite3 data/jobsearch.db ".backup 'data/jobsearch.db.bak-$(date +%Y%m%d-%H%M%S)'"`.

**Pricing note.** Trust `npm run score -- --dry-run` and the current `rescore` dry run, but
know why: until 2026-08-28 `rescore` priced with the prefilter alone while `scoreUnscored`
also drops foreign-country jobs, so it quoted **570 calls for a run that made 380** — 50%
high, over-billing by exactly the 190 open foreign jobs above the threshold. Both now share
`planScoring()` in `lib/fit.ts`. If you ever see the quote and the run disagree again, that
single selection function is what broke.

## Step 6 — Verify against the user's actual complaint

Not "did it run" — **did the thing they asked for happen**. Measure the same view they
look at (the dashboard defaults to `minFit=50`, `status=new`, 50 rows):

```bash
npx tsx -e "
import { listJobs, countJobs } from './lib/store';
const page = listJobs({ minFit: 50, status: 'new', limit: 50 });
const by = new Map();
page.forEach((j, i) => { if (!by.has(j.category)) by.set(j.category, i + 1); });
console.log('first row per family:', Object.fromEntries(by));
console.log('page-1 counts:', page.reduce((m, j) => (m[j.category] = (m[j.category] ?? 0) + 1, m), {}));
console.log('at 70+:', countJobs({ minFit: 70 }));
"
```

Report the movement concretely — "the first software engineering role went from #18 to #2,
and page 1 went from 6 to 22 of 50" is an answer; "re-scored successfully" is not.

Then confirm the **old targeting's fingerprint is gone**. Two things this query must get
right, both learned the hard way:

```bash
npx tsx -e "
import { db } from './lib/store';
const rows = db().prepare(\`SELECT substr(f.reason,1,160) r FROM fit_scores f
  JOIN jobs j ON j.id = f.jobId
  WHERE j.closedAt IS NULL
    AND (f.reason LIKE '%avoiding test%' OR f.reason LIKE '%avoiding SDET%'
      OR f.reason LIKE '%avoiding QA%')\`).all();
console.log(rows.length); console.log(rows.slice(0, 5));
"
```

- **Join to `jobs` and filter `closedAt IS NULL`.** `rescore` deliberately skips closed
  listings, so their scores keep the *old* targeting's reasoning forever. Querying
  `fit_scores` alone on 2026-08-27 returned 82 hits that looked like a failed re-score;
  11 were closed rows dating from two days earlier and 71 were fresh. Splitting by
  `closedAt` is what separated "the re-score didn't take" from "working as designed".
- **Make the predicate specific.** A bare `LIKE '%avoid%'` also matches the *current*
  deprioritize list ("actively avoiding junior/entry-level roles") and mentions of a
  family as *experience* rather than as something dodged — a false positive that cost a
  detour the same day. Match the phrasing the retired config actually produced.

Expect **0**. Read any survivors rather than just counting them, and quote one when
reporting.

Finally, if the UI or store changed:

```bash
npm run verify && npm run build
```

Route count must stay at 8 (`/`, `/jobs/[id]`, five `/api/*`), and the build must emit
**zero** warnings — a non-literal `path.join` in `lib/` makes turbopack trace the entire
project into the server bundle, and that only ever shows up here.
