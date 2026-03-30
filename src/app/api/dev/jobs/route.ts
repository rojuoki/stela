import { NextRequest, NextResponse } from "next/server";
import { getActiveJobsPg, type JobRow } from "@/lib/repository";

const DEV_PANEL = process.env.NEXT_PUBLIC_DEV_PANEL === "1";

/**
 * GET /api/dev/jobs
 * Returns active jobs from the DB directly — no import of jobs.ts so that
 * GlobalJobQueue._init() is never triggered by a read-only poll.
 * Dev-only (requires NEXT_PUBLIC_DEV_PANEL=1).
 */
export async function GET() {
  if (!DEV_PANEL) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const rows = await getActiveJobsPg();

    if (rows.length === 0) {
      return NextResponse.json({ jobs: [] });
    }

    const now = new Date().toISOString();
    let pendingPos = 0;
    
    const jobs = rows.map((row) => {
      const isWaiting =
        row.status === "queued" && row.resume_at != null && row.resume_at > now;
      const isRunning = row.status === "running";
      const slot: string = isRunning
        ? "running"
        : isWaiting
          ? "waiting_rate_limit"
          : "queued";

      return {
        id: row.id,
        username: row.account_username,
        status: slot,
        queuePosition: slot === "queued" ? ++pendingPos : null,
        apiCalls: row.api_calls,
        fetchedCount: row.fetched_count,
        requestedLimit: row.requested_limit,
        createdAt: row.created_at,
        startedAt: row.started_at,
        resumeAt: row.resume_at,
      };
    });

    return NextResponse.json({ jobs });
  } catch (error) {
    console.error("[dev/jobs] Error fetching jobs:", error);
    return NextResponse.json({ error: "Failed to fetch jobs" }, { status: 500 });
  }
}

/**
 * DELETE /api/dev/jobs?id=<jobId>
 * Cancels a specific job (any state except terminal).
 * Dynamically imports jobs.ts so that GlobalJobQueue._init() is only triggered
 * by an actual write operation, not by GET polling.
 * Dev-only.
 */
export async function DELETE(req: NextRequest) {
  if (!DEV_PANEL) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");

  if (!id) {
    return NextResponse.json({ error: "id query parameter required" }, { status: 400 });
  }

  const { globalQueue } = await import("@/lib/jobs");
  const canceled = globalQueue.cancelJob(id);
  if (!canceled) {
    return NextResponse.json(
      { error: "Job not found or already in terminal state" },
      { status: 404 },
    );
  }

  return NextResponse.json({ ok: true, canceled: id });
}
