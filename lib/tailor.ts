// Resume tailoring via Claude Sonnet. Takes your master resume + a job
// description and produces a tailored resume plus drafted answers to common
// application questions. Saves each result as a ResumeVersion.
//
// CRITICAL GUARDRAIL: the model may only re-emphasize, reorder, and rephrase
// what's already in the master resume. It must never invent experience, skills,
// employers, dates, or metrics. That rule lives in the system prompt below and
// is the single most important correctness property of this tool.

import { randomUUID } from "node:crypto";
import { anthropic, MODELS, textOf } from "./anthropic";
import { writeOutput } from "./outfile";
import { answersMdPathFor, resumeMdPathFor } from "./paths";
import { loadResumeBase } from "./profile";
import { getJob, latestResume, saveArtifact, saveResumeVersion } from "./store";
import type { ResumeVersion } from "./types";

const SYSTEM = `You are a resume tailoring assistant for a job seeker.

You are given the candidate's MASTER RESUME (their real, complete background) and
a JOB DESCRIPTION. Produce a tailored version of the resume for this specific job.

ABSOLUTE RULES:
- Use ONLY facts present in the master resume. Never invent or imply experience,
  skills, tools, employers, titles, dates, degrees, or metrics that are not there.
- If the job wants something the candidate lacks, do NOT fabricate it. You may
  surface genuinely-related real experience, but never claim the missing skill.
- You MAY reorder sections/bullets, rewrite bullets to foreground relevant work,
  mirror the job's terminology/keywords where it truthfully applies (ATS matching),
  and trim clearly-irrelevant content.

Output EXACTLY this structure and nothing else:
<resume>
(the full tailored resume, in markdown)
</resume>
<answers>
(brief drafted answers to 3-5 common application questions for THIS role, e.g.
"Why this company?", "Relevant experience?", "Salary expectations?" — each as a
short paragraph the candidate can edit. Draw only on the resume; mark anything
that needs the candidate's real input as [FILL IN].)
</answers>`;

function extract(tag: string, s: string): string {
  const m = s.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
  return (m ? m[1] : "").trim();
}

export interface TailorInput {
  title: string;
  company: string;
  location: string;
  description: string;
}

export interface TailorOutput {
  content: string;
  draftedAnswers: string;
  model: string;
}

/**
 * Core tailoring call: master resume + a job description → tailored resume +
 * drafted answers. Pure (no DB); works for stored jobs and ad-hoc pasted JDs.
 */
export async function tailorDescription(job: TailorInput): Promise<TailorOutput> {
  const resume = loadResumeBase();

  const user = [
    "## MASTER RESUME",
    resume,
    "",
    "## JOB DESCRIPTION",
    `Title: ${job.title}`,
    `Company: ${job.company}`,
    `Location: ${job.location}`,
    "",
    job.description.slice(0, 8000),
  ].join("\n");

  // Stream so long outputs don't hit HTTP timeouts; take the final message.
  const stream = anthropic().messages.stream({
    model: MODELS.tailoring,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    system: SYSTEM,
    messages: [{ role: "user", content: user }],
  });
  const msg = await stream.finalMessage();
  const out = textOf(msg);

  return {
    content: extract("resume", out) || out,
    draftedAnswers: extract("answers", out),
    model: MODELS.tailoring,
  };
}

/** Tailor the master resume for one stored job; persists and returns the version. */
export async function tailorForJob(jobId: string): Promise<ResumeVersion> {
  const job = getJob(jobId);
  if (!job) throw new Error(`No job with id ${jobId}`);

  const out = await tailorDescription({
    title: job.title,
    company: job.company,
    location: job.location,
    description: job.description,
  });

  const version: ResumeVersion = {
    id: randomUUID(),
    jobId,
    content: out.content,
    draftedAnswers: out.draftedAnswers,
    // Always empty: nothing writes this field yet. The cover-letter path is
    // scripts/cover-letter.ts, which drafts from a JD file and writes to disk —
    // draftCoverLetter() is deliberately pure and never sees a jobId, so it has
    // no row to update. Populating this needs a DB-aware entry point that does
    // not exist; until one does, the column is reserved, not maintained.
    coverLetter: "",
    model: out.model,
    createdAt: new Date().toISOString(),
  };
  saveResumeVersion(version);

  // Write the Markdown to disk as well as the row. Tailoring from the dashboard
  // used to persist ONLY to resume_versions, so the UI path produced a résumé
  // with no file behind it — nothing to edit, diff, or hand to to-docx.ts, and
  // no way to reach a .docx at all.
  //
  // Résumé and answers go to SEPARATE files for the same reason scripts/tailor.ts
  // splits them: the answers carry [FILL IN] placeholders and salary posture, and
  // lib/docx-render.ts renders any "# Drafted answers" heading onto a second page
  // — which is how prep notes end up in a document sent to an employer.
  const resumePath = resumeMdPathFor(job);
  writeOutput(resumePath, `# Tailored résumé\n\n${version.content}\n`);
  saveArtifact(jobId, "resume-md", resumePath);

  if (version.draftedAnswers.trim()) {
    const answersPath = answersMdPathFor(job);
    writeOutput(
      answersPath,
      `# Drafted answers\n\n` +
        `**PREP ONLY — do not submit.** Contains fill-in placeholders and salary posture.\n\n` +
        `${version.draftedAnswers}\n`,
    );
    saveArtifact(jobId, "answers-md", answersPath);
  }

  return version;
}

/** Get the latest tailored resume for a job, generating one if none exists. */
export async function ensureResume(jobId: string): Promise<ResumeVersion> {
  return latestResume(jobId) ?? (await tailorForJob(jobId));
}
