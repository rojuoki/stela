import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

const DEV_PANEL = process.env.NEXT_PUBLIC_DEV_PANEL === "1";

interface JobRow {
  id: string;
  account_username: string;
  status: string;
  resume_at: string | null;
  api_calls: number;
  fetched_count: number;
  requested_limit: number;
  created_at: string;
  started_at: string | null;
}

/**
 * GET /api/dev/jobs
 * Returns active jobs from the DB directly — no import of jobs.ts so that
 * GlobalJobQueue._init() is never triggered by a read-only poll.
 * Dev-only (requires NEXT_PUBLIC_DEV_PANEL=1).
 */
export function GET() {
  if (!DEV_PANEL) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const db = getDb();
  const now = new Date().toISOString();

  // Derive the same three slots the in-memory queue exposes, purely from DB state:
  //   running          → status = 'running'
  //   waiting_rate_limit → status = 'queued' AND resume_at IS NOT NULL AND resume_at > now
  //   queued (pending) → status = 'queued' AND (resume_at IS NULL OR resume_at <= now)
  //
  // Order mirrors the original: running first, pending (FIFO by created_at), waiting last.
  const rows = db
    .prepare(
      `SELECT id, account_username, status, resume_at, api_calls, fetched_count,
              requested_limit, created_at, started_at
       FROM jobs
       WHERE status IN ('running', 'queued')
       ORDER BY
         CASE
           WHEN status = 'running'                                    THEN 0
           WHEN status = 'queued' AND (resume_at IS NULL OR resume_at <= ?) THEN 1
           ELSE 2
         END,
         created_at ASC`,
    )
    .all(now) as JobRow[];

  if (rows.length === 0) {
    return NextResponse.json({ jobs: [] });
  }

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
