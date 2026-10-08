import { NextRequest, NextResponse } from "next/server";
import { runPipeline } from "@/lib/pipeline";

// A full fetch + score run can take a while; allow generous time locally.
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const { score } = (await req.json().catch(() => ({}))) as { score?: boolean };
  try {
    const result = await runPipeline({ score });
    return NextResponse.json({ result });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
