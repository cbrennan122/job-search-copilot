import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { writeOutput } from "../../lib/outfile";

const ROOT = mkdtempSync(path.join(tmpdir(), "job-copilot-outfile-"));

after(() => rmSync(ROOT, { recursive: true, force: true }));

describe("writeOutput", () => {
  it("creates a missing parent directory", () => {
    // The reason this helper exists: resumes/ is gitignored, so it is absent
    // from a fresh clone. A bare writeFileSync throws ENOENT there — and in
    // scripts/tailor.ts that throw lands AFTER the LLM call, discarding the
    // résumé it just paid for.
    const out = path.join(ROOT, "resumes", `tailored-${randomUUID()}.md`);
    assert.equal(
      existsSync(path.dirname(out)),
      false,
      "the directory really is missing before the write",
    );

    writeOutput(out, "# Tailored résumé\n");
    assert.equal(readFileSync(out, "utf8"), "# Tailored résumé\n");
  });

  it("writes bytes through unchanged", () => {
    // scripts/to-docx.ts hands it a Buffer from Packer.toBuffer, not a string.
    const out = path.join(ROOT, "deep", "nested", "resume.docx");
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04", a zip header
    writeOutput(out, bytes);
    assert.deepEqual(readFileSync(out), bytes);
  });

  it("writes into a directory that already exists", () => {
    // mkdir -p over an existing path is a no-op, so the common case — writing
    // a second file next to the first — must not trip over its own directory.
    const out = path.join(ROOT, "again.md");
    writeOutput(out, "one");
    writeOutput(out, "two");
    assert.equal(readFileSync(out, "utf8"), "two", "overwrites rather than appending");
  });
});
