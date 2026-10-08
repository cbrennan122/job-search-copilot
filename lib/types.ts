// Core domain types shared across the pipeline, store, and UI.

export type JobSource =
  "greenhouse" | "lever" | "ashby" | "adzuna" | "remoteok" | "usajobs" | "jsearch";

/** A normalized job listing. `id` is our own dedup hash (see makeJobId). */
export interface Job {
  id: string;
  source: JobSource;
  sourceJobId: string;
  title: string;
  company: string;
  location: string;
  remote: boolean | null;
  /** Full JD text. May contain HTML from the source; treat as untrusted. */
  description: string;
  /** Direct application URL. */
  url: string;
  postedAt: string | null; // ISO 8601
  fetchedAt: string; // ISO 8601
  /** Human-readable pay summary when the board publishes one, e.g. "$211K – $290K". */
  compensation: string | null;
  /** e.g. "FullTime", "Contract" — only some boards report it. */
  employmentType: string | null;
  /** Owning team/department when the board reports one. */
  department: string | null;
}

/**
 * What one source adapter returns for a run.
 *
 * `scopes` is the delisting contract, and it is deliberately narrow: list a scope
 * key ONLY if this run enumerated every open job for it. Board APIs keyed by
 * company (Greenhouse/Lever/Ashby) can promise that per company, so a job of
 * theirs that stops appearing really is closed. Search feeds (RemoteOK, JSearch,
 * Adzuna, USAJobs) return a slice of a moving result set — a job vanishing from
 * page 1 means nothing — so they return no scopes and nothing of theirs is ever
 * auto-closed. A scope also must not be listed when its fetch FAILED, or one
 * transient 500 would close every job that company has.
 */
export interface SourceResult {
  jobs: Job[];
  scopes: string[];
}

export interface FitScore {
  jobId: string;
  score: number; // 0-100
  reason: string;
  model: string;
  scoredAt: string; // ISO 8601
}

/**
 * Where a job stands. "new"/"applied"/"skipped" are the original three; the
 * interview stages were added so that marking something applied isn't a dead end.
 */
export type ApplicationStatus =
  "new" | "applied" | "screen" | "onsite" | "offer" | "rejected" | "skipped";

/**
 * Model tag for a score that stood in for a failed LLM call. It is a real row
 * with a real (prefilter) score so the job still surfaces, but it is NOT an
 * answer — unscoredJobs picks it back up, and the UI marks it as provisional.
 *
 * Lives here rather than in lib/store.ts so client components can compare
 * against it without importing better-sqlite3 into the browser bundle.
 */
export const FALLBACK_MODEL = "prefilter-fallback";

export const APPLICATION_STATUSES: ApplicationStatus[] = [
  "new",
  "applied",
  "screen",
  "onsite",
  "offer",
  "rejected",
  "skipped",
];

/** Statuses that mean an application actually went out. */
export const SUBMITTED_STATUSES: ApplicationStatus[] = [
  "applied",
  "screen",
  "onsite",
  "offer",
  "rejected",
];

/**
 * Statuses where the application is over and there is nothing left to chase.
 *
 * Lives beside the other two lists rather than as SQL literals in the one query
 * that needs it: the status set has already grown once, from new/applied/skipped
 * to the interview stages, and a hardcoded copy is exactly the drift
 * app/api/apply/route.ts had to be fixed for.
 */
export const TERMINAL_STATUSES: ApplicationStatus[] = ["rejected", "skipped"];

export interface Application {
  jobId: string;
  status: ApplicationStatus;
  updatedAt: string; // ISO 8601
  /** Set the first time this job reaches a submitted status. */
  appliedAt: string | null;
  /** Free-form notes: recruiter name, what you said, how it went. */
  notes: string;
  /** Date you mean to chase this up. */
  followUpAt: string | null;
  contact: string;
  /** Comp discussed/posted, in your words. */
  compNotes: string;
}

export interface ResumeVersion {
  id: string;
  jobId: string;
  content: string; // tailored resume, markdown
  draftedAnswers: string; // drafted answers to common application questions
  coverLetter: string; // reserved; no code path populates this yet (see lib/tailor.ts)
  model: string;
  createdAt: string; // ISO 8601
}

export type ArtifactKind = "resume-md" | "resume-docx" | "answers-md" | "cover-letter-md";

/**
 * A file on disk generated for a job. The tailored .docx you actually attach used
 * to live loose in the repo root with nothing tying it back to the job row, so
 * "applied" told you nothing about what you'd sent.
 */
export interface Artifact {
  id: string;
  jobId: string;
  kind: ArtifactKind;
  path: string;
  createdAt: string; // ISO 8601
}

/** A job joined with its fit score and application status, for the UI. */
export interface JobWithMeta extends Job {
  fit: FitScore | null;
  status: ApplicationStatus;
  hasResume: boolean;
  lastSeenAt: string;
  closedAt: string | null;
}

/**
 * Queue-list shape: JobWithMeta minus the description, plus the role family.
 *
 * The list view never rendered descriptions, but shipping them made /api/jobs a
 * 9.6 MB response. `category` goes the other way — it is derived from the title
 * by lib/categories.ts, which needs the profile config off disk and so cannot
 * run in the browser. The server has to hand it over.
 */
export type JobListItem = Omit<JobWithMeta, "description"> & {
  category: string;
};
