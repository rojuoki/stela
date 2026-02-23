import { NextRequest, NextResponse } from "next/server";
import { getJob, globalQueue } from "@/lib/jobs";
import { withDevMeasure } from "@/lib/devMeasure";

/**
 * GET /api/jobs/:id
 *
 * Read-only: returns persisted job state from DB plus live queue metadata
 * computed from the in-process global queue. Never triggers X API calls.
 *
 * Extra fields when status === "queued":
 *   queuePosition  — 1-based position in the waiting list (1 = next to run)
 *   runningJobId   — ID of the job currently occupying the execution slot
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withDevMeasure("jobs", async () => {
    const { id } = await params;

    if (!id) {
      return NextResponse.json({ error: "Job ID is required" }, { status: 400 });
    }

    const job = getJob(id);
    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    // Compute effective status.
    // A suspended job (429 hit) is stored as status='queued' with a future resume_at
    // so that the queue re-starts it after cooldown. Expose it as 'waiting_rate_limit'
    // to the client for a meaningful UI message.
    const effectiveStatus =
      job.status === "queued" &&
      job.resume_at != null &&
      new Date(job.resume_at) > new Date()
        ? "waiting_rate_limit"
        : job.status;

    const response: Record<string, unknown> = {
      jobId: job.id,
      status: effectiveStatus,
      resumeAt: job.resume_at ?? null,
      username: job.account_username,
      requestedLimit: job.requested_limit,
      apiCalls: job.api_calls,
      fetchedCount: job.fetched_count,
      createdAt: job.created_at,
      startedAt: job.started_at,
      finishedAt: job.finished_at,
    };

    // Queue metadata — only meaningful while the job is waiting.
    if (job.status === "queued") {
      response.queuePosition = globalQueue.positionOf(job.id); // 1-based, or null
      response.runningJobId = globalQueue.runningJobId;
    } else {
      response.queuePosition = null;
      response.runningJobId = null;
    }

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
  }, { route: `/api/jobs/${(await params).id}` });
}
