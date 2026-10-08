// SQLite persistence for jobs, fit scores, application status, and resume versions.
// better-sqlite3 is synchronous, which keeps a single-user local tool dead simple.

import Database from "better-sqlite3";
import { categoryOf } from "./categories";
import { activeCountries, countryOf, locationWeight, UNKNOWN } from "./locations";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type {
  Application,
  ApplicationStatus,
  Artifact,
  ArtifactKind,
  FitScore,
  Job,
  JobListItem,
  JobWithMeta,
  ResumeVersion,
} from "./types";
import { FALLBACK_MODEL, SUBMITTED_STATUSES, TERMINAL_STATUSES } from "./types";

/**
 * Database location. JOB_COPILOT_DB overrides it so the test suite can run
 * against a throwaway file — without it, tests would migrate and mutate the
 * real queue.
 *
 * Resolved lazily, on first connection rather than at module load, so a caller
 * only has to set the env var before the first query. Reading it at load time
 * made correctness depend on import order, which is exactly the kind of thing
 * that breaks silently when someone reorders imports.
 */
function dbFile(): string {
  return process.env.JOB_COPILOT_DB ?? path.join(process.cwd(), "data", "jobsearch.db");
}

// One shared connection per process. In Next.js dev the module is cached, so we
// stash it on globalThis to survive hot reloads without reopening the file.
const g = globalThis as unknown as { __jobDb?: Database.Database };

/**
 * Ordered schema steps. Each runs exactly once, tracked by PRAGMA user_version,
 * so an existing database upgrades in place instead of needing to be thrown away.
 * Step 1 is the original schema and is a no-op on any DB that predates this runner.
 * NEVER edit a shipped step — append a new one.
 */
const MIGRATIONS: string[] = [
  // 1 — original schema.
  `
    CREATE TABLE IF NOT EXISTS jobs (
      id           TEXT PRIMARY KEY,
      source       TEXT NOT NULL,
      sourceJobId  TEXT NOT NULL,
      title        TEXT NOT NULL,
      company      TEXT NOT NULL,
      location     TEXT NOT NULL,
      remote       INTEGER,            -- 0/1/NULL
      description  TEXT NOT NULL,
      url          TEXT NOT NULL,
      postedAt     TEXT,
      fetchedAt    TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS fit_scores (
      jobId    TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
      score    INTEGER NOT NULL,
      reason   TEXT NOT NULL,
      model    TEXT NOT NULL,
      scoredAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS applications (
      jobId     TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
      status    TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS resume_versions (
      id             TEXT PRIMARY KEY,
      jobId          TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      content        TEXT NOT NULL,
      draftedAnswers TEXT NOT NULL,
      model          TEXT NOT NULL,
      createdAt      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_resume_job ON resume_versions(jobId);
  `,
  // 2 — job lifecycle (lastSeenAt/closedAt), board metadata we were discarding,
  //     a real application tracker, and artifact links.
  `
    ALTER TABLE jobs ADD COLUMN lastSeenAt     TEXT;
    ALTER TABLE jobs ADD COLUMN closedAt       TEXT;
    ALTER TABLE jobs ADD COLUMN compensation   TEXT;
    ALTER TABLE jobs ADD COLUMN employmentType TEXT;
    ALTER TABLE jobs ADD COLUMN department     TEXT;
    UPDATE jobs SET lastSeenAt = fetchedAt WHERE lastSeenAt IS NULL;

    ALTER TABLE applications ADD COLUMN appliedAt  TEXT;
    ALTER TABLE applications ADD COLUMN notes      TEXT NOT NULL DEFAULT '';
    ALTER TABLE applications ADD COLUMN followUpAt TEXT;
    ALTER TABLE applications ADD COLUMN contact    TEXT NOT NULL DEFAULT '';
    ALTER TABLE applications ADD COLUMN compNotes  TEXT NOT NULL DEFAULT '';

    ALTER TABLE resume_versions ADD COLUMN coverLetter TEXT NOT NULL DEFAULT '';

    CREATE TABLE IF NOT EXISTS artifacts (
      id        TEXT PRIMARY KEY,
      jobId     TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      kind      TEXT NOT NULL,
      path      TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_artifact_job ON artifacts(jobId);
    CREATE INDEX IF NOT EXISTS idx_jobs_scope   ON jobs(source, company);
    CREATE INDEX IF NOT EXISTS idx_jobs_open    ON jobs(closedAt);
  `,
];

function migrate(db: Database.Database): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    // Each step runs in its own transaction: SQLite DDL is transactional, and
    // PRAGMA user_version participates too. Without this, a step that fails
    // halfway leaves the columns it already added in place while user_version
    // stays behind — and every retry then dies on "duplicate column name",
    // wedging the database permanently.
    const step = db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    });
    step();
  }
}

function open(): Database.Database {
  const file = dbFile();
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  registerDerivedFns(db);
  return db;
}

/**
 * Expose lib/categories.ts and lib/locations.ts to SQL, so filtering and ranking
 * by role family or country run the SAME classifiers the UI labels cards with.
 *
 * The alternative was generating a CASE ... LIKE expression from the patterns,
 * which would have been a second implementation of the matching rule — and a
 * worse one, since LIKE has no word-boundary notion and "intern" would once
 * again match "internal". A user-defined function means there is exactly one
 * answer to "what category is this", in TypeScript, under test.
 *
 * Both are derived rather than stored on purpose: retuning the patterns
 * re-classifies the whole queue with no migration and no stale rows. The cost
 * is that these predicates cannot use an index — irrelevant at a few thousand
 * rows, and worth re-checking if this ever holds a million.
 */
function registerDerivedFns(db: Database.Database): void {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  db.function("job_category", { deterministic: true }, (t) => categoryOf(str(t)).id);
  db.function("job_category_weight", { deterministic: true }, (t) => categoryOf(str(t)).weight);
  // Country takes the SOURCE as well as the location, because some feeds are
  // country-scoped by construction and ship an uninformative location string —
  // JSearch's 66 "Anywhere" rows are US jobs. See lib/locations.ts.
  db.function("job_country", { deterministic: true }, (loc, src) => countryOf(str(loc), str(src)));
  db.function("job_location_weight", { deterministic: true }, (loc, src) =>
    locationWeight(str(loc), str(src)),
  );
}

export function db(): Database.Database {
  if (!g.__jobDb) g.__jobDb = open();
  return g.__jobDb;
}

/** Stable dedup id: same role from different sources collapses to one row. */
export function makeJobId(title: string, company: string, location: string): string {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha1")
    .update(`${norm(title)}|${norm(company)}|${norm(location)}`)
    .digest("hex")
    .slice(0, 16);
}

/** Delisting scope key — see SourceResult.scopes for what may legitimately appear here. */
export function scopeKey(source: string, company: string): string {
  return `${source}:${company.toLowerCase().trim()}`;
}

export interface UpsertResult {
  inserted: number;
  updated: number;
}

/**
 * Insert new jobs and refresh ones we've seen before.
 *
 * Previously this was ON CONFLICT DO NOTHING, so a listing's description, URL, or
 * pay could never be corrected once stored. Now the mutable fields are refreshed
 * and `lastSeenAt` always advances; a job that reappears after being closed is
 * reopened.
 */
export function upsertJobs(jobs: Job[]): UpsertResult {
  const insert = db().prepare(`
    INSERT INTO jobs (id, source, sourceJobId, title, company, location, remote, description,
                      url, postedAt, fetchedAt, lastSeenAt, closedAt, compensation,
                      employmentType, department)
    VALUES (@id, @source, @sourceJobId, @title, @company, @location, @remote, @description,
            @url, @postedAt, @fetchedAt, @fetchedAt, NULL, @compensation,
            @employmentType, @department)
    ON CONFLICT(id) DO UPDATE SET
      description    = excluded.description,
      url            = excluded.url,
      location       = excluded.location,
      remote         = excluded.remote,
      postedAt       = COALESCE(excluded.postedAt, jobs.postedAt),
      compensation   = COALESCE(excluded.compensation, jobs.compensation),
      employmentType = COALESCE(excluded.employmentType, jobs.employmentType),
      department     = COALESCE(excluded.department, jobs.department),
      lastSeenAt     = excluded.lastSeenAt,
      closedAt       = NULL
  `);
  const seedApp = db().prepare(`
    INSERT INTO applications (jobId, status, updatedAt)
    VALUES (?, 'new', ?) ON CONFLICT(jobId) DO NOTHING
  `);
  const now = new Date().toISOString();
  const tx = db().transaction((rows: Job[]) => {
    let inserted = 0;
    let updated = 0;
    for (const j of rows) {
      const res = insert.run({
        ...j,
        remote: j.remote === null ? null : j.remote ? 1 : 0,
      });
      // lastInsertRowid only advances on a real INSERT; an upsert-update reports
      // changes=1 too, so distinguish by checking whether the row already existed.
      if (res.changes > 0) {
        const isNew = seedApp.run(j.id, now).changes > 0;
        if (isNew) inserted++;
        else updated++;
      }
    }
    return { inserted, updated };
  });
  return tx(jobs);
}

/**
 * Close jobs that have vanished from a board we successfully enumerated.
 *
 * Only scopes passed in are touched, and callers must only pass scopes whose
 * fetch SUCCEEDED and was exhaustive (see SourceResult.scopes). That is what
 * keeps a transient 500 from wiping a company out of the queue.
 * Returns how many jobs were newly closed.
 */
export function markDelisted(scopes: string[], seenJobIds: string[]): number {
  if (scopes.length === 0) return 0;
  const seen = new Set(seenJobIds);
  const now = new Date().toISOString();

  const rows = db()
    .prepare(`SELECT id, source, company FROM jobs WHERE closedAt IS NULL`)
    .all() as Array<{ id: string; source: string; company: string }>;

  const inScope = new Set(scopes);
  const close = db().prepare(`UPDATE jobs SET closedAt = ? WHERE id = ?`);
  const tx = db().transaction(() => {
    let n = 0;
    for (const r of rows) {
      if (!inScope.has(scopeKey(r.source, r.company))) continue;
      if (seen.has(r.id)) continue;
      close.run(now, r.id);
      n++;
    }
    return n;
  });
  return tx();
}

/** Permanently delete jobs closed longer than `days` ago, unless you applied to them. */
export function pruneClosed(days: number): number {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const submitted = SUBMITTED_STATUSES.map((s) => `'${s}'`).join(",");
  const res = db()
    .prepare(
      `DELETE FROM jobs
        WHERE closedAt IS NOT NULL AND closedAt < ?
          AND id NOT IN (SELECT jobId FROM applications WHERE status IN (${submitted}))`,
    )
    .run(cutoff);
  return res.changes;
}

// Defined in ./types so client components can use it without pulling in
// better-sqlite3. Re-exported here because this is where callers expect it.
// Note "prefilter" (a deliberate below-threshold skip) is a genuine verdict and
// is NOT retried; only FALLBACK_MODEL rows are.
export { FALLBACK_MODEL } from "./types";

/**
 * How many OPEN jobs are carrying a fallback score. This is the number that
 * tells you a scoring run was hollow: those rows look scored and sort into the
 * queue like real results, but the number is keyword noise, not a fit judgement.
 */
export function countFallbackScores(): number {
  const row = db()
    .prepare(
      `SELECT COUNT(*) AS n FROM jobs j
         JOIN fit_scores f ON f.jobId = j.id
        WHERE j.closedAt IS NULL AND f.model = ?`,
    )
    .get(FALLBACK_MODEL) as { n: number };
  return row.n;
}

/**
 * The scoring work queue: jobs with no score, plus jobs whose last score was a
 * failure fallback. Closed jobs are skipped.
 */
export function unscoredJobs(): Job[] {
  const rows = db()
    .prepare(
      `SELECT j.* FROM jobs j
        LEFT JOIN fit_scores f ON f.jobId = j.id
       WHERE j.closedAt IS NULL
         AND (f.jobId IS NULL OR f.model = ?)`,
    )
    // Bound, not interpolated. The value is a hardcoded constant so there is no
    // injection here today — the cost is that this was the one unbound query in
    // the file, sitting next to countFallbackScores which binds the same
    // constant, and it is the line the next query gets copied from.
    .all(FALLBACK_MODEL) as RawJob[];
  return rows.map(fromRaw);
}

/**
 * Drop stored fit scores so the next scoring pass recomputes them.
 *
 * Needed because a real LLM score is final by design — `unscoredJobs` re-queues
 * only never-scored jobs and FALLBACK_MODEL rows, so a genuine verdict is never
 * revisited. That is right when the config is stable and wrong the moment
 * targeting changes: every stored score was computed against the targeting in
 * force at the time, and nothing else re-queues them.
 *
 * Closed jobs are left alone unless asked for — a delisted listing cannot be
 * applied to, so re-scoring it is pure spend.
 */
export function clearFitScores(opts: { includeClosed?: boolean } = {}): number {
  const scope = opts.includeClosed ? "" : `WHERE closedAt IS NULL`;
  const info = db()
    .prepare(`DELETE FROM fit_scores WHERE jobId IN (SELECT id FROM jobs ${scope})`)
    .run();
  return info.changes;
}

export function saveFitScore(f: FitScore): void {
  db()
    .prepare(
      `INSERT INTO fit_scores (jobId, score, reason, model, scoredAt)
       VALUES (@jobId, @score, @reason, @model, @scoredAt)
       ON CONFLICT(jobId) DO UPDATE SET
         score=@score, reason=@reason, model=@model, scoredAt=@scoredAt`,
    )
    .run(f);
}

export function getFit(jobId: string): FitScore | null {
  const row = db().prepare(`SELECT * FROM fit_scores WHERE jobId = ?`).get(jobId) as
    FitScore | undefined;
  return row ?? null;
}

export function getJob(id: string): Job | null {
  const row = db().prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as RawJob | undefined;
  return row ? fromRaw(row) : null;
}

export function setStatus(jobId: string, status: ApplicationStatus): void {
  updateApplication(jobId, { status });
}

/**
 * Patch an application row. `appliedAt` is stamped automatically the first time a
 * job reaches a submitted status, so "when did I apply?" is answerable later.
 */
export function updateApplication(
  jobId: string,
  patch: Partial<Omit<Application, "jobId" | "updatedAt">>,
): Application {
  const current = getApplication(jobId);
  const next: Application = { ...current, ...patch };
  const nowSubmitted = next.status !== null && SUBMITTED_STATUSES.includes(next.status);
  next.appliedAt = next.appliedAt ?? (nowSubmitted ? new Date().toISOString() : null);
  next.updatedAt = new Date().toISOString();

  db()
    .prepare(
      `INSERT INTO applications (jobId, status, updatedAt, appliedAt, notes, followUpAt, contact, compNotes)
       VALUES (@jobId, @status, @updatedAt, @appliedAt, @notes, @followUpAt, @contact, @compNotes)
       ON CONFLICT(jobId) DO UPDATE SET
         status=excluded.status, updatedAt=excluded.updatedAt, appliedAt=excluded.appliedAt,
         notes=excluded.notes, followUpAt=excluded.followUpAt, contact=excluded.contact,
         compNotes=excluded.compNotes`,
    )
    .run(next);
  return next;
}

export function getApplication(jobId: string): Application {
  const row = db().prepare(`SELECT * FROM applications WHERE jobId = ?`).get(jobId) as
    Application | undefined;
  return (
    row ?? {
      jobId,
      status: "new",
      updatedAt: new Date().toISOString(),
      appliedAt: null,
      notes: "",
      followUpAt: null,
      contact: "",
      compNotes: "",
    }
  );
}

/** Applications needing a nudge: follow-up date reached, still mid-process. */
export function dueFollowUps(
  asOf = new Date().toISOString(),
): Array<Application & { title: string; company: string }> {
  // Terminal statuses come from the shared list, not from literals spelled out
  // here: this query would keep chasing a status added to the "it's over" set
  // later, and would do it silently.
  const holes = TERMINAL_STATUSES.map(() => "?").join(",");
  return db()
    .prepare(
      `SELECT a.*, j.title, j.company FROM applications a
         JOIN jobs j ON j.id = a.jobId
        WHERE a.followUpAt IS NOT NULL AND a.followUpAt <= ?
          AND a.status NOT IN (${holes})
        ORDER BY a.followUpAt ASC`,
    )
    .all(asOf, ...TERMINAL_STATUSES) as Array<Application & { title: string; company: string }>;
}

export function saveResumeVersion(v: ResumeVersion): void {
  db()
    .prepare(
      `INSERT INTO resume_versions (id, jobId, content, draftedAnswers, coverLetter, model, createdAt)
       VALUES (@id, @jobId, @content, @draftedAnswers, @coverLetter, @model, @createdAt)`,
    )
    .run(v);
}

/**
 * Most recent tailored resume for a job, if any.
 *
 * `rowid DESC` is the tiebreak, and it is load-bearing: `createdAt` is an ISO
 * string with millisecond precision, so two versions written in the same
 * millisecond had UNDEFINED order and this returned either one. That is not
 * hypothetical — `commitResumeEdit()` writes immediately after a tailor, and the
 * resume-source suite failed about half of its runs until this was added,
 * meaning "latest" could hand back the PRE-REVIEW draft. rowid is insertion
 * order, which is exactly what "latest" means for a tie, and it needs no
 * migration: the table is a normal rowid table (TEXT primary key, not
 * WITHOUT ROWID).
 */
export function latestResume(jobId: string): ResumeVersion | null {
  const row = db()
    .prepare(
      `SELECT * FROM resume_versions WHERE jobId = ? ORDER BY createdAt DESC, rowid DESC LIMIT 1`,
    )
    .get(jobId) as ResumeVersion | undefined;
  return row ?? null;
}

/** Record a generated file against a job, so "applied" says what you actually sent. */
export function saveArtifact(jobId: string, kind: ArtifactKind, filePath: string): Artifact {
  const a: Artifact = {
    id: randomUUID(),
    jobId,
    kind,
    path: path.resolve(filePath),
    createdAt: new Date().toISOString(),
  };
  db()
    .prepare(
      `INSERT INTO artifacts (id, jobId, kind, path, createdAt)
       VALUES (@id, @jobId, @kind, @path, @createdAt)`,
    )
    .run(a);
  return a;
}

export function listArtifacts(jobId: string): Artifact[] {
  // rowid DESC for the same reason latestResume has it: createdAt is an ISO
  // string at millisecond precision, so two rows written in the same
  // millisecond have UNDEFINED order and the older one can come back first.
  // resolveResumeMarkdown takes the first `resume-md` row whose file exists, so
  // a tie here decides which résumé gets rendered.
  return db()
    .prepare(`SELECT * FROM artifacts WHERE jobId = ? ORDER BY createdAt DESC, rowid DESC`)
    .all(jobId) as Artifact[];
}

export interface ListOpts {
  minFit?: number;
  status?: ApplicationStatus;
  source?: string;
  /** Role family id from lib/categories.ts ("swe", "devops", "sdet", "other"). */
  category?: string;
  /**
   * Country scope. "mine" (the default) hides postings classified as being in a
   * country `profile.match.countries` does not name; "all" shows everything.
   * The `unknown` bucket is NEVER hidden — see lib/locations.ts for why.
   */
  locations?: "mine" | "all";
  /** Free-text search over title, company and location. Not the description. */
  q?: string;
  /** Closed (delisted) jobs are hidden unless you ask for them. */
  includeClosed?: boolean;
  /** Drop jobs not seen in a fetch for this many days — the staleness guard for
   *  feed sources, which can never be authoritatively delisted. */
  maxAgeDays?: number;
  /** Only jobs FIRST seen within this many days. `fetchedAt` is deliberately not
   *  refreshed by the upsert, so it means "when this listing first appeared" —
   *  which is what "new since Friday" actually asks for. */
  firstSeenDays?: number;
  limit?: number;
  offset?: number;
}

/**
 * The country ids a "mine" query accepts, as a SQL literal list.
 *
 * Built here rather than passed as a bound parameter because SQLite has no
 * array binding, and inlining is safe: every value is a COUNTRIES id from
 * lib/locations.ts, never user input. UNKNOWN is always included.
 */
function allowedCountryList(): string {
  return [...activeCountries(), UNKNOWN].map((id) => `'${id}'`).join(", ");
}

/** A century. Past this a day-count filter stops meaning anything anyway. */
export const MAX_FILTER_DAYS = 36_500;

/**
 * The ISO cutoff `days` ago, clamped so no caller can make a Date throw.
 *
 * `new Date(NaN).toISOString()` throws RangeError, and so does any date beyond
 * ~100 000 000 days from the epoch — so `?maxAgeDays=1e9` took the whole queue
 * down with a 500, the same failure a non-numeric value did, one input shape
 * over. Clamping HERE and not only at the route is what makes that structural:
 * `firstSeenDays` has the identical shape and reaches this from digest.ts's
 * --days, which never validated either.
 */
function sinceDaysAgo(days: number): string {
  const d = Number.isFinite(days) ? Math.min(Math.max(days, 0), MAX_FILTER_DAYS) : MAX_FILTER_DAYS;
  return new Date(Date.now() - d * 86_400_000).toISOString();
}

function buildWhere(opts: ListOpts) {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.minFit != null) {
    clauses.push(`COALESCE(f.score, -1) >= @minFit`);
    params.minFit = opts.minFit;
  }
  if (opts.status) {
    clauses.push(`COALESCE(a.status, 'new') = @status`);
    params.status = opts.status;
  }
  if (opts.source) {
    clauses.push(`j.source = @source`);
    params.source = opts.source;
  }
  if (opts.category) {
    clauses.push(`job_category(j.title) = @category`);
    params.category = opts.category;
  }
  if (opts.locations !== "all") {
    // Anything the classifier could not place stays visible: a wrong "foreign"
    // hides a job you could have taken, a wrong "unknown" only fails to rank it.
    clauses.push(`job_country(j.location, j.source) IN (${allowedCountryList()})`);
  }
  if (opts.q && opts.q.trim()) {
    // Escape the LIKE metacharacters, or a typed "%" matches every row and a
    // typed "_" matches any character. SQLite LIKE is already case-insensitive
    // for ASCII, so no LOWER() is needed.
    const esc = opts.q.trim().replace(/[\\%_]/g, (ch) => `\\${ch}`);
    clauses.push(
      `(j.title LIKE @q ESCAPE '\\' OR j.company LIKE @q ESCAPE '\\'` +
        ` OR j.location LIKE @q ESCAPE '\\')`,
    );
    params.q = `%${esc}%`;
  }
  if (!opts.includeClosed) clauses.push(`j.closedAt IS NULL`);
  if (opts.maxAgeDays != null) {
    clauses.push(`j.lastSeenAt >= @since`);
    params.since = sinceDaysAgo(opts.maxAgeDays);
  }
  if (opts.firstSeenDays != null) {
    clauses.push(`j.fetchedAt >= @firstSeen`);
    params.firstSeen = sinceDaysAgo(opts.firstSeenDays);
  }
  return {
    where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

/**
 * Queue ordering: honest fit score, plus the role-family and country weights.
 *
 * The weight moves ORDER BY and NOTHING else — the score stored, displayed,
 * filtered on by `minFit`, and reported by the digest is untouched, because
 * "how well do I match this", "which kind of role do I want" and "could I take
 * this job at all" are different questions and blending them would leave none
 * of them answerable. See lib/categories.ts and lib/locations.ts for the
 * weights and what the gaps between them buy.
 *
 * Unscored rows stay at -1 rather than -1 + weight, so a never-scored job in a
 * preferred family cannot outrank a real low score.
 */
const RANK = `CASE WHEN f.score IS NULL THEN -1
                   ELSE f.score + job_category_weight(j.title)
                                + job_location_weight(j.location, j.source) END`;

/**
 * The review queue: jobs joined with fit + status, best first.
 * Descriptions are deliberately NOT selected — the list view doesn't render them
 * and including them made this response ~9.6 MB.
 */
export function listJobs(opts: ListOpts = {}): JobListItem[] {
  const { where, params } = buildWhere(opts);
  const limit = opts.limit ?? 200;
  const rows = db()
    .prepare(
      `SELECT j.id, j.source, j.sourceJobId, j.title, j.company, j.location, j.remote,
              j.url, j.postedAt, j.fetchedAt, j.lastSeenAt, j.closedAt,
              j.compensation, j.employmentType, j.department,
              f.score AS fitScore, f.reason AS fitReason, f.model AS fitModel, f.scoredAt AS fitScoredAt,
              COALESCE(a.status, 'new') AS status,
              (SELECT COUNT(*) FROM resume_versions r WHERE r.jobId = j.id) AS resumeCount
       FROM jobs j
       LEFT JOIN fit_scores f ON f.jobId = j.id
       LEFT JOIN applications a ON a.jobId = j.id
       ${where}
       ORDER BY ${RANK} DESC, COALESCE(f.score, -1) DESC, j.postedAt DESC, j.fetchedAt DESC
       LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit, offset: opts.offset ?? 0 }) as RawJobListItem[];

  return rows.map((r) => ({
    ...fromRaw(r),
    // Derived here rather than selected: the classifier needs profile config and
    // so cannot run in the browser, and getJobWithMeta reaches it the same way.
    category: categoryOf(r.title).id,
    fit:
      r.fitScore == null
        ? null
        : {
            jobId: r.id,
            score: r.fitScore,
            reason: r.fitReason ?? "",
            model: r.fitModel ?? "",
            scoredAt: r.fitScoredAt ?? "",
          },
    status: r.status as ApplicationStatus,
    hasResume: r.resumeCount > 0,
  }));
}

/**
 * Titles + descriptions for analysis (the skills-gap report). Separate from
 * listJobs because that one deliberately omits descriptions for payload size,
 * and this one needs exactly the field it drops.
 */
export function listJobTexts(opts: ListOpts = {}): Array<{ title: string; description: string }> {
  const { where, params } = buildWhere(opts);
  return db()
    .prepare(
      `SELECT j.title, j.description FROM jobs j
        LEFT JOIN fit_scores f ON f.jobId = j.id
        LEFT JOIN applications a ON a.jobId = j.id
        ${where}
        ORDER BY ${RANK} DESC
        LIMIT @limit OFFSET @offset`,
    )
    .all({
      ...params,
      limit: opts.limit ?? 500,
      offset: opts.offset ?? 0,
    }) as Array<{ title: string; description: string }>;
}

export function countJobs(opts: ListOpts = {}): number {
  const { where, params } = buildWhere(opts);
  const row = db()
    .prepare(
      `SELECT COUNT(*) AS n FROM jobs j
        LEFT JOIN fit_scores f ON f.jobId = j.id
        LEFT JOIN applications a ON a.jobId = j.id
        ${where}`,
    )
    .get(params) as { n: number };
  return row.n;
}

/** Full detail for one job, including its description. */
export function getJobWithMeta(id: string): JobWithMeta | null {
  const row = db().prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as RawJob | undefined;
  if (!row) return null;
  return {
    ...fromRaw(row),
    fit: getFit(id),
    status: getApplication(id).status,
    hasResume: latestResume(id) !== null,
  };
}

// --- raw row shapes (SQLite stores `remote` as 0/1/NULL) ---
interface RawJob extends Omit<Job, "remote"> {
  remote: number | null;
  lastSeenAt: string;
  closedAt: string | null;
}
interface RawJobListItem extends Omit<RawJob, "description"> {
  fitScore: number | null;
  fitReason: string | null;
  fitModel: string | null;
  fitScoredAt: string | null;
  status: string;
  resumeCount: number;
}
function fromRaw<T extends { remote: number | null }>(r: T) {
  return { ...r, remote: r.remote === null ? null : r.remote === 1 };
}
