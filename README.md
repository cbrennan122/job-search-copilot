# Job Search Copilot

A local, single-user job-search assistant. It aggregates listings from legitimate
job-board APIs, scores each for fit against your resume, tailors your resume per
job, and gives you a review queue with direct apply links. **It never auto-submits
applications** — you review and click submit yourself (assisted-review flow).

One all-TypeScript Next.js app: the pipeline runs in API routes / a CLI script,
data lives in SQLite, and the LLM work (fit scoring + resume tailoring) uses the
Claude API.

## What it does

1. **Aggregate** jobs from Greenhouse, Lever, Ashby, RemoteOK, USAJobs, and Adzuna
   (all free), plus optionally JSearch (free tier, covers LinkedIn/Indeed/Glassdoor
   listings). It does **not** scrape LinkedIn/Indeed directly — that violates their ToS.
   Re-running is idempotent: listings are refreshed in place, and jobs that vanish from
   a company board you fully enumerated are marked closed rather than deleted.
   Postings outside the countries you name in `[match].countries` are hidden from the
   queue and cost no LLM calls — see **Countries** below.
2. **Score fit** — a free keyword prefilter, then a Claude **Haiku** score (0–100 +
   reason) on the survivors, so you don't spend LLM calls on obvious non-matches.
3. **Tailor your resume** — Claude **Sonnet** re-emphasizes your real resume toward a
   job and drafts answers to common questions. It never invents experience.
4. **Review queue** — a paged dashboard sorted by fit, searchable by title/company/
   location, with an application tracker (status, follow-up date, contact, comp notes)
   behind each job and a one-click **Not interested** on every tile.
5. **Check your own work** — a deterministic fabrication check on anything generated
   (every employer, date, metric and listed skill must trace back to your master résumé;
   it runs automatically in the dashboard and in every CLI that writes a document),
   a skills-gap report across the jobs you actually match, and a daily digest.

## Setup

```bash
npm install
cp .env.local.example .env.local            # then fill in ANTHROPIC_API_KEY
cp profile/resume_base.example.md profile/resume_base.md
cp profile/profile.example.toml profile/profile.toml
```

Then edit your two profile files:

- `profile/resume_base.md` — your **master resume** (the source of truth). Fill this
  in with your real background; tailoring only re-emphasizes what's here.
- `profile/profile.toml` — titles/keywords to match, roles to deprioritize, and the
  company lists per source. Add companies whose boards you want to watch.

Both are **gitignored** — they hold your contact details and your private list of target
companies, so they stay local. Only the `.example` templates are committed.

Everything generated for an application — the saved job description, the tailored `.md`,
its drafted answers, the `.docx` you send — goes in **`resumes/`**, which is gitignored
whole and created the first time something writes to it. Those files carry your phone
number and email, so nothing there is ever committed. The repo root has a matching
allowlist as a backstop, in case a stray `--out` lands one there; see `.gitignore`.

## Usage

```bash
# Fetch + score (needs ANTHROPIC_API_KEY):
npx tsx scripts/fetch.ts

# Fetch only, no LLM scoring (no API key needed):
npx tsx scripts/fetch.ts --no-score

# Run the dashboard:
npm run dev            # http://localhost:3000

# Tailor your résumé against ONE job description (no fetch/DB needed):
npx tsx scripts/tailor.ts resumes/jd-acme.txt --company "Acme" --title "SRE" \
  --out resumes/tailored-acme.md
pbpaste | npx tsx scripts/tailor.ts    # or pipe the JD in on stdin

# Convert any résumé Markdown into a formatted .docx (no API key needed):
npx tsx scripts/to-docx.ts resumes/tailored-acme.md    # → resumes/tailored-acme.docx

# Inspect a .docx before you send it — the ONLY way to see what's really in there:
npm run check-docx resumes/tailored-acme.docx

# Check a generated résumé for anything not backed by your master résumé (exits 1 if so):
npm run check-resume -- resumes/tailored-acme.md --company "Acme"

# Daily standup: follow-ups due + new high-fit jobs + pipeline state (DB only, no key):
npm run digest -- --days 7 --min-fit 70

# What skills the jobs you match keep asking for that your résumé doesn't mention:
npm run gaps -- --min-fit 60

# Draft a cover letter for one JD (same no-fabrication guardrail as tailoring):
npm run cover -- resumes/jd-acme.txt --company "Acme" --title "SRE" \
  --out resumes/cover-acme.md

# Quality gates (all run without an API key — this is what CI runs):
npm run typecheck && npm run lint && npm test && npm run build
```

**Résumé and drafted answers are written to separate files on purpose.**
`tailor.ts` puts the résumé at `--out` and the answers in a sibling `-answers.md`,
because `to-docx.ts` renders a `# Drafted answers` heading onto a second page — which
is how `[FILL IN: …]` placeholders and salary posture end up in a document an employer
reads. Only convert the résumé file, and run `npm run check-docx` before sending.

`scripts/tailor.ts` takes a job description straight from a file or stdin, runs it
against `profile/resume_base.md`, and prints (or `--out` writes) the tailored résumé
plus drafted answers. It loads `ANTHROPIC_API_KEY` from `.env.local` automatically.
`--company`, `--title`, and `--location` are optional context for the model.

`scripts/to-docx.ts` renders a résumé Markdown file (the master resume or a `tailor.ts`
output) into a Word `.docx`, using the pure-JS `docx` package — no pandoc/LibreOffice
needed. Its formatting (Arial, accent-blue name/section headings, skills label/value
split, margins) is matched to the polished résumé template; tweak the style constants at
the top of the script to change the look. `--out` defaults to the input path with a
`.docx` extension, so a résumé tailored in `resumes/` stays there, and the directory is
created if it doesn't exist. Drafted answers (if present) start on a new page.

In the dashboard: search by title, company or location; filter by min-fit, role family,
location and status; click **Update** to run the pipeline; open a job to see its fit
reason and description, click **Tailor résumé** to generate a tailored version + drafted
answers, open the application link, and mark the job applied or skipped. **Not
interested** on a tile parks the job in `skipped` and drops it out of the queue —
nothing is deleted, and setting Status to `skipped` shows it again. Each generated résumé is
checked against your master résumé straight away, and anything it can't find there is
listed above the output — including the case where there was nothing checkable at all,
which is reported as a warning rather than a pass.

## Countries

`[match].countries` in `profile/profile.toml` is required and has no default — there is
deliberately no "anywhere" option, because that is what filled the queue with roles in
Bengaluru and Managua:

```toml
[match]
countries = ["United States"]
```

Names or two-letter ids from `lib/locations.ts`; an unrecognised one is an error rather
than a silent no-op. A posting's country is derived from its free-text `location` on
read, so widening this list re-classifies the whole queue with no migration — restart
`npm run dev` and the hidden jobs are back, with their original scores.

Three buckets, not two. A posting is **allowed**, **foreign**, or **unknown**, and
`unknown` is never hidden: hundreds of listings say only "Hybrid", "Distributed" or
"N/A", and guessing "foreign" there would hide jobs you could take. Foreign postings are
hidden from the default view (switch **Location** to *Everywhere* to see them) and are
skipped by the LLM scorer, so they cost nothing.

## Scheduling (daily fetch)

Run the fetch on a schedule with cron. Example — every day at 8am:

```cron
0 8 * * * cd /home/cbrennan/Projects/job-copilot && /usr/bin/npx tsx scripts/fetch.ts >> data/fetch.log 2>&1
```

(Adjust the path to `npx` with `which npx`.) New jobs show up in the queue next time
you open the dashboard.

## Data sources & keys

| Source     | Cost      | Key needed      | Config |
|------------|-----------|-----------------|--------|
| Greenhouse | free      | none            | `[greenhouse].companies` (board tokens) |
| Lever      | free      | none            | `[lever].companies` (slugs) |
| Ashby      | free      | none            | `[ashby].companies` (org slugs) |
| RemoteOK   | free      | none            | `[remoteok].enabled` (filtered against `[match]` at the adapter — it is a general job board, not a tech one) |
| USAJobs    | free      | `USAJOBS_API_KEY` + `USAJOBS_EMAIL` | `[usajobs].queries` (register at developer.usajobs.gov) |
| Adzuna     | free tier | `ADZUNA_APP_ID` + `ADZUNA_APP_KEY`  | `[adzuna].queries` (register at developer.adzuna.com) |
| JSearch    | free tier | `OPENWEBNINJA_API_KEY` | `[jsearch].queries` (register at openwebninja.com; subscribe to JSearch even on the free plan) |

Keyed sources are skipped silently when their env vars are absent, so an unconfigured
source costs nothing. Company boards (Greenhouse/Lever/Ashby) are the only sources whose
jobs can be auto-closed when they disappear; the search feeds return a moving slice of
results, so nothing of theirs is ever closed on absence alone.

## Notes

- Secrets (`.env.local`) and the database (`data/`) are gitignored.
- CLI scripts load `.env.local` themselves (Next.js does it automatically; bare `tsx`
  does not). A scored fetch fails loudly and exits 1 if every LLM call fails, rather
  than quietly filling the queue with keyword scores.
- The tailored resume is a **draft** — always read every line before sending.
- Auto-submitting applications is intentionally out of scope (fragile across ATSes,
  often against ToS, and mass-applying tends to backfire).
