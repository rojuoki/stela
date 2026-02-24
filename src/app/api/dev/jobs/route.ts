import { NextRequest, NextResponse } from "next/server";
import { globalQueue } from "@/lib/jobs";
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
 * Returns running + pending + waiting jobs from the live in-process queue.
 * Dev-only (requires NEXT_PUBLIC_DEV_PANEL=1).
 */
export function GET() {
  if (!DEV_PANEL) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { running, pending, waiting } = globalQueue.queueSnapshot();
  const allIds = [...new Set([...running, ...pending, ...waiting])];

  if (allIds.length === 0) {
    return NextResponse.json({ jobs: [] });
  }

  const db = getDb();
  const placeholders = allIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT id, account_username, status, resume_at, api_calls, fetched_count,
              requested_limit, created_at, started_at
       FROM jobs WHERE id IN (${placeholders})`,
    )
    .all(...allIds) as JobRow[];

  const rowMap = new Map(rows.map((r) => [r.id, r]));

  // Build list in queue order: running first, then pending (FIFO), then waiting.
  const ordered = [
    ...running.map((id) => ({ id, slot: "running" as const, pos: null as number | null })),
    ...pending.map((id, i) => ({ id, slot: "pending" as const, pos: i + 1 })),
    ...waiting.map((id) => ({ id, slot: "waiting" as const, pos: null as number | null })),
  ];

  const jobs = ordered.map(({ id, slot, pos }) => {
    const row = rowMap.get(id);
    return {
      id,
      username: row?.account_username ?? "?",
      status: slot === "waiting" ? "waiting_rate_limit" : slot === "running" ? "running" : "queued",
      queuePosition: pos,
      apiCalls: row?.api_calls ?? 0,
      fetchedCount: row?.fetched_count ?? 0,
      requestedLimit: row?.requested_limit ?? 0,
      createdAt: row?.created_at ?? null,
      startedAt: row?.started_at ?? null,
      resumeAt: row?.resume_at ?? null,
    };
  });

  return NextResponse.json({ jobs });
}

/**
 * DELETE /api/dev/jobs?id=<jobId>
 * Cancels a specific job (any state except terminal).
 * Dev-only.
 */
export function DELETE(req: NextRequest) {
  if (!DEV_PANEL) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");

  if (!id) {
    return NextResponse.json({ error: "id query parameter required" }, { status: 400 });
  }

  const canceled = globalQueue.cancelJob(id);
  if (!canceled) {
    return NextResponse.json(
      { error: "Job not found or already in terminal state" },
      { status: 404 },
    );
  }

  return NextResponse.json({ ok: true, canceled: id });
}
