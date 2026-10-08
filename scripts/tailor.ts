// Tailor your master resume against a single job description — no DB, no
// aggregation run needed. Paste/point at a JD and get a tailored resume back.
//
//   npx tsx scripts/tailor.ts jd.txt
//   npx tsx scripts/tailor.ts resumes/jd-acme-sre.txt --company "Acme" --title "SRE" \
//     --out resumes/tailored-acme-sre.md
//
// Generated output belongs in resumes/ — it is gitignored whole, and keeping a job's
// JD, résumé and answers together is what stops the repo root filling up with them.
// The directory is created on write, so it does not need to exist first.
//   pbpaste | npx tsx scripts/tailor.ts            # read JD from stdin
//
// Needs ANTHROPIC_API_KEY (loaded from .env.local automatically).

import { readFileSync } from "node:fs";
import { requireEnv } from "../lib/env";
import { writeOutput } from "../lib/outfile";
import { loadResumeBase } from "../lib/profile";
import { tailorDescription } from "../lib/tailor";
import { formatReport, verifyAgainstBase } from "../lib/verify";

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

async function main() {
  // Fail before doing any work if the key is missing.
  requireEnv("ANTHROPIC_API_KEY");
  // First non-flag arg (after node + script) is the JD file path, if any.
  const positional = process.argv.slice(2).find((a) => !a.startsWith("--") && !isFlagValue(a));

  const description = (positional ? readFileSync(positional, "utf8") : readStdin()).trim();
  if (!description) {
    console.error(
      "No job description. Pass a file path (npx tsx scripts/tailor.ts jd.txt) or pipe it via stdin.",
    );
    process.exit(1);
  }

  const company = flag("company", "Unspecified");
  const out = await tailorDescription({
    title: flag("title", "Unspecified"),
    company,
    location: flag("location", "Unspecified"),
    description,
  });

  // Résumé and drafted answers go to SEPARATE files on purpose. The answers carry
  // [FILL IN] placeholders and salary posture, and scripts/to-docx.ts renders any
  // "# Drafted answers" heading onto a second page — so keeping them in one file
  // means the .docx sent to an employer contains the prep notes.
  const resume = `# Tailored résumé\n\n${out.content}\n`;
  const answers =
    `# Drafted answers\n\n` +
    `**PREP ONLY — do not submit.** Contains fill-in placeholders and salary posture.\n\n` +
    `${out.draftedAnswers}\n`;

  const outPath = flag("out", "");
  if (outPath) {
    const answersPath = outPath.replace(/\.md$/i, "") + "-answers.md";
    writeOutput(outPath, resume);
    writeOutput(answersPath, answers);
    console.error(`Wrote tailored résumé to ${outPath} (model: ${out.model}).`);
    console.error(`Wrote drafted answers to ${answersPath} — prep only, do not submit.`);
  } else {
    // No --out: emit only the résumé to stdout so a naive `> file.md` can't
    // capture the prep notes into something that later gets converted.
    process.stdout.write(resume);
    process.stderr.write(`\n[drafted answers omitted from stdout — pass --out to write them]\n`);
  }

  // Verify rather than trust. The no-fabrication rule lives in a system prompt,
  // and a prompt is not a guarantee — so every generated résumé is checked
  // against the master before you ever look at it. Written to stderr so it never
  // contaminates a piped résumé.
  const report = verifyAgainstBase(out.content, loadResumeBase(), [company]);
  console.error("");
  console.error(formatReport(report));
}

// A token is a flag's value if the token immediately before it is a --flag.
function isFlagValue(arg: string): boolean {
  const i = process.argv.indexOf(arg);
  return i > 0 && process.argv[i - 1].startsWith("--");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
