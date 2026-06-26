import { NextResponse } from "next/server";
import { retryFailedJob } from "@/lib/ops/actions";
import { logEvent, newRequestId } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ queue: string; jobId: string }> }
) {
  const { queue, jobId } = await params;
  const requestId = newRequestId();
  const result = await retryFailedJob(queue, jobId);
  logEvent("ops.retry_job", { requestId, queue, jobId, result });
  const status = result === "retried" ? 200 : result === "unknown-queue" ? 400 : 404;
  return NextResponse.json({ result }, { status });
}
