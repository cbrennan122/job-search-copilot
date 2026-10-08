// Dump a .docx's real formatting so you can verify output against a reference —
// the Read tool can't render .docx, and re-deriving the spec by hand has shipped
// bugs twice (a fully bold-italic résumé on 2026-07-22).
//
//   npx tsx scripts/dump-docx.ts resume.docx                 # text + per-paragraph style
//   npx tsx scripts/dump-docx.ts a.docx --diff b.docx        # compare style signatures
//   npx tsx scripts/dump-docx.ts resume.docx --check         # submission safety checks
//
// THE TRAP: <w:b w:val="0"/> means bold OFF. Testing only for element presence
// ("does <w:b appear?") reports every run as bold+italic. Everything below reads
// the w:val attribute, treating "0" and "false" as off.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

/** Read one entry out of a .docx (a zip) without adding a dependency. */
function readZipEntry(zipPath: string, entry: string): string {
  return execFileSync("python3", [
    "-c",
    `import zipfile,sys;sys.stdout.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]).decode("utf-8"))`,
    zipPath,
    entry,
  ]).toString();
}

/** A <w:x/> or <w:x w:val="0"/> toggle: present-and-not-disabled means on. */
function toggle(xml: string, tag: string): boolean {
  const m = xml.match(new RegExp(`<w:${tag}(\\s+w:val="([^"]*)")?\\s*/>`));
  if (!m) return false;
  const val = m[2];
  return val === undefined || (val !== "0" && val !== "false");
}

type Para = {
  text: string;
  sizes: string[];
  colors: string[];
  bold: boolean;
  italic: boolean;
  pageBreak: boolean;
  bottomBorder: boolean;
};

function parse(zipPath: string): Para[] {
  const xml = readZipEntry(zipPath, "word/document.xml");
  const paras = xml.match(/<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g) ?? [];
  return paras.map((p) => ({
    text: [...p.matchAll(/<w:t(?:[^>]*)>([\s\S]*?)<\/w:t>/g)]
      .map((m) => m[1])
      .join("")
      .replace(/&amp;/g, "&")
      .replace(/&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">"),
    sizes: [...new Set([...p.matchAll(/<w:sz w:val="(\d+)"/g)].map((m) => m[1]))].sort(),
    colors: [
      ...new Set([...p.matchAll(/<w:color w:val="([0-9A-Fa-f]+)"/g)].map((m) => m[1])),
    ].sort(),
    bold: toggle(p, "b"),
    italic: toggle(p, "i"),
    pageBreak: /<w:br\s+w:type="page"/.test(p),
    bottomBorder: /<w:bottom w:val="single"/.test(p),
  }));
}

/** Style fingerprint, ignoring text — for comparing two renders of the same template. */
const sig = (p: Para) =>
  [
    p.sizes.join("+") || "-",
    p.colors.join("+") || "-",
    p.bold ? "b" : "",
    p.italic ? "i" : "",
    p.pageBreak ? "PAGEBREAK" : "",
    p.bottomBorder ? "RULE" : "",
  ].join("|");

function show(paras: Para[]) {
  paras.forEach((p, i) => {
    const t = p.text.length > 110 ? p.text.slice(0, 107) + "..." : p.text;
    console.log(`[${String(i).padStart(3, "0")}] ${sig(p).padEnd(28)} ${t}`);
  });
}

/** Checks that must pass before a résumé .docx is sent to an employer. */
function check(paras: Para[]): number {
  const all = paras.map((p) => p.text).join("\n");
  const problems: string[] = [];

  const breaks = paras.filter((p) => p.pageBreak).length;
  if (breaks) problems.push(`${breaks} page break(s) — drafted-answers page may be attached`);
  if (/FILL IN/i.test(all)) problems.push(`contains "FILL IN" placeholder text`);
  if (/Drafted answers/i.test(all)) problems.push(`contains a "Drafted answers" heading`);
  if (/salary|compensation range/i.test(all)) problems.push(`mentions salary/compensation`);

  const everything = paras.filter((p) => p.text.trim());
  if (everything.length && everything.every((p) => p.bold && p.italic)) {
    problems.push(`every paragraph reads bold+italic — check the w:val="0" trap`);
  }

  if (problems.length === 0) {
    console.log(`✓ ${paras.length} paragraphs, no page breaks, no placeholders. Safe to send.`);
    return 0;
  }
  console.log(`✗ ${problems.length} problem(s):`);
  problems.forEach((p) => console.log(`  - ${p}`));
  return 1;
}

function diff(aPath: string, bPath: string) {
  const a = parse(aPath);
  const b = parse(bPath);
  console.log(`${aPath}: ${a.length} paragraphs`);
  console.log(`${bPath}: ${b.length} paragraphs\n`);

  const aSigs = new Set(a.map(sig));
  const bSigs = new Set(b.map(sig));
  const onlyB = [...bSigs].filter((s) => !aSigs.has(s));
  const onlyA = [...aSigs].filter((s) => !bSigs.has(s));

  if (!onlyA.length && !onlyB.length) {
    console.log("✓ Identical style signatures — no formatting drift.");
  } else {
    if (onlyB.length) console.log(`Style signatures only in ${bPath}:\n  ${onlyB.join("\n  ")}`);
    if (onlyA.length) console.log(`Style signatures only in ${aPath}:\n  ${onlyA.join("\n  ")}`);
  }
}

function main() {
  // Piping into `head` closes stdout early; that's normal, not a crash.
  process.stdout.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EPIPE") process.exit(0);
    throw e;
  });

  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--diff");
  if (!file) {
    console.error("Usage: npx tsx scripts/dump-docx.ts <file.docx> [--diff other.docx] [--check]");
    process.exit(1);
  }
  readFileSync(file); // fail fast with a clear error if the path is wrong

  const diffIdx = args.indexOf("--diff");
  if (diffIdx !== -1 && args[diffIdx + 1]) return diff(file, args[diffIdx + 1]);

  const paras = parse(file);
  if (args.includes("--check")) process.exit(check(paras));
  show(paras);
}

main();
