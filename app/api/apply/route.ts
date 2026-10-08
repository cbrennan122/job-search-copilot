import { NextRequest, NextResponse } from "next/server";
import { updateApplication } from "@/lib/store";
import { APPLICATION_STATUSES, type Application, type ApplicationStatus } from "@/lib/types";

type Patch = Partial<Omit<Application, "jobId" | "updatedAt">>;

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    jobId?: string;
  } & Patch;
  const { jobId, ...patch } = body;

  if (!jobId) {
    return NextResponse.json({ error: "jobId required" }, { status: 400 });
  }
  // The status list grew past new/applied/skipped to cover the interview stages,
  // so validate against the exported list rather than a local copy that drifts.
  // Keyed on presence, not on `!= null`: an explicit `"status": null` would
  // otherwise skip validation and hit a NOT NULL column as a 500.
  if ("status" in patch && !APPLICATION_STATUSES.includes(patch.status as ApplicationStatus)) {
    return NextResponse.json(
      { error: `status must be one of: ${APPLICATION_STATUSES.join(", ")}` },
      { status: 400 },
    );
  }

  // Only forward keys the caller actually sent — spreading the whole body would
  // blank out notes/contact every time the UI just flips a status.
  const clean: Patch = {};
  for (const k of ["status", "notes", "followUpAt", "contact", "compNotes", "appliedAt"] as const) {
    if (k in patch) (clean as Record<string, unknown>)[k] = patch[k];
  }

  try {
    return NextResponse.json({ application: updateApplication(jobId, clean) });
  } catch (err) {
    // applications.jobId is an FK onto jobs, so an id that is not in the queue
    // fails at the INSERT, not at the read — getApplication() cheerfully returns
    // a default row for a job that does not exist. Uncaught, that reached the
    // caller as a framework 500, which reads as "the server is broken" when the
    // real answer is "no such job".
    if ((err as { code?: string }).code === "SQLITE_CONSTRAINT_FOREIGNKEY") {
      return NextResponse.json({ error: `no job with id ${jobId}` }, { status: 404 });
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
