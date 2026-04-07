/**
 * DEV: Token pool diagnostics and cleanup endpoint
 * GET  - Show token pool status and orphaned tokens
 * POST - Clean up orphaned tokens (with ?dryRun=false to actually clean)
 */

import { NextRequest } from "next/server";
import { tokenPool } from "@/lib/tokenPool";
import { globalQueue } from "@/lib/jobs";

export async function GET() {
  try {
    const diagnostic = tokenPool.getDiagnosticInfo();
    const queueStatus = globalQueue.queueSnapshot();
    const orphanCount = tokenPool.cleanupOrphanedTokens(true); // dry run
    
    return Response.json({
      tokens: diagnostic,
      queue: queueStatus,
      orphanedTokens: orphanCount,
      summary: {
        totalTokens: diagnostic.length,
        assigned: diagnostic.filter(t => t.assigned).length,
        free: diagnostic.filter(t => !t.assigned).length,
        orphaned: orphanCount
      }
    });
  } catch (error) {
    console.error("[dev/tokenpool] GET error:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const dryRun = url.searchParams.get("dryRun") !== "false";
    
    const orphanCount = tokenPool.cleanupOrphanedTokens(dryRun);
    
    return Response.json({
      action: dryRun ? "dry_run" : "cleanup",
      orphansFound: orphanCount,
      message: dryRun 
        ? `Found ${orphanCount} orphaned tokens. Add ?dryRun=false to actually clean them.`
        : `Cleaned up ${orphanCount} orphaned tokens.`
    });
  } catch (error) {
    console.error("[dev/tokenpool] POST error:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}