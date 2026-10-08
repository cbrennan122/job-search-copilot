import path from "node:path";
import { NextResponse } from "next/server";
import { renderResumeDocx } from "@/lib/docx-render";
import { writeOutput } from "@/lib/outfile";
import { docxPathFor } from "@/lib/paths";
import { resolveResumeMarkdown } from "@/lib/resume-source";
import { getJob, saveArtifact } from "@/lib/store";

// Render the stored résumé for one job into a .docx and hand it back as a
// download. Same renderer as scripts/to-docx.ts (lib/docx-render.ts), so the
// button and the CLI produce the same document — two renderers would drift and
// only one of them would be the file you actually sent.
//
// It also WRITES the .docx to resumes/ and records it, exactly as the CLI does.
// A downloaded document that leaves no trace would make "Files sent" answer
// "what did I attach?" wrongly rather than admitting it does not know.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  const job = getJob(id);
  if (!job) return NextResponse.json({ error: `No job with id ${id}` }, { status: 404 });

  // The .md on disk when there is one, else the stored row — see
  // lib/resume-source.ts. The file wins because it is the copy a human last
  // reviewed; reading the row after an edit hands the user the pre-review draft,
  // which is exactly the document the review existed to stop.
  const resolved = resolveResumeMarkdown(job);
  if (!resolved) {
    return NextResponse.json(
      { error: "No tailored résumé for this job yet — tailor it first." },
      { status: 409 },
    );
  }

  // The résumé only. draftedAnswers is a separate column/file and must never
  // reach the document: it is prep notes with placeholders and salary posture.
  const bytes = await renderResumeDocx(resolved.markdown);

  const outPath = docxPathFor(job);
  writeOutput(outPath, bytes);
  saveArtifact(id, "resume-docx", outPath);

  // Named off the file that was actually written, not rebuilt from the same
  // parts: one stem, so what lands in Downloads is what "Files sent" lists.
  const filename = path.basename(outPath);
  return new NextResponse(Buffer.from(bytes), {
    headers: {
      // Which copy this actually rendered, so "what did I just download?" is
      // answerable from the response rather than by guessing.
      "x-resume-source":
        resolved.from === "file" ? (resolved.diverged ? "file-edited" : "file") : "row",
      // A file was found and rejected (empty, or unreadable). The CLI has always
      // printed this; the button used to swallow it and hand over the stale row
      // with nothing to say why — the same signal reaching one consumer and not
      // the others that lib/resume-source.ts exists to stop.
      //
      // PERCENT-ENCODED because a header value is a ByteString (latin-1) and this
      // message carries an em dash, and a path can carry any character at all.
      // Assigning it raw throws inside the Response constructor, which turned a
      // rejected file into a 500 on the whole download — strictly worse than the
      // silence. The client decodeURIComponent()s it back.
      ...(resolved.warning ? { "x-resume-warning": encodeURIComponent(resolved.warning) } : {}),
      "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "content-disposition": `attachment; filename="${filename}"`,
      "content-length": String(bytes.byteLength),
    },
  });
}
