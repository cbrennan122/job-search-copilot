import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const dir = mkdtempSync(path.join(tmpdir(), `job-copilot-docx-${randomUUID()}-`));
const md = path.join(dir, "resume.md");
const out = path.join(dir, "resume.docx");

const SAMPLE = `# Tailored résumé

# Jane Doe
jane@example.com | 555-0100 | Remote

## Experience

### Example Corp
**Senior Engineer** | 2020 – Present

- Built a thing that worked
- Built another thing

## Skills

**Cloud:** AWS, Terraform

# Drafted answers

**Salary?** [FILL IN: your target number]
`;

/**
 * Read document.xml straight out of the .docx (a zip). Deliberately does NOT
 * reuse dump-docx.ts's parser: running the same predicate over both the
 * generated file and the expectation would let a bug in that predicate confirm
 * itself. These assertions read raw XML.
 */
function documentXml(): string {
  return execFileSync("python3", [
    "-c",
    `import zipfile,sys;sys.stdout.write(zipfile.ZipFile(sys.argv[1]).read("word/document.xml").decode("utf-8"))`,
    out,
  ]).toString();
}

describe("to-docx", () => {
  let xml = "";

  before(() => {
    writeFileSync(md, SAMPLE);
    execFileSync("npx", ["tsx", "scripts/to-docx.ts", md, "--out", out], {
      cwd: path.resolve(import.meta.dirname, "../.."),
    });
    xml = documentXml();
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it("renders the résumé content", () => {
    assert.ok(xml.includes("Jane Doe"));
    assert.ok(xml.includes("Example Corp"));
    assert.ok(xml.includes("Built a thing that worked"));
  });

  it("drops the '# Tailored résumé' wrapper heading", () => {
    assert.ok(!xml.includes(">Tailored résumé<"), "wrapper heading must not render");
  });

  it("puts drafted answers behind a page break", () => {
    // They carry [FILL IN] placeholders and salary posture. They must never be
    // on page 1, and ideally never in a file that gets sent at all.
    assert.ok(xml.includes("Drafted answers"));
    assert.ok(xml.includes('<w:br w:type="page"/>'), "page break present");
    assert.ok(
      xml.indexOf('<w:br w:type="page"/>') < xml.indexOf("Drafted answers"),
      "the break comes before the answers",
    );
  });

  it("does not emit a document that is bold throughout", () => {
    // The 2026-07-22 bug: every run came out bold+italic. `<w:b w:val="0"/>` is
    // bold OFF, so counting `<w:b` occurrences misreads disabled runs as enabled.
    const enabled = xml.match(/<w:b\/>|<w:b w:val="(?!0|false)[^"]*"\/>/g) ?? [];
    const disabled = xml.match(/<w:b w:val="(0|false)"\/>/g) ?? [];
    assert.ok(enabled.length + disabled.length > 0, "sanity: the document sets bold somewhere");
    // Observed on 2026-08-25: 6 genuinely-bold runs, while a naive
    // `xml.count("<w:b")` reports 19 — it also counts `<w:bottom>` borders and
    // the `w:val="0"` runs that are bold OFF. That gap is the whole trap.
    assert.ok(
      enabled.length <= 8,
      `only headings should be bold, found ${enabled.length} enabled bold runs`,
    );
    assert.ok(
      (xml.match(/<w:b/g) ?? []).length > enabled.length,
      "the naive <w:b count overstates bold — that is why this test parses w:val",
    );
  });
});
