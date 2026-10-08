<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Job Search Copilot — project conventions

Single all-TypeScript Next.js app. Pipeline runs in API routes + a CLI script;
data in SQLite (`better-sqlite3`); LLM work via `@anthropic-ai/sdk`. See `README.md`.

## Architecture map
- `lib/types.ts` — domain types (`Job`, `SourceResult`, `FitScore`, `Application`, `ResumeVersion`,
  `JobWithMeta`/`JobListItem`, `APPLICATION_STATUSES`).
- `lib/store.ts` — SQLite + the `MIGRATIONS` array (append-only; never edit a shipped step).
  `makeJobId(title, company, location)` is the cross-source dedup key; `scopeKey` is the
  delisting key. **Stored open rows are legitimately fewer than a board's live posting count**,
  because that key also collapses duplicate reqs a company opened at the same title+location
  (Datadog: 451 live → 429 distinct → 429 stored, on 2026-08-25). Verify the gap with a
  `makeJobId` count over the live payload before treating it as dropped jobs. `dbFile()` honours `JOB_COPILOT_DB`, which is how tests avoid the real queue.
  `registerDerivedFns` exposes `lib/categories.ts` and `lib/locations.ts` to SQL as
  `job_category()` / `job_category_weight()` / `job_country()` / `job_location_weight()`, so the
  filter, the ranking and the UI chip all run **one** classifier — a generated `CASE ... LIKE`
  would have been a second implementation with no word boundaries. `job_country` takes the
  **source** as well as the location, because some feeds are country-scoped by construction.
  `ListOpts.q` searches title/company/location with the LIKE metacharacters escaped; `%` typed
  into the search box must not match the whole queue.
- `lib/sources/*.ts` — one adapter per job board; each returns `SourceResult` (`{jobs, scopes}`),
  **not** `Job[]`. See the `add-source` skill for the scopes contract. `remoteok.ts` takes the
  profile and filters at the adapter (see below); it is the only one that does.
- `lib/pipeline.ts` — `fetchAllSources` wires the adapters; `runPipeline` = fetch → upsert →
  close delisted → prune → score.
- `lib/fit.ts` — free keyword `prefilterScore`, then LLM `scoreUnscored` on survivors via `mapPool`.
  `scoreUnscored` drops `foreign`-bucket jobs BEFORE the split, so no LLM call is spent on a
  country the profile rules out; they stay unscored rather than getting a fake 0.
- `lib/categories.ts` — role families (`swe`/`devops`/`sdet`/`other`) derived from the title, plus
  the preference `weight` that ranks them. Nothing is stored: retuning the patterns re-classifies
  the whole queue with no migration. `activeCategories()` falls back to the built-in defaults
  **only** on `MissingProfileError`, since `profile/` is gitignored and absent in CI.
  `matchesTitle` is now a re-export of `lib/match.ts`.
- `lib/match.ts` — `matchesTerm(text, pattern)`, the ONE term matcher, shared by categories and
  locations. Boundary-anchored and asymmetric on purpose: single-word patterns need a closing
  boundary (so `qa` misses "Qatar" and `us` misses "usa", the `intern`/`internal` bug again),
  multi-word ones do not (so `software engineer` still catches "Software Engineering"). The
  boundary is "not alphanumeric", not `\b`, which is defined on `[A-Za-z0-9_]` and misplaces the
  edge on `c++`, `ci/cd`, `node.js`. Reimplementing this instead of importing it is the mistake
  it exists to prevent.
- `lib/locations.ts` — countries derived from the free-text `location`, same shape and same
  reasons as `lib/categories.ts`: nothing stored, so retuning re-classifies the whole queue.
  `locationBucket()` answers `allowed`/`foreign`/`unknown` and `unknown` is a **real third
  answer**, never a synonym for foreign — 316 of the queue's rows say only "Hybrid",
  "Distributed", "In-Office" or "N/A", and they are domestic employers with a sloppy field.
  `SOURCE_SCOPE` resolves a country-scoped feed's uninformative string by its source and is
  checked THIRD, after the pattern table, so a real foreign city still wins. `activeCountries()`
  mirrors `activeCategories()`, including the `MissingProfileError` fallback.
- `lib/pool.ts` — `mapPool`: bounded concurrency over a shared cursor (not fixed chunks).
- `lib/tailor.ts` — resume tailoring. `tailorDescription(job)` is the pure (no-DB) core used by
  both the CLI and `tailorForJob(jobId)`; point new callers at the pure one.
- `lib/cover.ts` — `draftCoverLetter(job)`, same no-fabrication guardrail as tailoring.
- `lib/verify.ts` — `verifyAgainstBase(tailored, base, mentionable?)`: deterministic (no LLM)
  check that a generated document invents no employer, date, metric, or **skill** absent from
  the master résumé. Employers are read from headings *and* from prose ("At Netflix I…"), because
  a cover letter has no headings and so verified clean while claiming an invented employer.
  `mentionable` suppresses the company being applied to. **`checked === 0` is reported as "not a
  pass", never a ✓** — a document with nothing checkable must not look like a verified one.
- `lib/gaps.ts` — skills-gap analysis. `VOCAB` entries carry an optional *résumé-side* pattern,
  because `\bsql\b` does not match "PostgreSQL" and reported a gap that wasn't real.
- `lib/html.ts` — `htmlToText`: decode → strip tags → decode again. `cleanField` for short fields.
- `lib/money.ts` — `formatSalaryRange`, so every adapter renders pay the same way.
- `lib/docx-package.ts` — `normalizeDocxPackage`: rewrites the archive `docx` produces so
  `[Content_Types].xml` is the first entry and no bare directory records remain. Word and
  `dump-docx` are both lenient about that layout, so it tests clean everywhere in-repo —
  **Indeed rejected a résumé outright with "Unable to read this file" until it was repacked**
  (2026-08-27), same `word/document.xml` bytes either way. `scripts/to-docx.ts` pipes every
  `Packer.toBuffer` through it. Note `createFolders: false` on the JSZip write: without it
  JSZip re-adds the very directory entries being removed.
- `lib/docx-render.ts` — `renderResumeDocx(md)` plus the `S` style spec. The ONE renderer,
  shared by `scripts/to-docx.ts` and `/api/jobs/[id]/docx`.
- `lib/paths.ts` — the `resumes/` layout (`docxPathFor`, `resumeMdPathFor`, `answersMdPathFor`,
  `fileSlug`). Segments are literal — see the turbopack note under `readProfileFile`.
  **All three take the job and name the file `<Company>-<Title>-<Location>-<id8>`.** Company+title
  alone gave two distinct jobs ONE filename, so tailoring the second overwrote the first's file in
  place; job A then read job B's résumé back through its own still-valid artifact row, flagged
  `diverged` as though a human had reviewed it. Reproduced 2026-09-03 — 223 company+title groups
  in a 3313-row queue hold more than one job, and the `.docx` collided too, which is the file
  actually sent.
  **A slug is lossy, so location alone was not enough.** `fileSlug` collapses every run of
  non-alphanumerics to one dash, truncates each segment at 60 characters, and the segments are
  joined with that same dash — so distinct jobs still shared a name three ways: punctuation
  variants ("Solutions Consultant | Enterprise" vs ", Enterprise"), titles agreeing for 60
  characters, and text straddling a dash differently. Adding location took the real queue from
  223 colliding groups to **7 colliding paths over 3313 jobs**; the 8-char job-id suffix took it
  to **0**, measured both ways. The id is the hash of exactly the three fields the stem renders,
  so it restores precisely what slugging discarded. `--out` still names a file anything you like.
  Files written under an older scheme keep working: reads go through the artifact row, which
  records where a file actually is.
- `lib/resume-source.ts` — `resolveResumeMarkdown(job)`: the ONE answer to "which Markdown is
  this job's current résumé". Prefers the on-disk `.md` over the `resume_versions` row, because
  the file is the copy a human last reviewed. **It finds that file through the job's own
  `resume-md` artifact row, NEVER by recomputing the path** — the path omitted location while
  `makeJobId` includes it, so 208 of the queue's 2764 résumé paths were shared by two or more job
  ids (measured 2026-08-28); resolving by path would hand job A job B's résumé, flagged
  `diverged` as though a human had reviewed it. `lib/paths.ts` now keys the filename on location
  too, so new files no longer collide at the source — but resolve through the row anyway: rows
  are per-job by construction, so this cannot regress if the naming changes again, and files
  written under the old scheme stay findable. `resolveResumeMarkdown(job, artifacts?)` and
  `commitResumeEdit(job, resolved?)` both take the work a caller has already done, so the detail
  route lists artifacts once and `to-docx.ts` resolves once.
  **`warning` is on BOTH branches of the union and every consumer reads it.** It says a file was
  found and rejected — empty, or unreadable. It reached only the CLI at first, so the dashboard
  silently served the stale row; the same "one reader notices, the others don't" split this
  resolver exists to close. On the `.docx` route it ships as `x-resume-warning`,
  **percent-encoded**: a header value is latin-1 and the message carries an em dash, so assigning
  it raw throws in the `Response` constructor and 500s the whole download. A rejected file that
  is merely GONE is not warned about — `saveArtifact` never dedupes and rows dangle routinely. `diverged` compares BODIES with
  the wrapper heading stripped (via `isTailoredHeading`, shared with the renderer) and BOM/CRLF/
  trailing-space/NFC normalized, so a resave is not an edit. An empty file is treated as
  corruption and falls back to the row rather than rendering a blank document.
  `commitResumeEdit(job)` writes an edited file back as a NEW version — called by `to-docx.ts`
  when it renders, so the row catches up and `resume_versions` stays history instead of freezing
  at the pre-review draft. It is deliberately NOT called on a GET.
- `lib/env.ts` — `loadLocalEnv()`/`requireEnv()`. **Every CLI entry point that reads
  `process.env` must call one.**
- `lib/outfile.ts` — `writeOutput(path, data)`: mkdir -p then write. Every script that has an
  `--out` uses it, because `resumes/` is gitignored and so absent from a fresh clone — a bare
  `writeFileSync` would ENOENT *after* the LLM call that produced the résumé.
- `scripts/` — `fetch.ts` (pipeline CLI), `tailor.ts` (JD → résumé md), `to-docx.ts` (md →
  `.docx`, pure-JS `docx`, no pandoc/LibreOffice), `dump-docx.ts` (inspect a `.docx`),
  `check-resume.ts` (fabrication check, exits 1), `gap-report.ts`, `cover-letter.ts`,
  `digest.ts` (daily standup; DB-only, no API key), `rescore.ts` (expire stored fit scores after
  a targeting change; dry-run by default, needs `--yes`), `score.ts` (score what is still
  unscored — no fetch, no clearing; `--dry-run` prices it first).
- **Three entry points score, and only one of them resumes.** `fetch.ts` hits every board before
  scoring, so finishing a stranded run also pulls in new jobs and bills for them; `rescore.ts
  --score` is welded to `--yes`, which CLEARS every stored score and re-spends on the whole
  queue. `score.ts` does exactly the calls still owed, because `unscoredJobs()` re-queues
  never-scored rows and `FALLBACK_MODEL` retries. Reach for it whenever a run dies partway —
  a half-scored queue is worse than an unscored one, since fallback rows keep their keyword
  prefilter score and that OUTRANKS real fit scores. On 2026-08-27 a credit balance ran out
  259 calls into 374 and all 50 jobs at 70+ were prefilter artifacts, not one real score.
- **`lib/fit.ts` `planScoring(jobs, profile)` is the ONE scoring-selection implementation**, used
  by `scoreUnscored` to run and by `rescore.ts`/`score.ts` to price. It was two implementations
  until 2026-08-28, and the quote was wrong: rescore filtered on the prefilter alone and so
  priced 570 LLM calls for a run that would make 380, over-billing by exactly the 190 open
  foreign jobs that clear the threshold. A preview that can disagree with the run it previews is
  worse than no preview.
- `tests/` — split by what a test is allowed to touch, one directory per kind:
  - `tests/unit/` — pure logic and single functions. No SQLite, no subprocess. (102 tests)
  - `tests/integration/` — anything that opens the database or spawns a process: the API route
    handlers, `lib/store`, the migration ladder, the source adapters (they set
    `JOB_COPILOT_DB`, so they are not unit tests however pure the parsing looks), and the CLI
    tests that shell out. (96 tests)
  - `tests/ui/` — Playwright browser specs. See below.

  `npm test` = `test:unit` + `test:integration`, each globbing its directory **explicitly**.
  Not `tests/**`: the shell only expands `**` with globstar enabled, and an unexpanded glob
  runs zero files while still exiting 0. A new category means a new script, on purpose.
  No new deps in `unit`/`integration` — Playwright belongs to `tests/ui` alone.
  CI runs typecheck/lint/format/test **without** an API key, so nothing there may require one;
  the `e2e` job is separate and equally keyless — the one spec that would need a key stubs
  `/api/tailor` at the network layer.

  Three traps:
  **`spawnSync`, never `execFileSync`, to test a CLI's exit code.** `execFileSync` *returns
  stdout* and reports failure by throwing, so on the success path there is no status to read —
  it comes back `undefined` and the test fails for a reason that has nothing to do with the
  code under test. `spawnSync` returns `{status, stdout, stderr}`; see
  `tests/integration/to-docx-artifact.test.ts`, where this cost two green tests an hour.
  **No top-level `await` in a test file.** tsx transforms to CJS, and esbuild rejects it
  outright: `Top-level await is currently not supported with the "cjs" output format`. Use
  static imports — `lib/store.ts` resolves `JOB_COPILOT_DB` lazily on first connection, so
  setting `process.env.JOB_COPILOT_DB` at module top still lands before any DB call.
  **Test lookups with TWO similar entities, never one.** Anything that maps an identity to a
  resource has to be exercised with two identities that are *nearly* the same, because the
  whole failure mode is one being served for the other. `resolveResumeMarkdown` shipped keyed
  on `resumeMdPathFor(company, title)`, which omits the location `makeJobId` includes; the
  tests, the mutation runs and a live end-to-end check all passed because every one of them
  used a single job. 208 of the queue's 2764 résumé paths are shared by two or more job ids.
  A one-instance test confirms the happy path harder and harder and cannot see this class at
  all — `tests/integration/resume-source.test.ts` now seeds two jobs differing only in
  location.
  **Two similar entities is not enough if the fixture dodges the real code path.** That
  two-job test passed against the collision it was written for and still missed it, because
  its helper wrote each file to a `randomUUID()` path — so it exercised the RESOLVER while the
  bug lived in the WRITER. A fixture that hand-places its inputs proves nothing about where
  production puts them. `tests/integration/resume-source.test.ts` now also drives the real
  `resumeMdPathFor` write, and `tests/unit/paths.test.ts` guards the builders directly; both
  were confirmed to go red with the location segment removed.
  **A flaky test is a finding; never re-run until green.** The resume-source suite failed
  about half its runs and the cause was real: `latestResume` ordered by `createdAt DESC`
  alone, an ISO string at millisecond precision, so two versions written in the same
  millisecond had undefined order and "latest" could return the PRE-REVIEW draft. Fixed with
  a `rowid DESC` tiebreak. Re-running it to a green would have shipped that.
  **A test that shells out resolves the repo root from its own file.** Two do it with
  `path.resolve(import.meta.dirname, "../..")`, and moving a test one directory deeper silently
  re-points that at `tests/` — the CLI then fails with `Cannot find module .../tests/scripts/…`,
  which reads like a missing script rather than a moved test. Re-check that constant on any
  reorganisation.
- `tests/ui/` — Playwright browser specs (`npm run test:e2e`). They cover the one thing the
  node:test suites structurally cannot: whether the pages actually RENDER. The
  stuck-"Loading…" bug shipped green through typecheck, lint and all 165 node tests that
  existed at the time.
  **Page Object Model.** Selectors and interactions live in `tests/ui/pages/*.page.ts`; specs
  hold the assertions and nothing else. A page object that asserts hides *what* is being
  checked behind a method name, and the failure then reads "checkQueue failed" instead of
  naming the missing element.
  **Two runners share this tree, so the split has to be airtight both ways** — node:test globs
  `tests/unit` and `tests/integration` by explicit directory, and Playwright is confined by
  `testDir: tests/ui` plus a `.spec.ts` `testMatch`. That match is also what keeps `seed.ts`
  and `pages/*.page.ts` from being collected: a helper picked up as a spec is an empty suite
  that reports success.
  `tests/ui/seed.ts` builds a fixed fixture DB and `playwright.config.ts` points
  `JOB_COPILOT_DB` at it, so a run never reads the real queue and no assertion can pass because
  the developer happens to have a matching job. The web server is `next build && next start` on
  **port 3100**, deliberately: `next dev` regenerates the agent-file block in this file on boot
  (a test run must not dirty the tree), and :3000 is the developer's own server pointed at the
  REAL database — hence `reuseExistingServer: false`.
- **A render test that beats the bug to the assertion is not a test.** The stuck-"Loading…"
  regression spec passed cleanly against a deliberately re-broken build: it asserted at ~140ms
  and the offending timer fires at `SEARCH_DEBOUNCE_MS` (250ms), so it raced the bug and won.
  It only became a real check after a `waitForTimeout(800)` — the one place a fixed wait is
  correct rather than a smell, because the thing under test IS a timer. Re-break the code and
  watch the spec go red before believing any timing-dependent assertion here.
  **Every `toHaveCount(0)` after a filter change needs `settle()` first.** Changing a filter
  clears the list while it refetches, so an absence assertion is satisfied by the transient empty
  state and passes whatever the filter does. Measured 2026-09-03: with the `minFit` parameter
  stubbed to `undefined` and with `q` stubbed to match every row, the min-fit and both search
  specs still passed — three false greens that had been in the suite the whole time. The shape
  that works is `setFilter(...)` → `settle()` → `expect(loading).toHaveCount(0)` → assert
  absence, then assert a row that must REMAIN. Prove it by stubbing the filter out and watching
  it go red; a filter spec that cannot fail is worse than none, because it certifies the filter.
- `profile/profile.toml` — targeting + per-source company lists. `match.countries` is REQUIRED
  with no default. `profile/resume_base.md` — master
  resume. Both gitignored; the committed `*.example.*` files are what a fresh clone gets, so any
  new config section has to be added to both.
- `resumes/` — every generated per-application file. Layout is split by what the file IS FOR,
  and `lib/paths.ts` is the only place that decides it:
  `resumes/` holds the `.docx` you actually send; `resumes/markdown/` holds the `.md` sources
  (tailored résumé and its `-answers.md`). The base directory is then exactly the set of
  sendable documents, rather than those interleaved with PREP-ONLY answers files. Saved JDs
  (`.txt`) stay at the base. Gitignored whole — the subdirectory included — and created on
  demand by `writeOutput`; nothing generated goes in the repo root any more.

## Conventions that must hold
- **Models are chosen per job, not per price** (`lib/anthropic.ts`). Both `scoring` and
  `tailoring` are `claude-sonnet-5` as of 2026-08-27; they stay separate constants because they
  answer to different pressures, so re-point one without assuming the other follows. Scoring ran
  on `claude-haiku-4-5` until then, and why it moved is the part worth keeping: Haiku emitted a
  *band label wearing a 0-100 costume*. 578 stored scores held 20 distinct values, 8 of which
  covered 82% of them; the 90 jobs sitting on exactly 28 included a Data Analyst role, two TPM
  roles, a security detection-engineering role and a frontend role, each with the same templated
  sentence. That breaks the design downstream: `lib/categories.ts` weights are calibrated to an
  8-point gap, and a scorer quantized in ~7-10 point steps has no resolution at that granularity,
  so the preference knob was worth a full quality tier and ties were settled by whatever
  `ORDER BY` fell through to. **Don't move scoring back down a tier to save money** — a full
  re-score of the open queue is a few dollars once (`npm run rescore` prices it before spending),
  and a stored score is final until someone runs that, so a bad score costs more than the call
  that made it. Reach for `output_config.effort` first.
- **Sonnet 5 thinks by default; Haiku 4.5 did not.** Omitting `thinking` on Sonnet 5 runs
  adaptive thinking, and thinking tokens count against `max_tokens` — the scoring call's old
  `max_tokens: 256` truncates the JSON before it is written. It is now 2048 with
  `effort: "low"`. Any model change here means re-checking that cap, not just the model string.
- **Tailoring must never fabricate.** The `lib/tailor.ts` system prompt only re-emphasizes the
  real master resume — never invent skills, employers, dates, or metrics. Preserve that guardrail.
  The prompt is not the guarantee — `lib/verify.ts` is, so any claim kind the prompt forbids must
  actually be checked there. Skills were the gap: on 2026-08-25 a résumé listing Prometheus,
  Grafana and OpenTelemetry — the top three tools the queue demanded and the master résumé lacked
  — passed with a ✓. **Prove a new check can fail before trusting it:** the first version of that
  same skill check was vacuous, because support fell back to comparing bare digits and
  `"".includes("")` is `true`, so every word-shaped claim was auto-approved.
  That guard fixed the vacuous case but not the root one: **containment is not a support test.**
  On 2026-08-26 a review proved a fabricated `23%` verified clean because the base said
  `Mar 2023`, and a fabricated `Java` because the base said `TypeScript/JavaScript`. Support is
  now boundary-anchored (`appearsWholeIn`) and numeric support compares whole numbers, not
  substrings of a digit blob. The boundary is "not alphanumeric", not `\b` — `\b` is defined on
  `[A-Za-z0-9_]` and so misplaces the edge on `c++`, `ci/cd`, `node.js`.
- **No scraping LinkedIn/Indeed.** Use their listings only via aggregator APIs (JSearch). Every
  source must be a public/official API, not HTML scraping.
- **Never auto-submit applications.** This is an assisted-review tool by design.
- Source adapters must be resilient: wrap multi-target fetches in `Promise.allSettled` so one bad
  company/slug can't sink the run (see `greenhouse.ts`).
- **A source may only declare a delisting scope for a company it fully enumerated on a
  SUCCESSFUL fetch.** Search feeds (RemoteOK/JSearch/Adzuna/USAJobs) declare none. Getting this
  wrong silently closes live jobs. Sanity check: a second consecutive `npm run fetch` should
  report `Closed 0` — or a *single-digit* count that real churn explains. Boards do drop a
  posting mid-session (Datadog removed one inside a 13-second window on 2026-08-25). Confirm
  before assuming a bug: `curl` the board and check whether the id is genuinely gone. A scope
  bug shows up as *hundreds* closed, not one.
- **CLI scripts do not get `.env.local` for free.** Next.js loads it; bare `tsx` does not. Call
  `loadLocalEnv()` (or `requireEnv("ANTHROPIC_API_KEY")`) at the top of every script entry
  **that reads `process.env`**. `scripts/fetch.ts` lacked this and a full scored run wrote 480
  fake scores and exited 0. The rule stops there on purpose: `check-resume.ts` and `dump-docx.ts`
  read no env at all, which is why they run in keyless CI — stating the rule as "every entry
  point" made it false, and a rule that is visibly false stops being followed. `to-docx.ts` is
  the in-between case: it loads env only on the `--job-id` path, because that path reads the DB
  and `JOB_COPILOT_DB` can be set in `.env.local`.
- **The fit score answers one question; preference is a separate axis.** The score is "how well
  does the résumé match this posting" and nothing else — it is what `minFit` filters on and what
  the digest reports, so folding "which kind of role do I want" into it would leave neither
  answerable. Role preference lives in `lib/categories.ts` as a `weight` added in `store.ts`'s
  `RANK` expression, which moves `ORDER BY` **only**; the stored and displayed number is never
  adjusted. The weight is also NOT in the LLM prompt — applying it in both places would
  double-count it. The gap between two weights is the whole knob: swe(18) − devops(10) = 8 means
  a DevOps role must out-fit a software engineering one by more than 8 points to rank higher.
  Unscored rows stay at −1 rather than −1 + weight, or a never-scored job would leapfrog a job
  the scorer actually judged badly.
- **A stored LLM score is final, so a targeting change does not reach the existing queue.**
  `unscoredJobs` re-queues only never-scored rows and `FALLBACK_MODEL` ones, which is right while
  config is stable and wrong the moment `titles`/`keywords`/`deprioritize`/categories change:
  every stored score was computed against the targeting in force at the time, and the reasons
  quote it back ("explicitly avoiding test-focused roles aligns with this platform position").
  `npm run rescore` is the only thing that expires them — dry-run by default, and it prices the
  job first, since the prefilter is free and tells you the LLM call count before you spend.
- **Scoring failures fall back to the prefilter score rather than throwing**, so one job can't
  abandon a run. That makes total failure invisible unless counted: `scoreUnscored` returns
  `{scored, llmAttempted, llmFailed}` and the CLI exits 1 when all attempts failed. Fallback rows
  are tagged `FALLBACK_MODEL` and re-queued by `unscoredJobs`; a genuine below-threshold
  `"prefilter"` verdict is final and is not retried.
- **Country is a THIRD axis, and it hides rather than deletes.** The fit score answers "how well
  does the résumé match", the category weight answers "which kind of role do I want", and
  `lib/locations.ts` answers "could I take this job at all". Blending any two leaves neither
  answerable. Like the category weight, the location weight moves `ORDER BY` **only** — the stored
  and displayed score is never adjusted, and the weight is not in the LLM prompt. Weights are
  positive (`allowed` 20, `unknown` 8, `foreign` 0) so nothing can be pushed below the `-1` an
  unscored row pins at. Hiding happens in `buildWhere`, not in the data: `locations: "all"` brings
  every foreign row straight back with its real score.
- **`maxAgeDays` ("Seen") hides listings no source has returned lately, and it is the only
  handle on a stale search-feed row.** JSearch/RemoteOK/Adzuna/USAJobs declare no scopes, so
  `markDelisted` can never close one and a dead posting stays `closedAt IS NULL` forever. It
  filters on `j.lastSeenAt`; `firstSeenDays` is the different question ("new since Friday") and
  keys off `fetchedAt`, which the upsert deliberately does not refresh. Default is `""` = any
  age, because a filter that hides open rows must not shrink the queue on first load with
  nothing on screen to explain it. Like every other filter it HIDES — nothing is deleted.
  **Day counts are clamped in `buildWhere`, not only at the route.** `new Date(NaN).toISOString()`
  throws RangeError, and so does any date beyond ~1e8 days from the epoch: `?maxAgeDays=abc` 500'd
  the whole queue, and after that was fixed `?maxAgeDays=1e9` reproduced it exactly — the first
  fix rejected the value that had been tried rather than the class. `sinceDaysAgo` clamps to
  `MAX_FILTER_DAYS`, which also covers `firstSeenDays` reaching it from `digest.ts --days`.
- **`unknown` must never be folded into `foreign`.** A wrong "foreign" hides a job you could have
  taken; a wrong "unknown" only fails to rank it up. 405 open rows were unplaceable on 2026-08-27
  and 316 of them were greenhouse rows reading "Hybrid"/"Distributed"/"In-Office"/"N/A" — targeted
  companies with an unfilled field. They stay in the queue.
- **"Anywhere" from JSearch is not anywhere.** `lib/sources/jsearch.ts:59` hardcodes `country=us`,
  so its 66 `"Anywhere"` rows are US remote jobs — and they are most of the top of the queue.
  `SOURCE_SCOPE` in `lib/locations.ts` is what keeps them. Do not "fix" the location string at the
  adapter: `makeJobId(title, company, location)` hashes it, so rewriting it orphans every row
  behind a new id. Classify the stored string, never rewrite it.
- **Seed the country patterns from the real queue, not from world geography.** The table covers the
  countries the feeds actually produce plus cities that appear BARE; ambiguous names are left out
  on purpose (`cambridge`, `birmingham`, `newcastle`, `victoria`, `kingston`, `san jose`, and `ca`,
  which is Canada's code and California's abbreviation in the same feed). Dump the distinct strings
  and bucket them before adding a pattern, and report how many you examined — "nothing was foreign"
  and "nothing was checked" look identical.
- **RemoteOK is filtered at the adapter, and that is deliberate.** It is a general job board, not a
  tech one, and the only source with no server-side query narrowing it: unfiltered it put 223 open
  rows in the queue — Fire Fighter, Specimen Collector, Accounts Receivable Clerk — and not one
  scored 70 or better. `fetchRemoteOk(profile)` keeps a row only when its title or `tags[]`
  intersects `match.titles`/`match.keywords`. A row dropped there costs no row, no LLM call and no
  queue space. Its `scopes: []` contract is unchanged and must stay that way — the adapter now
  drops rows itself, so an enumeration claim would be doubly wrong. A live fetch went 100 -> 3.
- **Keep filesystem paths in `lib/` statically analysable.** `readProfileFile` briefly joined a
  computed base directory instead of a literal `path.join(process.cwd(), "profile", name)`, and
  turbopack gave up on the static analysis and traced *the entire project* into the server
  bundle — a build warning reading "this leads to all source files being deployed as part of the
  server code". `npm run build` was clean at HEAD and warned after the change, which is the only
  reason it was caught; the env-var override now sits on its own branch so the ordinary path
  stays literal. `JOB_COPILOT_PROFILE_DIR` overrides the directory, mirroring `JOB_COPILOT_DB`,
  and pointing it at a nonexistent path is how tests force the built-in categories instead of
  whatever targeting the developer has configured locally.
- Board descriptions are often entity-ENCODED HTML — run them through `htmlToText` (`lib/html.ts`),
  which decodes entities *before* stripping tags.
- **Upgrade dependencies by name, never with `npm audit fix --force`.** The old rule here said
  `--force` downgrades `next` 16.2.10 → 9.3.3; that stopped being true, and on 2026-08-27 the
  dry run offered `next@16.3.3` — an *upgrade*. The rule stands for a different reason: `--force`
  moved `next` alone and would have left `eslint-config-next` stranded at the old version. Move
  the pair together and re-pin exact, because `npm install <pkg>@x` rewrites the range to `^x`:

      npm install next@<v> eslint-config-next@<v>   # then re-pin both to exact in package.json

  `next` and `eslint-config-next` are pinned exactly (no `^`), as is `prettier`. Verify an
  upgrade with `npm run verify && npm run build` and check the route list is unchanged — 9
  routes, `/` and `/jobs/[id]` plus six `/api/*` (the sixth is `/api/jobs/[id]/docx`).
- The audit was **clean as of 2026-08-27** at `next` 16.3.3. Before that, nine Next advisories
  were open and none were reachable here: this app has no `middleware.ts`, no `"use server"`,
  no `next/image`, no custom server, and an empty `next.config.ts`, and it only ever runs on
  localhost. Re-check reachability that way before treating an advisory as urgent.

## Adding a job source (recurring recipe)
1. **Verify slugs/endpoints live FIRST.** Board slugs guessed from company names are frequently
   wrong (e.g. `hashicorp`, `netlify`, `brex` all 404'd). `curl` the API for each candidate and keep
   only the ones that return jobs before putting them in `profile.toml`.
2. Write `lib/sources/<name>.ts` returning normalized `Job[]` (id via `makeJobId`, clean description
   via `htmlToText` if HTML, key-gated if paid). Mirror the `Promise.allSettled` shape.
3. Add its config block to `profile.ts` (zod schema) and `profile/profile.toml`.
4. Wire it into `fetchAllSources` in `lib/pipeline.ts` (guard on config/env presence).
5. Pin the response shape with a fixture test (stub `globalThis.fetch`, no new deps — see
   `tests/jsearch.test.ts`), then **mutate the adapter to prove each assertion can fail**.
   A published API changing shape is silent: JSearch moved to `{data:{jobs:[]}}` and the
   adapter returned zero jobs while the run still reported success.
6. Verify: `npx tsc --noEmit`, then `npx tsx scripts/fetch.ts --no-score` and check counts + that
   descriptions are clean plain text in the DB.

## Applying to one job (recurring recipe)
See the `apply-to-job` skill for the full walkthrough; `review-resume` audits the result
before it goes out. Short version:
1. Save the pasted JD to `resumes/jd-<company>-<role>.txt`. Everything for this application
   stays in `resumes/` — the directory is gitignored and is created on first write.
2. `npx tsx scripts/tailor.ts <jd file> --company … --title … --out resumes/markdown/tailored-<company>-<role>.md`
3. `npx tsx scripts/to-docx.ts resumes/markdown/tailored-<company>-<role>.md [--job-id <id>]` → formatted
   (or `npx tsx scripts/to-docx.ts --job-id <id>` alone / the **Download .docx** button, when
   the résumé was tailored in the UI)
   `.docx` to apply with. Pass `--job-id` when the job came from the queue: it logs the exact
   file against the job row, so "applied" can say what you attached rather than only that a
   résumé was generated. The job detail page lists them under **Files sent**.
4. `npm run check-resume -- resumes/markdown/tailored-<company>-<role>.md --company "<Company>"` — the
   content gate. Exits 1 on any employer, date, metric, or skill absent from the master
   résumé. `--company` stops the employer you're applying to being read as a job you held.
5. `npm run check-docx <out>.docx` before sending (exits 1 on a page break, a
   `FILL IN` placeholder, a drafted-answers heading, or salary text) — the Read tool can't
   render `.docx`, so this is the only way to see what you're actually handing over.
- **Résumé and drafted answers are separate files.** `scripts/tailor.ts` writes the résumé to
  `--out` and the answers to a sibling `-answers.md`, because `to-docx.ts` renders any
  `# Drafted answers` heading onto a second page — which is how `[FILL IN: your target
  number]` and salary posture end up in a document sent to an employer. Only convert the
  résumé file.
- **A `.docx` that opens in Word is not a `.docx` every parser accepts.** Job boards run
  strict OPC readers; ours renders through `normalizeDocxPackage` for that reason. Opening a
  generated file locally proves nothing about the readers that matter.
- **`to-docx.ts` is only a formatter** — it renders already-tailored content and never re-reads
  `profile/resume_base.md`. After editing the master résumé, re-run step 2 or the new content
  is silently missing from the `.docx`. Its one exception is `--job-id`, which opens the DB to
  do two things: record the written `.docx` in the `artifacts` table, and — when no `.md` is
  given — SOURCE the résumé via `lib/resume-source.ts` (the edited file on disk if this job has
  one, else `resume_versions`), committing an edited file back as a new version as it renders.
  Without the flag it touches neither env nor database.
- **`tailorForJob()` writes files as well as the row**, into `resumes/markdown/`: the résumé and
  a sibling `-answers.md`, each recorded in `artifacts`. It persisted ONLY to `resume_versions`
  until 2026-08-28, which left the dashboard path with no file to edit, diff or convert, and no
  route to a `.docx` at all. Two ways out of the DB now exist and both render `content` alone —
  the **Download .docx** button (`/api/jobs/[id]/docx`) and `to-docx.ts --job-id <id>` with no
  `.md`. `draftedAnswers` is its own column and is NEVER appended to either, the same separation
  `scripts/tailor.ts` keeps on disk.
- **Hand-editing a generated `.md` does NOT update `resume_versions` — so the FILE WINS.**
  `tailorForJob()` writes the row and the files together, so they start identical; then
  `review-resume` has you fix the `.md` and they diverge with nothing to announce it. Until
  2026-08-28 the two DB-sourced routes re-rendered the stale row, which is how a résumé that
  was reviewed and corrected got sent in its pre-review form (verified: after a bullet was cut
  from the reviewed file, it was still `PRESENT` in `latestResume().content`). Every route now
  resolves through **`lib/resume-source.ts`**, which prefers the on-disk `.md` and falls back to
  the row only when no file exists — including `/api/jobs/[id]`, so the page preview and the
  Copy button show the same text Download renders. Do NOT reintroduce a bare `latestResume().content` render —
  that is the bug. Note the row itself is still allowed to go stale; nothing writes edits back,
  so treat it as the fallback copy, not the truth. **`draftedAnswers` has no such resolver** —
  it is only ever read from the row, so an edited `-answers.md` and the dashboard's answers
  panel still drift apart.
- **`saveArtifact` is a plain INSERT with no dedupe**, so every re-render adds another row for
  the same path — one job accumulated 6 rows across 3 distinct paths on 2026-08-28. Rows also
  dangle when a file is moved or deleted, and **Files sent** will happily list a path that is
  no longer there. Filter on `existsSync` before trusting the list as a record of what was
  actually attached.
- **One renderer, in `lib/docx-render.ts`.** The button and the CLI both call
  `renderResumeDocx(md)`; `scripts/to-docx.ts` is now only argument handling and file writing.
  Two renderers would drift and only one of them would be the file you actually sent. Verified
  by unzipping both outputs: 17 of 18 archive entries identical, `word/document.xml` byte-for-byte
  — the lone diff is `docProps/core.xml`, which carries a timestamp and changes every run.
- `.docx` styling is matched to the user's résumé template; the spec lives in the `S` style
  constants at the top of `lib/docx-render.ts` (it moved out of `scripts/to-docx.ts` when the
  renderer was shared with the dashboard). `<w:b w:val="0"/>` means bold **off** —
  testing for element presence alone misreads every run as bold+italic. Job-title lines are
  **bold+italic on purpose** (2026-08-27, the user's call) where the reference template has
  them italic only; do not "restore" them to match the template.
- **Generated artifacts go in `resumes/`**, which is gitignored whole. The root-level
  **allowlist** stays as a backstop — every root-level `.md`/`.docx`/`.txt` is ignored except
  `README.md`, `AGENTS.md`, `CLAUDE.md` — because `--out` accepts any path and one stray
  `--out tailored.md` is a résumé carrying a phone number into a public repo. Filename patterns
  (`/tailored*.md`) were tried and leaked. Add new root-level source docs to the allowlist.

## Verification without an API key
Only fit scoring, tailoring, and cover letters need `ANTHROPIC_API_KEY`. Everything else runs
without one — and CI deliberately has no key, so keep it that way:

    npm run typecheck && npm run lint && npm run format:check && npm test && npm run build
    npm run verify                  # the full gate: typecheck + lint + format:check + test + e2e
    npm run verify:fast             # same minus the browser suite (no next build, no chromium)
    npm run format                  # prettier --write . (the only sanctioned way to reformat)
    npm run fetch:no-score          # real network, no LLM
    npm run gaps                    # DB only
    npm run digest                  # DB only
    npm run rescore                 # DB only (dry run); --yes clears, --score needs a key
    npm run score -- --dry-run      # DB only; prices the outstanding scoring work
    npm run check-resume -- <f>.md --company "<C>"   # fabrication gate; exits 1
    npm run check-docx <file>.docx  # the only way to see a .docx; Read can't render it
    npm run test:unit               # pure logic only
    npm run test:integration        # DB + subprocess
    npm run test:e2e                # Playwright; seeds its own fixture DB, no key, no real queue

**Formatting is prettier's job; eslint does none of it.** This reversed on 2026-08-27 — the
previous note here claimed eslint was the formatting gate, and it was measurably false:
`eslint.config.mjs` is eslint-config-next, which enforces correctness and Next conventions but
no layout at all. It passes a deliberately mangled file (`export const   probe = {a:1,   b:2,`)
with **exit 0**. Prove it the same way before trusting either gate.

Prettier is now a pinned-exact devDependency with `prettier.config.mjs`, and
`npm run format:check` runs in CI on every PR. Three things worth keeping:
- **`printWidth: 100` is measured, not a preference.** At prettier's default 80 the repo
  needed 44 of 59 files rewritten, at 120 it needed 43, at 100 it needed 36. Changing it
  re-churns the repo.
- **The version is pinned without `^` on purpose.** A prettier patch release that changes one
  layout decision turns every open PR red for reasons its author did not cause.
- **`*.md` is in `.prettierignore`.** Prettier reflows prose and would rewrite this file
  wholesale, burying content changes in wrapping churn.

The repo-wide reformat landed as its own isolated commit so review and `git blame
--ignore-rev` can skip it. Keep it that way: never mix a reformat into a behaviour change.

`check-resume` is the content gate and `check-docx` the format gate; they check disjoint
things, so passing one says nothing about the other. **"Nothing checkable found" from
`check-resume` is not a pass** — it means zero claims were examined.

Run `npx tsx -e "…"` against `lib/store.ts` **from the repo root** — `lib/profile.ts` and
`lib/store.ts` both resolve paths from `process.cwd()`, so another cwd fails or writes elsewhere.

**Quote SQL string literals with single quotes, and move the snippet to a file if it needs
both kinds.** SQLite reads a double-quoted string as an *identifier*, not a literal, so a
`-e "…"` snippet whose SQL also uses `"` fails with `no such column: "%avoid%"` — which
reads like a schema problem rather than a quoting one, and cost two detours on 2026-08-27.
The shell is the other half of the trap: escaping `\"` inside an outer `"…"` is what forces
the double quotes into the SQL in the first place. For anything longer than one clause,
write it to a `.ts` file and `npx tsx` that instead — single quotes then survive untouched
and the query stays readable.

**That file has to live INSIDE the repo, not in the scratchpad directory.** Node resolves
imports from the *script's* own directory upward, not from `process.cwd()`, so a probe under
`/tmp/…/scratchpad` sees no `node_modules`: both `import { db } from "./lib/store"` and
`import JSZip from "jszip"` fail with `MODULE_NOT_FOUND` even when `tsx` is launched from the
repo root. Write it at the repo root as `<name>.probe.ts` — `/*.probe.ts` is gitignored for
exactly this, so forgetting to delete one is harmless rather than a commit — and note an
absolute import path fixes the `./lib/store` error but not the `jszip` one. And **no top-level `await`**:
the rule AGENTS.md states for test files is really a rule for anything `tsx` runs, since the
CJS transform rejects it outright — wrap the body in `async function main() { … } main()`.

When checking generated output against a reference, don't run the same predicate over both
sides — dump the raw bytes/XML for one side, or use a positive control whose answer you already
know. A grep that returns 0 for every term usually means the grep is wrong, not that the file is.

**Before changing what a shared concept RESOLVES TO, enumerate everything that asks it.**
`grep -rn` the concept and list every consumer before editing any of them; changing the answer
in some callers and not others is worse than not changing it, because the UI and the document
then disagree about what "the current résumé" is. `lib/resume-source.ts` was wired into the two
`.docx` routes while `/api/jobs/[id]` kept a bare `latestResume()`, so the page preview and the
Copy button showed the pre-review draft while Download rendered the reviewed file — the exact
bug the resolver exists to prevent, one door over, and it was introduced in the same commit
that documented the rule against it.

**A documentation claim is an executable assertion.** If a line here says a file is gitignored,
a command exits 1, or a path exists, run it before writing it. `/*.probe.ts` is in `.gitignore`
today only because the sentence claiming it was checked; it was false when written.
