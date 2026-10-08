// Convert a Markdown résumé (the master resume or a tailored output from
// scripts/tailor.ts) into a .docx that matches the user's polished résumé template.
//
//   npx tsx scripts/to-docx.ts resumes/markdown/tailored-acme-sre.md
//   npx tsx scripts/to-docx.ts resumes/markdown/tailored-acme-sre.md --out resumes/Acme.docx
//   npx tsx scripts/to-docx.ts profile/resume_base.md
//   npx tsx scripts/to-docx.ts resumes/markdown/tailored-acme-sre.md --job-id <id>
//   npx tsx scripts/to-docx.ts --job-id <id>        # render what the dashboard tailored
//
// With no --out the .docx is written beside its .md. With --job-id and no .md it
// lands in resumes/ as <Company>-<Title>-<Location>-<id8>.docx — see lib/paths.ts.
//
// --job-id records the generated .docx against a job row, so "applied" can say
// which file you actually attached. It is the only thing here that touches the
// database; without it this stays a pure formatter that opens nothing.
//
// --job-id with NO .md also SOURCES the résumé, via lib/resume-source.ts: the
// .md on disk when there is one, else the newest resume_versions row. The file
// wins because it is the copy a human last reviewed — reading the row after an
// edit renders the pre-review draft. Only the résumé is rendered either way;
// `draftedAnswers` is a separate column and is never appended, the same
// separation scripts/tailor.ts enforces on disk with a sibling -answers.md.
//
// This file is ONLY the CLI. The renderer and the style spec live in
// lib/docx-render.ts, shared with the dashboard's Download button so both
// produce the same bytes.

import { readFileSync } from "node:fs";
import { DRAFTED_ANSWERS_HEADING, renderResumeDocx } from "../lib/docx-render";
import { loadLocalEnv } from "../lib/env";
import { writeOutput } from "../lib/outfile";
import { docxPathFor, docxSibling } from "../lib/paths";
import { commitResumeEdit, resolveResumeMarkdown } from "../lib/resume-source";
import { getJob, saveArtifact } from "../lib/store";

async function main() {
  const positional = process.argv.slice(2).find((a) => !a.startsWith("--") && !isFlagValue(a));
  const jobId = flag("job-id", "");
  if (!positional && !jobId) {
    console.error(
      "Usage: npx tsx scripts/to-docx.ts <input.md> [--out file.docx] [--job-id <id>]\n" +
        "       npx tsx scripts/to-docx.ts --job-id <id> [--out file.docx]",
    );
    process.exit(1);
  }

  // Resolve the job BEFORE rendering, so a mistyped id costs nothing and fails
  // with a sentence rather than with "FOREIGN KEY constraint failed" after the
  // document is already on disk.
  let md: string;
  let source: string;
  let defaultOut: string;

  if (jobId) {
    // JOB_COPILOT_DB can be set in .env.local, and bare tsx does not read it.
    // Recording the artifact in a different database from the one the rest of
    // the tool reads would be worse than not recording it at all.
    loadLocalEnv();
    const job = getJob(jobId);
    if (!job) {
      console.error(
        `No job with id ${jobId} is in the queue.\n` +
          `Find the right id in the dashboard, or with: npm run digest`,
      );
      process.exit(1);
    }
    if (positional) {
      md = readFileSync(positional, "utf8");
      source = positional;
      defaultOut = docxSibling(positional);
    } else {
      // No .md given: resolve it. The file on disk wins over the stored row —
      // see lib/resume-source.ts. Only the résumé is rendered; the drafted
      // answers live in their own column/file and must not reach the document.
      const resolved = resolveResumeMarkdown(job);
      if (!resolved) {
        console.error(
          `Job ${jobId} has no tailored résumé yet.\n` +
            `Tailor it from the job's page in the dashboard, or with:\n` +
            `  npm run tailor -- <jd file> --company "<Company>" --title "<Title>" --out resumes/<name>.md`,
        );
        process.exit(1);
      }
      md = resolved.markdown;
      defaultOut = docxPathFor(job);
      // Before the branch: a candidate file can be rejected and STILL leave us
      // on a later file, so this is not only the row case.
      if (resolved.warning) console.error(`!! ${resolved.warning}`);
      if (resolved.from === "file") {
        source = resolved.path;
        console.error(`Rendering ${source}.`);
        if (resolved.diverged) {
          // Producing the document is the moment the edit becomes real, so it is
          // also where resume_versions catches up — otherwise the row stays the
          // pre-review draft forever and stops being version history.
          console.error(`   ^ edited since it was tailored — rendering the file.`);
          // Pass the resolution we already have: re-resolving would re-read the
          // file and re-run the query only to reach the same conclusion.
          const committed = commitResumeEdit(job, resolved);
          if (committed) console.error(`   ^ recorded those edits as a new résumé version.`);
        }
      } else {
        source = `the résumé tailored ${resolved.version.createdAt} (${resolved.version.model})`;
        console.error(`Rendering ${source}.`);
      }
    }
  } else {
    md = readFileSync(positional!, "utf8");
    source = positional!;
    defaultOut = docxSibling(positional!);
  }

  const outPath = flag("out", defaultOut);

  // Last line of defense: scripts/tailor.ts now writes answers to a separate file, but an
  // older combined .md still renders its prep notes (and [FILL IN] markers) onto page 2.
  if (DRAFTED_ANSWERS_HEADING.test(md)) {
    console.error(
      `\n!! ${source} contains a "# Drafted answers" section.\n` +
        `!! It will render as a second page of ${outPath} — including any [FILL IN] markers\n` +
        `!! and salary posture. Split it into a sibling -answers.md before sending this out.\n`,
    );
  }

  writeOutput(outPath, await renderResumeDocx(md));
  console.error(`Wrote ${outPath}`);

  // Only after the write succeeded: a row pointing at a file that was never
  // written is worse than no row, because it answers "what did I send?" wrongly
  // instead of admitting it does not know.
  if (jobId) {
    const a = saveArtifact(jobId, "resume-docx", outPath);
    console.error(`Recorded ${a.kind} against job ${jobId}`);
  }
}

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function isFlagValue(arg: string): boolean {
  const i = process.argv.indexOf(arg);
  return i > 0 && process.argv[i - 1].startsWith("--");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
