import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import JSZip from "jszip";
import { normalizeDocxPackage } from "../../lib/docx-package";

const CT = "[Content_Types].xml";

/** A package with the exact two defects `docx` produces: content-types last, and directory entries. */
async function badPackage(): Promise<Buffer> {
  const zip = new JSZip();
  zip.folder("word");
  zip.folder("docProps");
  zip.file("word/document.xml", "<document/>");
  zip.file("docProps/core.xml", "<core/>");
  zip.file(CT, "<Types/>");
  return zip.generateAsync({ type: "nodebuffer" });
}

const namesOf = async (buf: Buffer) =>
  Object.values((await JSZip.loadAsync(buf)).files).map((f) => f.name);

describe("normalizeDocxPackage", () => {
  it("the fixture really is broken (control for every assertion below)", async () => {
    const names = await namesOf(await badPackage());
    assert.notEqual(names[0], CT, "fixture must NOT already start with the content-types part");
    assert.ok(
      names.some((n) => n.endsWith("/")),
      "fixture must contain directory entries",
    );
  });

  it("moves the content-types part to the front and drops directory entries", async () => {
    const names = await namesOf(await normalizeDocxPackage(await badPackage()));
    assert.equal(names[0], CT);
    assert.deepEqual(
      names.filter((n) => n.endsWith("/")),
      [],
    );
  });

  it("preserves every part and its bytes", async () => {
    const before = await JSZip.loadAsync(await badPackage());
    const after = await JSZip.loadAsync(await normalizeDocxPackage(await badPackage()));

    const parts = Object.values(before.files)
      .filter((f) => !f.dir)
      .map((f) => f.name);
    assert.deepEqual(new Set(Object.keys(after.files)), new Set(parts), "no part added or lost");
    for (const name of parts) {
      assert.equal(
        await after.file(name)!.async("string"),
        await before.file(name)!.async("string"),
        `${name} round-trips unchanged`,
      );
    }
  });

  it("refuses a zip that is not a .docx at all", async () => {
    const zip = new JSZip();
    zip.file("notes.txt", "hello");
    await assert.rejects(
      normalizeDocxPackage(await zip.generateAsync({ type: "nodebuffer" })),
      /no \[Content_Types\]\.xml part/,
    );
  });
});
