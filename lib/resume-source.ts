// Which Markdown is the CURRENT résumé for a job?
//
// Two copies exist and nothing keeps them in sync. `tailorForJob()` writes the
// `resume_versions` row and a `.md` under `resumes/markdown/` together, so they
// start identical — then the `review-resume` skill has you EDIT the file, and
// from that moment the row is the pre-review draft. Rendering from the row after
// a review is how a résumé that was reviewed and corrected gets sent in its
// uncorrected form. Verified 2026-08-28: a bullet cut from the reviewed file was
// still present in `latestResume().content` afterwards.
//
// So the FILE wins when one exists: it is the copy a human last looked at. The
// row is the fallback, and `commitResumeEdit()` is how the row catches up so
// `resume_versions` stays real version history instead of rotting into a stale
// first draft.
//
// THE FILE IS FOUND VIA THIS JOB'S OWN `resume-md` ARTIFACT ROW, never by
// recomputing the path. That indirection was introduced because the computed
// path omitted `location` while `makeJobId(title, company, location)` includes
// it, so distinct jobs shared one filename — 208 of the queue's 2764 résumé
// paths on 2026-08-28 (a board posts one title across several location sets).
//
// `lib/paths.ts` now keys the filename on location too, so new files no longer
// collide at the source. Resolving through the artifact row still matters for
// two reasons: rows are per-job by construction, so this cannot regress if the
// naming scheme changes again, and files written under the OLD scheme keep
// working because their row records where they actually are.

// One resolver, shared by every caller, for the same reason
// `lib/docx-render.ts` is one renderer: two answers to "what am I about to send"
// would drift, and only one of them would be the file actually sent.

import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { isTailoredHeading } from "./docx-render";
import { latestResume, listArtifacts, saveResumeVersion } from "./store";
import type { Artifact, Job, ResumeVersion } from "./types";

/** Where the résumé came from, and everything that depends on that. */
export type ResumeSource =
  // Discriminated on `from` so `path` and `version` are non-optional exactly
  // where they exist — the previous shape made both callers reach for `!`.
  | {
      from: "file";
      /** Raw file text, for the renderer (which skips the wrapper heading). */
      markdown: string;
      /** Wrapper stripped and normalized, for display and comparison. */
      body: string;
      path: string;
      /** The file differs from the stored row: the row is stale. */
      diverged: boolean;
      version: ResumeVersion | null;
      /** Set when an EARLIER candidate file was found but rejected. */
      warning?: string;
    }
  | {
      from: "row";
      markdown: string;
      body: string;
      diverged: false;
      version: ResumeVersion;
      /** Set when a file was found but rejected, so callers can say why. */
      warning?: string;
    };

/**
 * `model` for a row written from a hand-edited file, and for the synthetic row
 * shown when a file exists with no row behind it. One constant because the two
 * were typed out independently in two files and nothing tied them together.
 */
export const HAND_EDITED_MODEL = "hand-edited";

/**
 * Compare and display on the résumé body alone. Normalizes the things an editor
 * changes without changing meaning — a BOM, CRLF line endings, trailing
 * whitespace, and Unicode form — so a resave cannot masquerade as an edit. NFC
 * matters because "résumé" typed with a combining accent is a different byte
 * string from the precomposed form and would otherwise read as diverged.
 */
function body(md: string): string {
  const normalized = md.replace(/^﻿/, "").replace(/\r\n?/g, "\n").normalize("NFC");
  const lines = normalized.split("\n");
  // Drop a leading "# Tailored résumé" wrapper, using the SAME predicate the
  // renderer uses to skip it.
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  const heading = lines[i]?.match(/^#\s+(.*)$/);
  if (heading && isTailoredHeading(heading[1])) lines.splice(0, i + 1);
  return lines
    .map((l) => l.replace(/[ \t]+$/, ""))
    .join("\n")
    .trim();
}

/**
 * A path fit to appear in a `warning`, which crosses the wire to the browser.
 *
 * The detail route deliberately stopped sending `resumeSource.path` because an
 * absolute path puts the server's directory layout (and the OS username) into a
 * JSON response for no benefit — so the warning must not smuggle the same
 * string back in. Repo-relative reads better in the CLI too.
 */
function shortPath(p: string): string {
  const rel = path.relative(process.cwd(), p);
  return rel && !rel.startsWith("..") ? rel : path.basename(p);
}

/**
 * The newest existing `.md` this job actually owns, plus anything that was
 * found and rejected on the way there.
 */
function ownedResumeFile(artifacts: Artifact[]): {
  file: { path: string; markdown: string } | null;
  warnings: string[];
} {
  const warnings: string[] = [];
  for (const a of artifacts) {
    if (a.kind !== "resume-md") continue;
    // A row pointing at a file that is simply GONE is the ordinary case, not a
    // fault: saveArtifact never dedupes and rows dangle when a file is moved or
    // deleted. Skipping those silently is why this check earns its keep even
    // though the catch below would also swallow the ENOENT — without it every
    // stale row would produce a warning the user can do nothing about.
    try {
      if (!existsSync(a.path)) continue;
    } catch {
      continue;
    }
    try {
      // existsSync -> readFileSync is a TOCTOU window, and a directory at the
      // path throws EISDIR rather than returning "". Both land here so a
      // filesystem problem cannot become an unstyled 500 in the route.
      return { file: { path: a.path, markdown: readFileSync(a.path, "utf8") }, warnings };
    } catch (e) {
      // A permissions or I/O error is NOT "no edit was made". Swallowing it
      // served the stale row with nothing to say why the reviewed file was
      // passed over.
      // The code, not the message: a Node fs error message embeds the absolute
      // path, which is the very thing shortPath exists to keep off the wire.
      const code = (e as NodeJS.ErrnoException).code ?? "unreadable";
      warnings.push(`${shortPath(a.path)} could not be read (${code}) — skipped it.`);
    }
  }
  return { file: null, warnings };
}

/**
 * Null only when the job has neither a stored résumé nor a usable file — the
 * caller turns that into its own "tailor it first" message.
 *
 * Takes the `Job` rather than an id because every caller has already loaded it;
 * re-fetching would be a second query that could disagree with the caller's.
 * `artifacts` is likewise accepted so a caller that has already listed them
 * (the detail route renders them) does not pay for the same query twice.
 */
export function resolveResumeMarkdown(job: Job, artifacts?: Artifact[]): ResumeSource | null {
  const version = latestResume(job.id);
  const { file, warnings } = ownedResumeFile(artifacts ?? listArtifacts(job.id));

  if (file) {
    const fileBody = body(file.markdown);
    // An empty or whitespace-only file is corruption, not an edit. Preferring it
    // renders a zero-paragraph .docx that saveArtifact then records as the
    // document that was sent.
    if (fileBody === "") {
      warnings.push(
        `${shortPath(file.path)} is empty — falling back to the résumé stored for this job.`,
      );
    } else {
      return {
        from: "file",
        markdown: file.markdown,
        body: fileBody,
        path: file.path,
        diverged: version ? fileBody !== body(version.content) : false,
        version,
        warning: warnings.length ? warnings.join(" ") : undefined,
      };
    }
  }

  if (version) {
    return {
      from: "row",
      markdown: version.content,
      body: body(version.content),
      diverged: false,
      version,
      warning: warnings.length ? warnings.join(" ") : undefined,
    };
  }
  // Unreachable with a rejected file in hand: tailorForJob() writes the row
  // before the file, so an artifact row implies a version row.
  return null;
}

/**
 * The résumé as a displayable `ResumeVersion`.
 *
 * A file can exist with no row behind it, and every consumer that shows résumé
 * metadata then has to invent one. Doing that at the call site is how the
 * `HAND_EDITED_MODEL` sentinel came to be written out independently in two
 * files with nothing tying them together.
 */
export function resumeForDisplay(jobId: string, resolved: ResumeSource): ResumeVersion {
  return {
    ...(resolved.version ?? {
      id: "",
      jobId,
      draftedAnswers: "",
      coverLetter: "",
      model: HAND_EDITED_MODEL,
      createdAt: "",
    }),
    // Always the resolved body: the point of the resolver is that this is the
    // text the renderer will use, whichever copy it came from.
    content: resolved.body,
  };
}

/**
 * Bring `resume_versions` up to date with an edited file, as a NEW row.
 *
 * Without this the row is frozen at the pre-review draft forever and the table
 * stops being version history. It is deliberately explicit rather than automatic
 * on read: a GET that writes is the wrong shape, so the CLI commits at the point
 * a document is actually produced, and the dashboard's download stays read-only.
 *
 * Returns the row it wrote, or null when there was nothing to commit.
 *
 * `resolved` is accepted so the caller that just rendered the document does not
 * re-read the file and re-run the query to be told the same thing.
 */
export function commitResumeEdit(job: Job, resolved?: ResumeSource | null): ResumeVersion | null {
  const src = resolved ?? resolveResumeMarkdown(job);
  if (!src || src.from !== "file" || !src.diverged) return null;

  const committed: ResumeVersion = {
    id: randomUUID(),
    jobId: job.id,
    // The body, not the raw file: `content` has never carried the wrapper
    // heading, and writing it in would make the next comparison diverge.
    content: src.body,
    // Answers live in their own column and their own file; this only ever
    // reconciles the résumé, so carry the existing value rather than blanking it.
    draftedAnswers: src.version?.draftedAnswers ?? "",
    coverLetter: src.version?.coverLetter ?? "",
    model: HAND_EDITED_MODEL,
    createdAt: new Date().toISOString(),
  };
  saveResumeVersion(committed);
  return committed;
}
