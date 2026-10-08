// Cover letter drafting via Claude Sonnet.
//
// Same guardrail as lib/tailor.ts, and for the same reason: a cover letter is
// the easiest place for a model to "help" by inventing enthusiasm-shaped facts
// ("I led the migration of your competitor's billing stack"). It may only draw
// on the master résumé, and anything requiring the candidate's own input is
// marked [FILL IN] rather than guessed.

import { anthropic, MODELS, textOf } from "./anthropic";
import { loadResumeBase } from "./profile";

const SYSTEM = `You draft cover letters for a job seeker.

You are given the candidate's MASTER RESUME (their real background) and a JOB
DESCRIPTION. Write a cover letter for this specific role.

ABSOLUTE RULES:
- Use ONLY facts present in the master resume. Never invent or imply experience,
  skills, tools, employers, titles, dates, degrees, or metrics that are not there.
- Never claim knowledge of, or affinity for, the company beyond what the job
  description itself states. If a personal reason to want this job would strengthen
  the letter, write [FILL IN: why this company appeals to you] instead of inventing one.
- Do not restate the resume line by line. Pick the two or three most relevant real
  accomplishments and connect them to what this role actually needs.
- No filler openings ("I am writing to express my keen interest"). Start with
  something specific to the role.

STYLE: 250-350 words, four short paragraphs at most, plain confident prose, first
person, no bullet lists, no em-dash-heavy flourishes. Sign off with the candidate's
name exactly as it appears at the top of the master resume.

Output ONLY the letter body, in markdown. No preamble, no commentary.`;

export interface CoverInput {
  title: string;
  company: string;
  location: string;
  description: string;
}

export interface CoverOutput {
  content: string;
  model: string;
}

/** Master résumé + one job description → a cover letter draft. Pure (no DB). */
export async function draftCoverLetter(job: CoverInput): Promise<CoverOutput> {
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

  const stream = anthropic().messages.stream({
    model: MODELS.tailoring,
    max_tokens: 2000,
    system: SYSTEM,
    messages: [{ role: "user", content: user }],
  });
  const msg = await stream.finalMessage();

  return { content: textOf(msg).trim(), model: MODELS.tailoring };
}
