---
name: review-resume
description: Audit a tailored résumé for embellishments, filler, and formatting drift before applying. Use when the user asks to review/check/sanity-check a résumé or .docx, or asks whether it contains exaggerations. Fact-checks the tailored version against profile/resume_base.md, runs a hiring-manager pass against the job description, and verifies the built .docx. Use this instead of /scrutinize, which only reviews code diffs.
---

# Review a résumé before applying

`/scrutinize` reviews *code changed in a git branch* — pointing it at a résumé gets you a
review of `to-docx.ts`, not of the document. Use this instead.

Three passes, all cheap relative to sending out a bad résumé.

## Inputs

Generated application files live under `resumes/`, split by what each file is FOR —
`lib/paths.ts` is the only thing that decides: `resumes/` holds the sendable `.docx`,
`resumes/markdown/` holds the `.md` sources. All of it is gitignored except the master.

- The tailored résumé `resumes/markdown/*.md` — what's actually being sent.
- Its sibling `resumes/markdown/*-answers.md` — PREP ONLY, but it is still a document full
  of claims. See Pass 1a.
- `profile/resume_base.md` — **ground truth**. The tailored version may reorder, reword, and
  re-emphasize; it may not claim anything this file doesn't support.
- The job description. Usually `resumes/jd-*.txt`, but **there is not always a file** — when
  the job came from the queue rather than a paste, the JD is the `description` column in
  SQLite and that is the only copy. Read it with `getJobWithMeta(<id>)`.
- The built `.docx` in `resumes/`, if one exists.

If the résumé isn't where you expect, check the repo root before assuming it doesn't exist:
`--out` accepts any path, and the root-level gitignore allowlist hides strays rather than
rejecting them.

## Pass 1 — Fact-check against the master (the one that matters)

### 1a — Run the deterministic check first

```bash
npm run check-resume -- <tailored>.md --company "<Company>"
```

`lib/verify.ts` does the mechanical half of this pass with no LLM call and no network:
every employer (read from headings **and** from running prose), year, metric, and
skills-line entry in the output must also appear in `profile/resume_base.md`. It exits 1
when one doesn't. Clear whatever it reports before spending attention anywhere else — and
read its verdict carefully: **"Nothing checkable found" is not a pass.** It means zero
claims were examined, which is what a heading-free document produces.

A flag is not an accusation. Half the time the master résumé is simply missing something
real, and the fix belongs there rather than in the tailored copy.

**Run the gate on the answers file too.** It is a second document carrying the same class of
claim and nothing else checks it:

```bash
npm run check-resume -- resumes/markdown/<name>-answers.md --company "<Company>"
```

Expect more noise than on the résumé — it is prose, not headings — so read it as a prompt to
eyeball rather than a hard gate. On 2026-08-28 the résumé passed clean at 63 claims while the
answers file said "worked **directly with** a Performance Engineering manager" against a
master that says "worked **under**": peer vs. observed, in the document you speak from. The
answers get said out loud in an interview, which makes them no safer than the résumé.

**And prove the gate can fail before trusting a pass.** A clean run means something only if
a planted claim comes back red — copy the file, add a tool the JD names but the master
lacks, and confirm it exits 1. Check the `checked` count in the verdict while you are there:
"Nothing checkable found" is zero claims examined, not a pass.

### 1b — Then read for what a checker structurally cannot see

Everything the tool catches introduces a **new token**. Everything below is assembled from
vocabulary the master already contains, which is exactly why it verifies clean — and why
this pass still has to happen by eye. Go line by line; every one of these has shipped:

| Pattern | Real example caught |
|---|---|
| Singular → plural | "building load-testing **proof-of-concepts** with k6" — there was one, and the résumé's own bullet said "a k6 proof-of-concept" three lines later |
| Verb upgrade | master "worked **under** the Performance Engineering manager" → tailored "working directly **alongside**" (under = observed; alongside = peer) |
| Summary claim no bullet supports | "using Kibana/OpenSearch **to investigate failures and root-cause issues**" — those tools appeared only in the skills list, never in a bullet |
| Invented skill category | one POC promoted to a headline "**Performance & Load Testing**" section with a made-up practice area, "load/performance test POC design" |
| Tool mis-categorized | Vault (secrets management) filed under "Observability & Log Analysis" |
| Narrow claim broadened | master "the unpublished **absorption constant**" → tailored "absorption/**elimination** parameters" |
| JD word sprayed across bullets, each site individually defensible | "scalability" imported into **5** places at once (summary, an exposure bullet, the k6 bullet, two Datto bullets). The master uses the word once, about CI environments, and never as *scalability testing*. `verify.ts` cannot flag it — the token exists in the master, which is exactly the "assembled from existing vocabulary" case. Grep the JD's distinctive nouns against the master before believing any of them |
| Skills-line entry that restates one bullet as a practice area | `**Performance & Scalability Testing:** k6, load/performance testing, service-level validation, pytest-xdist parallelization` — `k6` and `load/performance testing` are the *same single POC* counted twice, and `pytest-xdist parallelization` is test-suite throughput, not performance testing of the system |
| Category label overreaches its list | master `**Log Analysis:** Kibana, OpenSearch` → tailored `**Observability / Log Analysis:**` over the *same two tools*. No tool was invented, so nothing is flagged; but "Observability" promises metrics, tracing and SLOs to an SRE screener, and only log search is behind it |

Category labels are deliberately left unchecked by `verify.ts` — flagging every heading
reword would bury the real findings in noise. That trade-off is what makes the last row
above your job, not the tool's.

For each finding report: the exact quote, what the master actually says, why it overstates,
and a rewrite in the same style and length. **Don't flag ordinary rephrasing** that keeps the
factual claim intact — reordering bullets and re-emphasizing toward the JD is the whole point.

Rank by how likely it is to blow up in a technical interview. A mis-categorized tool a
screener will notice beats a slightly warm adjective.

## Pass 2 — Hiring-manager read against the JD

- **Which bullets are accomplishments vs. filler?** Filler describes responsibility or org
  structure instead of outcome. "Supported production deployments and performed regression
  testing" is a job description, not an achievement.
- **Is the strongest thing first?** The most recent role's first bullet gets the most
  attention. Leading it with "Worked under the Performance Engineering manager, gaining
  hands-on exposure to…" spends that slot admitting inexperience.
- **Is bullet count balanced against tenure?** An 8-month stint with 8 bullets next to a
  15-month senior role with 3 reads as padding a thin tenure.
- **Are the JD's hard requirements addressed or silently skipped?** Name gaps plainly.
  Requirements the résumé can't meet should be handled in the prep answers, not papered over.
- **Anything that shouldn't go to an employer at all?**

## Pass 3 — Verify the built .docx

The Read tool can't render `.docx`. Never approve one you haven't dumped.

```bash
npm run check-docx <file>.docx                       # placeholders, page breaks, salary — exits 1
npm run dump-docx <old>.docx -- --diff <new>.docx    # formatting drift after an edit
```

`check-docx` is the gate; bare `dump-docx` prints formatting and always exits 0. Use the
first to decide whether to send, the second to explain what changed.

Per the user's global convention: **don't run the same predicate over both sides** of a
comparison. A bug in a shared parser confirms itself and reports a perfect match while both
readings are wrong. Anchor one side to raw bytes — dump the actual XML and read it, or
validate the parser against a file whose answer you already know.

## Applying the fixes

Fix the tailored `.md`, then re-render — `to-docx.ts` is only a formatter and never re-reads
`profile/resume_base.md`.

**Every route renders your edited file — but the stored row still goes stale.** Editing the
`.md` does not write back to `resume_versions`. Since 2026-08-28 that no longer decides what
gets sent: `lib/resume-source.ts` resolves the file first for all three routes, so rendering
by path, `--job-id` alone, and the dashboard's **Download .docx** all agree.

```bash
npx tsx scripts/to-docx.ts resumes/markdown/<name>.md --job-id <id>   # the file
npx tsx scripts/to-docx.ts --job-id <id>                              # the file, else the row
# Dashboard "Download .docx"                                          # the file, else the row
```

`to-docx.ts` prints `edited since it was tailored` when the two differ; the route says the
same in an `x-resume-source` header. Two things this does NOT cover: the résumé must sit at
`resumeMdPathFor(company, title)` for the resolver to find it (a `--out` name of your own
invention falls back to the row), and **`draftedAnswers` has no resolver at all** — the
dashboard's answers panel reads the row, so an edited `-answers.md` still drifts.

Accuracy fixes that aren't job-specific (a mis-categorized tool, a wrong date, a broadened
claim) belong in `profile/resume_base.md` too, or the next tailoring reintroduces them.
Job-specific trimming does **not** — dropping a bullet from the master permanently loses it
for other applications. That call is the user's.

## Say the fit gap once

If the role is a stretch, give the honest read one time and then build without re-litigating
it. Applying to stretch roles is a deliberate strategy and the user knows their own odds.
