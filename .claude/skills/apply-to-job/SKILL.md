---
name: apply-to-job
description: Tailor the master résumé to one job description and produce a formatted .docx to apply with. Use when the user pastes a job posting (LinkedIn or anywhere) and wants a tailored résumé, drafted answers, or a Word doc to submit. Covers the JD→tailor→docx pipeline, the stale-markdown trap, and the honesty guardrails.
---

# Apply to one job

Turn a pasted job description into a tailored résumé + drafted answers (`.md`), then a
formatted Word doc (`.docx`) the user can attach to an application.

**Never auto-submit.** This is an assisted-review tool: produce the documents, hand them
back, let the user apply themselves.

## Step 0 — Give an honest fit read first

Before spending an LLM call, compare the posting against `profile/resume_base.md` and say
plainly where it's strong and where it's a stretch. Name hard gaps explicitly (years of
experience, a language the user has never shipped). Tailoring **cannot** close a gap —
`lib/tailor.ts` is guardrailed against fabricating skills, employers, dates, or metrics,
so a resume for a role requiring 10+ years of a language the user doesn't know will still
not claim it. Say so up front rather than implying the tailored résumé fixes it.

Then proceed anyway if the user wants it — the call is theirs.

**Reading the queue: the badge is fit only.** The number on a card answers "how well does
the résumé match this posting" and nothing else — it is what `min fit` filters on and what
the digest reports. Ordering is that score **plus** a role-family preference weight
(swe 18 / devops 10 / sdet 4 / other 0, in `lib/categories.ts`), applied in `ORDER BY`
alone. So a job can legitimately sit above one showing a higher number, and the chip on
each card is what makes that legible.

When suggesting what to apply to next, lead with software engineering roles — that is the
user's stated preference — but quote the score honestly rather than implying the SWE role
is the better *match*. It often isn't: the preference runs opposite to where the résumé
evidence is deepest. Do not quietly drop SDET/automation roles either; they are third, not
off the list.

## Step 1 — Save the JD to a file

Write the pasted posting to `resumes/jd-<company>-<role>.txt`. **Everything generated for
an application lives under `resumes/`**, split by what the file is for: `resumes/markdown/`
holds the `.md` sources (tailored résumé and its `-answers.md`), and `resumes/` itself holds
the `.docx` you send, plus the saved JD. `lib/paths.ts` is the only place that decides this.
The tree is gitignored whole and created on first write, so it may not exist yet; that is
fine. Nothing generated goes in the repo root. Strip site
boilerplate (nav, "What You'll Love", EEO statements) but **keep** the role summary,
responsibilities, and the full requirements list — those drive the tailoring.

## Step 2 — Tailor

```bash
npx tsx scripts/tailor.ts resumes/jd-<company>-<role>.txt \
  --company "<Company>" --title "<Title>" --location "<Location>" \
  --out resumes/markdown/tailored-<company>-<role>.md
```

- Needs `ANTHROPIC_API_KEY` (auto-loaded from `.env.local`). Uses `claude-sonnet-5`.
- The JD can also come from stdin: `pbpaste | npx tsx scripts/tailor.ts`.
- **Two files come out**: `resumes/markdown/tailored-<company>-<role>.md` (the résumé, ending at
  Education) and `resumes/markdown/tailored-<company>-<role>-answers.md` (the drafted
  answers, marked PREP ONLY).

They are separate on purpose. `to-docx.ts` renders any `# Drafted answers` heading onto a
second page, so a combined file means the document sent to an employer contains
`[FILL IN: your target number]`, salary posture, and rehearsed talking points about gaps.
**Only ever convert the résumé file.** If you meet an older combined `.md`, split it first.

## Step 3 — Convert to .docx

```bash
npx tsx scripts/to-docx.ts resumes/markdown/tailored-<company>-<role>.md
# → resumes/tailored-<company>-<role>.docx   (or pass --out <name>.docx)

# If the job came from the queue, pass its id and the .docx is logged against it:
npx tsx scripts/to-docx.ts resumes/markdown/tailored-<company>-<role>.md --job-id <id>

# If the résumé was tailored in the DASHBOARD, the .md is in resumes/markdown/ already;
# the id alone also works, and the dashboard's "Download .docx" button does the same thing:
npx tsx scripts/to-docx.ts --job-id <id>
# → resumes/<Company>-<Title>.docx
```

`--job-id` is the only thing in this script that opens the database. It resolves the job
*before* rendering, so a mistyped id exits 1 with a sentence instead of a foreign-key error
after the file is already written, and it records the artifact only *after* the write
succeeds. See Step 6 — without it, "applied" can never say what you actually attached.

With no `.md` alongside it, `--job-id` also *sources* the résumé, from the newest
`resume_versions` row for that job. Tailoring in the dashboard now writes the same two files
into `resumes/markdown/` that Step 2 does, so either input works; the id is the shorter one
and is what the **Download .docx** button uses. It renders the stored `content` only —
`draftedAnswers` is a separate column and never reaches the page, the same split Step 2 keeps
on disk. A job with no tailored résumé yet exits 1 and tells you to tailor it first.

No API key needed. Formatting is matched to the user's résumé template and lives in the `S`
style constants at the top of `lib/docx-render.ts` — the one renderer, shared by this script
and the dashboard's Download button: Arial throughout, plain body text,
large plain accent-blue (`#1F4E79`) name with a bottom rule, **bold** accent section
headings, **bold** company lines, *italic* job-title/date lines, and a bold-label /
plain-value skills split.

`to-docx.ts` prints a loud warning if the input still contains a drafted-answers section —
do not ignore it.

### Writing to the Windows Downloads folder (WSL)

Writing to `/mnt/c/Users/<user>/Downloads/X.docx` fails with `EACCES` when that file is
**open in Word**, even though the directory itself is writable (`touch` in it succeeds).
Do not force-delete the locked file. Write alongside it (`X-updated.docx`) and ask the user
to close Word if they want the original path overwritten.

## Step 4 — Verify before sending

**Two gates, and they check disjoint things.** Passing one says nothing about the other:
the content gate reads the `.md` for claims that aren't in the master résumé; the format
gate reads the `.docx` for what a reader would actually see. Run both.

### 4a — Content gate (no API key)

```bash
npm run check-resume -- resumes/markdown/tailored-<company>-<role>.md --company "<Company>"
```

`lib/verify.ts` checks, deterministically and with no LLM call, that every employer (in
headings **and** in running prose), year, metric, and skills-line entry in the output also
appears in `profile/resume_base.md`. It exits 1 when something isn't, so it can gate a send.
`--company` suppresses the employer you're applying to — naming them is not a claim of
having worked there.

Three things to know about reading its output:

- **"Nothing checkable found" is NOT a pass.** It means zero claims were examined, which
  is what a heading-free document (a cover letter, a summary-only fragment) produces. The
  script prints that instead of a tick precisely so it can't be mistaken for a clean bill.
  Read the document yourself.
- **A flag is not an accusation.** It means "this hard fact isn't in your master résumé" —
  often the master is simply missing something real, and the fix belongs there.
- **It cannot catch a claim built from words the master already contains.** Verb upgrades,
  singular→plural, a real tool filed under the wrong category — all invisible to it. That
  is what the `review-resume` skill's Pass 1 is for.

### 4b — Format gate

Never hand over a `.docx` you haven't inspected — the Read tool can't render one.

```bash
npm run check-docx <out>.docx
```

This fails on page breaks, `FILL IN` text, a drafted-answers heading, salary mentions, and
the all-bold-italic misparse. **`check-docx` is the gate; bare `npm run dump-docx` only
prints formatting and always exits 0** — reaching for the wrong one gets you a report you
then have to read yourself instead of a pass/fail. To confirm styling didn't drift from a
previous render:

```bash
npm run dump-docx <previous>.docx -- --diff <new>.docx
```

If you re-derive the style spec from a `.docx` by hand, remember `<w:b w:val="0"/>` means
bold **off** — testing only for element presence misreads every run as bold+italic, which
is exactly how a fully bold-italic résumé shipped on 2026-07-22.

## Step 5 — Hand it back and flag what needs review

Send the résumé `.docx` with `SendUserFile` — never the answers file. Always tell the user to:

- Fill the `[FILL IN]` markers in `*-answers.md` — the model deliberately refuses to invent
  answers it can't source from the résumé (e.g. "do you have Java experience?"). Those
  markers live in the prep file only and must never reach the employer.
- Read any bullet that got reframed toward the JD's language, to confirm it still sounds
  like them and remains true.

For a deeper honesty/quality pass before applying, use the `review-resume` skill.

## Step 6 — Record it in the queue

**This is the step that gets skipped, and skipping it is what makes the tracking half of
this tool inert.** Checked on 2026-08-26: the database held 2,824 jobs, every single one
still `new`. Nothing had ever been marked applied, so `dueFollowUps`, `npm run digest`'s
follow-up chasing, the dashboard's status filters, and the `artifacts` table were all
reading a table nothing wrote to — while two real applications had gone out.

If the job came from the queue:

1. **Pass `--job-id <id>` back in Step 3.** That logs the exact `.docx`, so "applied" says
   *what you attached* rather than only that a résumé was generated once. The job detail
   page lists them under **Files sent**.
2. **Set the status.** `npm run dev`, open `/jobs/<id>`, set the dropdown to **applied**,
   fill in a **follow-up date**, Save. `appliedAt` is stamped once on the first submitted
   status and never re-stamped as the job advances.

Without a dev server running, the same write from the repo root:

```bash
npx tsx -e "
import { updateApplication } from './lib/store';
console.log(updateApplication('<job-id>', { status: 'applied', followUpAt: '2026-09-05' }));
"
```

Statuses are `new`, `applied`, `screen`, `onsite`, `offer`, `rejected`, `skipped`. Keep
advancing it as the process moves — `rejected` and `skipped` are the two that stop the
follow-up chasing, so a stalled job left at `applied` keeps showing up in the digest, which
is the correct behaviour.

**If the job did not come from the queue** — pasted from LinkedIn, forwarded by a friend —
there is no row to update and no id to pass. `--job-id` refuses an unknown id rather than
inventing a row. Say so plainly instead of quietly skipping the step, so the user knows the
queue has no record of that application.

## Optional — cover letter

```bash
npm run cover -- resumes/jd-<company>-<role>.txt \
  --company "<Company>" --title "<Title>" --out resumes/markdown/cover-<company>-<role>.md
```

Needs `ANTHROPIC_API_KEY`. Same no-fabrication guardrail as tailoring, and it verifies
itself on the way out (`lib/cover.ts` + `lib/verify.ts`), passing `--company` through so the
target employer isn't flagged.

Two things are specific to letters:

- **A letter is unbroken prose — no headings, often no years or figures.** Heading-based
  employer detection finds nothing in one, so `verify.ts` also reads employers out of prose
  ("At Netflix I ran…"). Before it did, a draft claiming a job the user never held verified
  clean at "0 claims checked".
- **It carries `[FILL IN: …]` markers too**, e.g. why this company specifically. The model
  refuses to invent motivation it can't source. Fill them or cut them — never send as-is.

Hand the letter back as Markdown. Don't run it through `to-docx.ts`: that formatter's style
spec is a résumé layout, not a letter.

## The stale-markdown trap (hit this once already)

`scripts/to-docx.ts` is **only a formatter**. It renders whatever is in the `.md` — it
never re-reads `profile/resume_base.md`.

So if the master résumé changes (new job, new project, edited bullets), re-running the
converter on an old tailored `.md` will silently omit the new content. **Re-run Step 2**
for any job you care about after editing `profile/resume_base.md`, then Step 3.

Quick check before converting:

```bash
grep -c "<new thing you just added>" resumes/markdown/tailored-<company>-<role>.md   # 0 means re-tailor
```

## Adding real experience to the master résumé

If the user mentions experience missing from `profile/resume_base.md` (a side project, a
new role), add it to the master **first**, then tailor. Inspect the actual source (read the
repo/README) so the description is accurate and specific rather than generic — and keep it
strictly truthful, since everything downstream inherits from this file.

The project may live **outside this repo** — e.g. Med Timer was read from `../med-timer/`
(its `README.md` + `package.json` + `src/` layout) to write an accurate entry. Ask for the
path rather than describing a project you haven't opened.

## Generated files

Tailored `.md`/`.docx`, `*-answers.md`, and `jd-*.txt` are regenerated output, not source —
and they carry the user's phone, email, and salary posture.

They belong in **`resumes/`**, which `.gitignore` ignores whole. Write them there; the
directory is created on demand by `lib/outfile.ts`, so don't `mkdir` it first or worry that
it's missing from a fresh clone.

The repo root keeps a separate **allowlist** as a backstop, because `--out` takes any path
and one stray `--out tailored.md` would commit a résumé with a phone number in it: every
root-level `.md`/`.docx`/`.txt` is ignored except `README.md`, `AGENTS.md`, and `CLAUDE.md`.
Don't replace it with filename-convention patterns — `/tailored*.md` was tried and leaked,
because real files got named after the company/role instead. If you add a new root-level
source doc, add it to the allowlist.
