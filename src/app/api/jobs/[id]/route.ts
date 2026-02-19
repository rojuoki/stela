import { NextRequest, NextResponse } from "next/server";
import { getJob } from "@/lib/jobs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  if (!id) {
    return NextResponse.json({ error: "Job ID is required" }, { status: 400 });
  }

  const job = getJob(id);
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  const response: Record<string, unknown> = {
    jobId: job.id,
    status: job.status,
    username: job.account_username,
    requestedLimit: job.requested_limit,
    apiCalls: job.api_calls,
    fetchedCount: job.fetched_count,
    createdAt: job.created_at,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
  };

  if (job.status === "failed") {
    response.error = {
      code: job.error_code,
      message: job.error_message,
    };
  }

  if (job.status === "succeeded" && job.result_json) {
    try {
      response.result = JSON.parse(job.result_json);
    } catch {
      response.result = null;
    }
  }

  return NextResponse.json(response);
}
