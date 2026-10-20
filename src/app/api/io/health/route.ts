import { NextResponse } from "next/server";
import { ioPgQuery } from "@/lib/io/pg-db";
import { ioLog } from "@/lib/io/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type QueueHealth = {
  queued: number;
  running: number;
  stale: number;
  oldest_queued_at: string | null;
};

export async function GET() {
  const checkedAt = new Date().toISOString();
  try {
    const result = await ioPgQuery<QueueHealth>(`SELECT
      COUNT(*) FILTER (WHERE status = 'queued')::INTEGER AS queued,
      COUNT(*) FILTER (WHERE status = 'running')::INTEGER AS running,
      COUNT(*) FILTER (
        WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < NOW()
      )::INTEGER AS stale,
      MIN(created_at) FILTER (WHERE status = 'queued') AS oldest_queued_at
    FROM acquisition_runs`);
    const queue = result.rows[0] || { queued: 0, running: 0, stale: 0, oldest_queued_at: null };
    const healthy = queue.stale === 0;
    if (!healthy) ioLog("warn", "health_stale_worker_lease", { staleRuns: queue.stale });
    return NextResponse.json(
      { status: healthy ? "ok" : "degraded", database: "ok", queue, checkedAt },
      { status: healthy ? 200 : 503, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    ioLog("error", "health_database_failed", { error });
    return NextResponse.json(
      { status: "error", database: "unavailable", checkedAt },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
