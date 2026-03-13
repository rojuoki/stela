/**
 * Dev-only API: /api/dev/cost
 * Requires NEXT_PUBLIC_DEV_PANEL=1.
 *
 * GET → per-user and per-endpoint API call rollups + estimated cost.
 *
 * Data comes from api_call_log:
 *   cached=0 → real HTTP call (counted in totals / cost)
 *   cached=1 → served from local cache (counted in saved totals / saved cost)
 */

import { NextResponse } from "next/server";
import { getApiCostStats, COST_PER_CALL_USD } from "@/lib/repository";

export function GET() {
  if (process.env.NEXT_PUBLIC_DEV_PANEL !== "1") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const stats = getApiCostStats();
    return NextResponse.json({
      ...stats,
      cost_per_call_usd: COST_PER_CALL_USD,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "unknown";
    console.error("[dev/cost] GET error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
