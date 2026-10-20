import { NextRequest, NextResponse } from "next/server";
import { getIoUserFromRequest } from "@/lib/io/auth";
import { ioPgQuery } from "@/lib/io/pg-db";
import { ioConfigurationMessage } from "@/lib/io/configuration-error";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  try {
    const user = await getIoUserFromRequest(request);
    if (!user) return NextResponse.json({ error: "Please sign in" }, { status: 401 });
    const result = await ioPgQuery(`WITH activity AS (
      SELECT a.username, u.unlocked_at AS updated_at FROM user_unlocks u JOIN accounts a ON a.account_id=u.account_id WHERE u.user_id=$1
      UNION ALL SELECT a.username, u.unlocked_at FROM user_range_unlocks u JOIN accounts a ON a.account_id=u.account_id WHERE u.user_id=$1
      UNION ALL SELECT username, created_at FROM acquisition_runs WHERE requested_by_user_id=$1
      UNION ALL SELECT username, created_at FROM range_unlock_requests WHERE user_id=$1
    ), account_activity AS (
      SELECT LOWER(username) AS username, MAX(updated_at) AS updated_at
      FROM activity GROUP BY LOWER(username)
    ), prefix_access AS (
      SELECT LOWER(a.username) AS username, MAX(u.boundary_end)::INTEGER AS boundary
      FROM user_unlocks u JOIN accounts a ON a.account_id=u.account_id
      WHERE u.user_id=$1 GROUP BY LOWER(a.username)
    ), range_access AS (
      SELECT LOWER(a.username) AS username, COUNT(*)::INTEGER AS range_count
      FROM user_range_unlocks u JOIN accounts a ON a.account_id=u.account_id
      WHERE u.user_id=$1 GROUP BY LOWER(a.username)
    ), request_activity AS (
      SELECT LOWER(username) AS username, status, created_at FROM acquisition_runs WHERE requested_by_user_id=$1
      UNION ALL
      SELECT LOWER(username), status, created_at FROM range_unlock_requests WHERE user_id=$1
    ), request_summary AS (
      SELECT username,
        BOOL_OR(status IN ('queued','running')) AS active,
        (ARRAY_AGG(status ORDER BY created_at DESC))[1] AS latest_status
      FROM request_activity GROUP BY username
    )
    SELECT aa.username, aa.updated_at,
      COALESCE(pa.boundary, 0) AS boundary,
      COALESCE(ra.range_count, 0) AS range_count,
      COALESCE(rs.active, FALSE) AS active,
      rs.latest_status
    FROM account_activity aa
    LEFT JOIN prefix_access pa USING (username)
    LEFT JOIN range_access ra USING (username)
    LEFT JOIN request_summary rs USING (username)
    ORDER BY aa.updated_at DESC`, [user.id]);
    return NextResponse.json({ accounts: result.rows });
  } catch { return NextResponse.json({ error: ioConfigurationMessage() }, { status: 503 }); }
}
