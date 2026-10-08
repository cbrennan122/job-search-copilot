// Where generated application files live.
//
//   resumes/            <- the .docx you actually send
//   resumes/markdown/   <- the .md sources (résumé + drafted answers)
//
// Split on purpose: the base directory is then exactly the set of documents
// ready to hand to an employer, instead of those interleaved with the working
// Markdown and its PREP-ONLY answers files. `resumes/` is gitignored whole, so
// the subdirectory is covered too, and writeOutput() creates either on demand.
//
// Paths are built from LITERAL segments. See the turbopack note in AGENTS.md:
// joining a computed base directory in lib/ made the bundler give up on static
// analysis and trace the entire project into the server bundle.

import path from "node:path";
import type { Job } from "./types";

export const RESUMES_DIR = path.join(process.cwd(), "resumes");
export const RESUMES_MARKDOWN_DIR = path.join(process.cwd(), "resumes", "markdown");

/**
 * Filename-safe fragment from a company or job title. Collapses every run of
 * non-alphanumerics to one dash so "Senior SDET: Automation, API & Performance"
 * cannot produce a path separator, a leading dot, or a shell-hostile name.
 */
export function fileSlug(s: string): string {
  return (
    s
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "resume"
  );
}

/**
 * The identity a generated file is named for: the SAME three fields
 * `makeJobId(title, company, location)` hashes.
 *
 * Location is in the name because leaving it out was a real bug, not a
 * cosmetic one. Company+title alone gave two distinct jobs one filename — a
 * board posts the same title across several location sets — so tailoring the
 * second job overwrote the first job's file in place. Reads resolve through
 * the job's own artifact row, so job A still found "its" file and was served
 * job B's résumé, flagged `diverged` as though a human had reviewed it.
 * Reproduced 2026-09-03; 223 company+title groups in the queue hold more than
 * one job. Keying the path on exactly what keys the job id is what closes it.
 */
export type JobFileKey = Pick<Job, "id" | "company" | "title" | "location">;

/**
 * A SLUG IS LOSSY, SO IT CANNOT BE THE WHOLE NAME. fileSlug collapses every run
 * of non-alphanumerics to one dash and truncates at 60 characters, and the join
 * uses that same dash — so distinct jobs still landed on one filename three
 * ways: punctuation variants ("Solutions Consultant | Enterprise" against
 * ", Enterprise"), titles agreeing on their first 60 characters, and text that
 * straddles a literal dash differently ({"A", "B-C"} against {"A-B", "C"}).
 * Adding location cut the real queue from 223 colliding company+title groups to
 * 7 colliding paths over 3313 jobs — better, still not zero, and the failure is
 * silent: job A is handed job B's résumé, and the .docx is the file sent.
 *
 * The job id is the hash of exactly the three fields this stem renders, so an
 * 8-character prefix restores precisely the information slugging threw away.
 * Pass --out to name a file anything you like; this is only the default.
 */
function fileStem(job: JobFileKey): string {
  const parts = [fileSlug(job.company), fileSlug(job.title)];
  // Dropped only when the board left the field blank: fileSlug("") would inject
  // its "resume" fallback and put a meaningless word in the filename.
  if (job.location.trim()) parts.push(fileSlug(job.location));
  parts.push(job.id.slice(0, 8));
  return parts.join("-");
}

/** `resumes/<Company>-<Title>-<Location>.docx` — the document to send. */
export function docxPathFor(job: JobFileKey): string {
  return path.join(RESUMES_DIR, `${fileStem(job)}.docx`);
}

/** `resumes/markdown/<Company>-<Title>-<Location>.md` — the résumé source. */
export function resumeMdPathFor(job: JobFileKey): string {
  return path.join(RESUMES_MARKDOWN_DIR, `${fileStem(job)}.md`);
}

/** `resumes/markdown/<Company>-<Title>-<Location>-answers.md` — PREP ONLY, never sent. */
export function answersMdPathFor(job: JobFileKey): string {
  return path.join(RESUMES_MARKDOWN_DIR, `${fileStem(job)}-answers.md`);
}

/**
 * Default `.docx` path for a given `.md` input: alongside it, EXCEPT for sources
 * under `resumes/markdown/`, which render up into `resumes/`. Without that carve-out
 * moving the Markdown into its own directory would quietly start writing sendable
 * documents there too, which is exactly the mixing the split exists to prevent.
 * `profile/resume_base.md` and any ad-hoc path still render beside themselves.
 */
export function docxSibling(mdPath: string): string {
  const base = path.basename(mdPath).replace(/\.md$/i, "") + ".docx";
  const dir = path.dirname(path.resolve(mdPath));
  return dir === RESUMES_MARKDOWN_DIR
    ? path.join(RESUMES_DIR, base)
    : path.join(path.dirname(mdPath), base);
}
