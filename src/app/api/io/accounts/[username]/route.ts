import { NextRequest, NextResponse } from "next/server";
import { getIoUserFromRequest } from "@/lib/io/auth";
import { ioPgQuery } from "@/lib/io/pg-db";
import { normalizeIoUsername } from "@/lib/io/validation";
import { ioConfigurationMessage } from "@/lib/io/configuration-error";

import { getOrFetchIoProfile, IoProfileError } from "@/lib/io/profile";
import { getIoPublicPreviewState } from "@/lib/io/public-preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ username: string }> }) {
  const username = normalizeIoUsername((await params).username);
  if (!username) return NextResponse.json({ error: "Invalid username" }, { status: 400 });
  try {
    const user = await getIoUserFromRequest(request);
    const account = await getOrFetchIoProfile(username);
    const preview = await getIoPublicPreviewState(account.username);
    let boundary = 0;
    let ranges: unknown[] = [];
    let latestRun = null;
    let rangeRequest = null;
    if (user) {
      if (account) {
        const unlock = await ioPgQuery("SELECT boundary_end FROM user_unlocks WHERE user_id=$1 AND account_id=$2", [user.id, account.account_id]);
        boundary = Number(unlock.rows[0]?.boundary_end || 0);
        ranges = (await ioPgQuery('SELECT start_at AS "startAt", end_at AS "endAt" FROM user_range_unlocks WHERE user_id=$1 AND account_id=$2 ORDER BY unlocked_at DESC', [user.id, account.account_id])).rows;
      }
      latestRun = (await ioPgQuery(`SELECT id, username, status, collection_mode, progress_message,
        unique_count, target_count, base_boundary, target_boundary, granted_boundary, error_message,
        (result_json #>> '{result,status}' = 'EXPERIMENTAL_ACCOUNT_HAS_LESS_THAN_TARGET') AS "accountExhausted"
        FROM acquisition_runs WHERE requested_by_user_id=$1 AND LOWER(username)=LOWER($2)
        AND collection_mode IN ('prefix_initial','prefix_extend','prefix_grant') ORDER BY created_at DESC LIMIT 1`, [user.id, username])).rows[0] || null;
      rangeRequest = (await ioPgQuery(`SELECT id, status, start_at AS "startAt", end_at AS "endAt", error_message AS "errorMessage"
        FROM range_unlock_requests WHERE user_id=$1 AND LOWER(username)=LOWER($2) ORDER BY created_at DESC LIMIT 1`, [user.id, username])).rows[0] || null;
    }
    return NextResponse.json({
      account,
      boundary,
      ranges,
      latestRun,
      rangeRequest,
      publicBoundary: preview.publicBoundary,
      coveredPrefixCount: preview.coveredPrefixCount,
      previewComplete: preview.complete,
      previewRun: preview.run,
    });
  } catch (error) {
    if (error instanceof IoProfileError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: ioConfigurationMessage() }, { status: 503 });
  }
}
