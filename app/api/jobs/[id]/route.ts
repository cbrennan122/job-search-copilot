import { NextRequest, NextResponse } from "next/server";
import { resolveResumeMarkdown, resumeForDisplay } from "@/lib/resume-source";
import { getApplication, getFit, getJob, listArtifacts } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = getJob(id);
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  // Listed once and handed to the resolver, which needs the same rows to find
  // the job's own .md — two calls would be two chances to disagree, as well as
  // two queries.
  const artifacts = listArtifacts(id);
  const resolved = resolveResumeMarkdown(job, artifacts);
  return NextResponse.json({
    job,
    fit: getFit(id),
    // Full application record, not just the status — the detail page now
    // renders notes, contact, follow-up date and comp notes.
    application: getApplication(id),
    // Resolved, NOT a bare latestResume(): the preview and the Copy button have
    // to show the same text the Download button renders, or the page displays a
    // reviewed résumé while handing over the pre-review draft. That divergence
    // between two readers is the whole bug lib/resume-source.ts exists to close.
    resume: resolved && resumeForDisplay(id, resolved),
    // So the UI can say which copy it is showing rather than leaving the user to
    // guess — the signal was previously computed and never read by anything.
    resumeSource: resolved && {
      from: resolved.from,
      diverged: resolved.diverged,
      // A file was found and rejected (empty, or unreadable) — the user is
      // being shown the stored row and deserves to know why. No `path`: the UI
      // never rendered it and it puts the server's absolute directory layout
      // on the wire for nothing.
      warning: resolved.warning ?? null,
    },
    // Files generated for this job that were recorded with `to-docx --job-id`.
    // The résumé text above lives in the DB; this is the .docx that was actually
    // attached, which is the thing "applied" otherwise says nothing about.
    artifacts,
  });
}
