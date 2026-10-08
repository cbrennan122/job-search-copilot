import { NextRequest, NextResponse } from "next/server";
import { loadResumeBase } from "@/lib/profile";
import { getJob } from "@/lib/store";
import { tailorForJob } from "@/lib/tailor";
import { verifyAgainstBase } from "@/lib/verify";

// Tailoring streams a Sonnet response; allow generous time on this local route.
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const { jobId } = (await req.json()) as { jobId?: string };
  if (!jobId) return NextResponse.json({ error: "jobId required" }, { status: 400 });
  try {
    const version = await tailorForJob(jobId);
    // The CLI has always verified its output; this route did not, so a résumé
    // generated from the dashboard — the path actually used to apply — was the
    // one document that reached the user unchecked. Same check, same guardrail.
    const verification = verifyAgainstBase(version.content, loadResumeBase(), [
      getJob(jobId)?.company ?? "",
    ]);
    return NextResponse.json({ version, verification });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
