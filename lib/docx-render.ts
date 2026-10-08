// Render a Markdown résumé into a .docx that matches the user's polished résumé
// template. Extracted from scripts/to-docx.ts so the dashboard's Download button
// and the CLI produce byte-identical documents from one implementation — two
// renderers would drift, and only one of them would be the one you actually sent.
//
// No external tools (pandoc/LibreOffice) needed — renders via the pure-JS `docx`
// package. The style spec below was reverse-engineered from the reference résumé
// .docx so output matches it 1:1: Arial throughout, plain body text, accent-blue
// name (large, plain) and bold accent section headings, bold company lines,
// bold-italic job-title lines, and a bold-label/plain-value skills split.
//
// NOTE when re-deriving this spec from a .docx: <w:b w:val="0"/> means bold OFF.
// Testing only for element presence reports every run as bold+italic.
//
// Markdown structure understood (shared by resume_base.md and tailor output):
//   # Name              -> title (accent, underlined)
//   Contact | line      -> first line after the name
//   ## Section          -> section heading (accent)
//   ### Company – Loc    -> company sub-heading
//   **Title | dates**    -> job-title line
//   **Label:** values    -> skills line (bold label + plain values)
//   - bullet             -> "•" bullet
//   ---                  -> ignored
// `# Tailored résumé` is dropped; `# Drafted answers` starts a new page.

import { normalizeDocxPackage } from "./docx-package";
import { BorderStyle, Document, Packer, PageBreak, Paragraph, TextRun } from "docx";

/**
 * A drafted-answers section renders onto a second page, placeholders and salary
 * posture included. Callers check for it and warn BEFORE handing the file over.
 */
export const DRAFTED_ANSWERS_HEADING = /^#\s+Drafted answers\s*$/im;

/**
 * The wrapper heading `tailorForJob()` writes above a résumé body. Exported so
 * `lib/resume-source.ts` strips exactly what this renderer skips: two matchers
 * with different rules would let a spelling variant be stripped for the
 * divergence check and still render as a stray title line, which is the mistake
 * `lib/match.ts` exists to prevent.
 */
export function isTailoredHeading(text: string): boolean {
  const lower = text.trim().toLowerCase();
  return lower === "tailored résumé" || lower === "tailored resume";
}

const FONT = "Arial";
const ACCENT = "1F4E79";
const INK = "000000";
// Sizes are half-points; spacing is twips — both taken straight from the reference doc.
const S = {
  name: { size: 42, after: 80 },
  contact: { size: 22, after: 140 },
  section: { size: 30, before: 140, after: 60 },
  company: { size: 26, before: 100, after: 20 },
  jobTitle: { size: 23, after: 10 },
  body: { size: 22, after: 50, line: 250 },
  bullet: { size: 22, after: 15, line: 250 },
  skills: { size: 22, after: 26, line: 250 },
};

type RunOpts = { bold?: boolean; italic?: boolean; size?: number; color?: string };
const run = (text: string, o: RunOpts = {}) =>
  new TextRun({
    text,
    font: FONT,
    bold: o.bold,
    italics: o.italic,
    size: o.size,
    color: o.color ?? INK,
  });

/** Split on **…** markers: even segments plain, odd segments bold. Both inherit italic/size. */
function inlineHonorBold(text: string, base: RunOpts): TextRun[] {
  return text
    .split("**")
    .filter((seg, i) => seg !== "" || i === 0)
    .map((seg, i) => run(seg, { ...base, bold: i % 2 === 1 }));
}

function parse(md: string): Paragraph[] {
  const out: Paragraph[] = [];
  let expectContact = false;
  let inDrafted = false;

  for (const raw of md.split("\n")) {
    const line = raw.trim();
    if (line === "" || line === "---") continue;

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2].trim();
      const lower = text.toLowerCase();

      if (level === 1 && isTailoredHeading(text)) continue;
      if (level === 1 && lower === "drafted answers") {
        out.push(new Paragraph({ children: [new PageBreak()] }));
        out.push(sectionHeading(text));
        inDrafted = true;
        continue;
      }
      if (level === 1) {
        out.push(
          new Paragraph({
            spacing: { after: S.name.after, line: 240 },
            border: { bottom: { style: BorderStyle.SINGLE, size: 8, space: 2, color: ACCENT } },
            children: [run(text, { size: S.name.size, color: ACCENT })],
          }),
        );
        expectContact = true;
        continue;
      }
      if (level === 2) {
        out.push(sectionHeading(text));
        continue;
      }
      out.push(
        new Paragraph({
          spacing: { before: S.company.before, after: S.company.after, line: 240 },
          children: [run(text, { bold: true, size: S.company.size })],
        }),
      );
      continue;
    }

    if (expectContact) {
      out.push(
        new Paragraph({
          spacing: { after: S.contact.after, line: 240 },
          children: [run(line, { size: S.contact.size })],
        }),
      );
      expectContact = false;
      continue;
    }

    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (bullet) {
      // Reference doc uses a literal "•  " prefix, flush left, plain body text.
      out.push(
        new Paragraph({
          spacing: { after: S.bullet.after, line: S.bullet.line },
          children: [run("•  " + bullet[1].replace(/\*\*/g, ""), { size: S.bullet.size })],
        }),
      );
      continue;
    }

    // Drafted answers: plain body, but honor a bold lead-in like **Why Acme?**.
    if (inDrafted) {
      out.push(
        new Paragraph({
          spacing: { after: S.body.after, line: S.body.line },
          children: inlineHonorBold(line, { size: S.body.size }),
        }),
      );
      continue;
    }

    // Skills line: "**Label:** values" -> bold label + plain values.
    const skills = line.match(/^\*\*(.+?):\*\*\s*(.*)$/);
    if (skills) {
      out.push(
        new Paragraph({
          spacing: { after: S.skills.after, line: S.skills.line },
          children: [
            run(skills[1] + ": ", { bold: true, size: S.skills.size }),
            run(skills[2], { size: S.skills.size }),
          ],
        }),
      );
      continue;
    }

    // Whole-line bold (job-title line): "**Senior SDET | Dec 2025 – Jul 2026**".
    // Bold AND italic, deliberately: the reference template has these italic only,
    // but the title is what a skimming recruiter looks for and italic alone does not
    // hold the eye next to a bold company line. Size still separates the two.
    const jobTitle = line.match(/^\*\*(.+)\*\*$/);
    if (jobTitle) {
      out.push(
        new Paragraph({
          spacing: { after: S.jobTitle.after, line: 240 },
          children: [run(jobTitle[1], { bold: true, italic: true, size: S.jobTitle.size })],
        }),
      );
      continue;
    }

    // Everything else (summary, education): plain body text.
    out.push(
      new Paragraph({
        spacing: { after: S.body.after, line: S.body.line },
        children: [run(line.replace(/\*\*/g, ""), { size: S.body.size })],
      }),
    );
  }

  return out;
}

function sectionHeading(text: string): Paragraph {
  return new Paragraph({
    spacing: { before: S.section.before, after: S.section.after, line: 240 },
    children: [run(text, { bold: true, size: S.section.size, color: ACCENT })],
  });
}

/** Render résumé Markdown to a .docx byte buffer, ready to write or stream. */
export async function renderResumeDocx(md: string): Promise<Uint8Array> {
  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, size: S.body.size } } } },
    sections: [
      {
        properties: {
          page: {
            margin: { top: 792, bottom: 792, left: 936, right: 936, header: 720, footer: 720 },
          },
        },
        children: parse(md),
      },
    ],
  });

  // normalizeDocxPackage, not a bare Packer.toBuffer: see lib/docx-package.ts.
  // The document is identical either way; the archive layout is what job-board
  // parsers reject — Indeed refused a résumé outright until it was repacked.
  return normalizeDocxPackage(await Packer.toBuffer(doc));
}
