// Draft a cover letter for one job description.
//
//   npx tsx scripts/cover-letter.ts resumes/jd-acme-sre.txt --company "Acme" --title "SRE" \
//     --out resumes/markdown/cover-acme-sre.md
//
// Markdown output belongs in resumes/markdown/ — the base resumes/ directory holds the
// .docx files you actually send. See lib/paths.ts for the layout.
//   pbpaste | npx tsx scripts/cover-letter.ts --company "Acme"
//
// Needs ANTHROPIC_API_KEY. The draft is checked against your master résumé the
// same way tailored résumés are — see scripts/check-resume.ts.

import { readFileSync } from "node:fs";
import { draftCoverLetter } from "../lib/cover";
import { requireEnv } from "../lib/env";
import { writeOutput } from "../lib/outfile";
import { loadResumeBase } from "../lib/profile";
import { formatReport, verifyAgainstBase } from "../lib/verify";

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function isFlagValue(arg: string): boolean {
  const i = process.argv.indexOf(arg);
  return i > 0 && process.argv[i - 1].startsWith("--");
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  // Fail before doing any work if the key is missing.
  requireEnv("ANTHROPIC_API_KEY");
  const file = process.argv.slice(2).find((a) => !a.startsWith("--") && !isFlagValue(a));
  const description = file ? readFileSync(file, "utf8") : await readStdin();
  if (!description.trim()) {
    console.error(
      "Usage: npx tsx scripts/cover-letter.ts <jd.txt> [--company X --title Y --out z.md]",
    );
    process.exit(1);
  }

  const company = flag("company", "Unspecified");
  const out = await draftCoverLetter({
    title: flag("title", "Unspecified"),
    company,
    location: flag("location", "Unspecified"),
    description,
  });

  const outPath = flag("out", "");
  if (outPath) {
    writeOutput(outPath, `${out.content}\n`);
    console.error(`Wrote cover letter to ${outPath} (model: ${out.model}).`);
  } else {
    process.stdout.write(`${out.content}\n`);
  }

  // Same verify-don't-trust rule as the résumé path.
  console.error("");
  // The company being applied to is mentioned all over a cover letter; that is
  // not a claim of having worked there, so it must not be flagged as one.
  console.error(formatReport(verifyAgainstBase(out.content, loadResumeBase(), [company])));
  console.error(
    "\nCheck every [FILL IN] before sending — the model is instructed to leave " +
      "them rather than invent a reason for wanting this job.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
