// Verify a tailored résumé invents nothing that isn't in your master résumé.
//
//   npx tsx scripts/check-resume.ts resumes/tailored-acme-sre.md
//   npm run check-resume -- resumes/tailored-acme-sre.md --company "Acme"
//
// Exits 1 when something is unsupported, so it can gate a send.

import { readFileSync } from "node:fs";
import { loadResumeBase } from "../lib/profile";
import { formatReport, verifyAgainstBase } from "../lib/verify";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

function main() {
  const file = process.argv[2];
  if (!file || file.startsWith("--")) {
    console.error(
      "Usage: npx tsx scripts/check-resume.ts <tailored.md> [--company Acme] [--base other.md]",
    );
    process.exit(1);
  }

  const baseFile = flag("base");
  const base = baseFile ? readFileSync(baseFile, "utf8") : loadResumeBase();

  const tailored = readFileSync(file, "utf8");

  // The answers section is working notes, not résumé content — it legitimately
  // contains target numbers that were never in the master résumé.
  const resumeOnly = tailored.split(/^#\s+Drafted answers\s*$/m)[0];

  // The company being applied to is not a claim of having worked there. Every
  // other caller of verifyAgainstBase already passes this; without it a summary
  // line naming the target employer reads as an invented job. Optional, because
  // this script is also run over a résumé whose target isn't known.
  const company = flag("company");

  const report = verifyAgainstBase(resumeOnly, base, company ? [company] : []);
  console.log(formatReport(report));
  if (!report.ok) process.exit(1);
}

main();
