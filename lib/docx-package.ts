// Rewrite a generated .docx archive so strict OPC readers will open it.
//
// The `docx` package builds its zip in whatever order it assembles the parts,
// which puts `[Content_Types].xml` in the middle and leaves bare directory
// entries (`word/`, `docProps/`) in the archive. Word and our own dump-docx are
// both lenient about that, so it looks fine everywhere we test — but a reader
// that walks the package per the OPC spec looks for `[Content_Types].xml` to
// learn what every other part IS, and gives up when it is not the first entry.
//
// Indeed rejected a résumé from this tool with "Unable to read this file" on
// 2026-08-27 and accepted the identical document repacked this way; the bytes of
// word/document.xml were unchanged, only the archive layout differed.

import JSZip from "jszip";

const CONTENT_TYPES = "[Content_Types].xml";

export async function normalizeDocxPackage(buf: Buffer): Promise<Buffer> {
  const src = await JSZip.loadAsync(buf);

  // JSZip marks directory records with `dir`; real .docx files have none.
  const parts = Object.values(src.files)
    .filter((f) => !f.dir)
    .map((f) => f.name);
  if (!parts.includes(CONTENT_TYPES)) {
    throw new Error(`not a .docx package: no ${CONTENT_TYPES} part`);
  }

  // JSZip writes entries in insertion order, so inserting the content-types part
  // first is what actually puts it first in the archive.
  //
  // createFolders:false matters as much as the ordering: by default JSZip adds a
  // directory record for every parent path, so writing word/document.xml puts the
  // `word/` entry we are trying to remove straight back into the archive.
  const out = new JSZip();
  for (const name of [CONTENT_TYPES, ...parts.filter((n) => n !== CONTENT_TYPES)]) {
    out.file(name, await src.file(name)!.async("nodebuffer"), { createFolders: false });
  }
  return out.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
