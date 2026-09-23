import { NextRequest, NextResponse } from "next/server";
import { getIoUserFromRequest } from "@/lib/io/auth";
import { ioPgQuery } from "@/lib/io/pg-db";
import { ioConfigurationMessage } from "@/lib/io/configuration-error";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  try {
    const user = await getIoUserFromRequest(request);
    if (!user) return NextResponse.json({ error: "ログインしてください" }, { status: 401 });
    const result = await ioPgQuery(`WITH activity AS (
      SELECT a.username, u.unlocked_at AS updated_at FROM user_unlocks u JOIN accounts a ON a.account_id=u.account_id WHERE u.user_id=$1
      UNION ALL SELECT a.username, u.unlocked_at FROM user_range_unlocks u JOIN accounts a ON a.account_id=u.account_id WHERE u.user_id=$1
      UNION ALL SELECT username, created_at FROM acquisition_runs WHERE requested_by_user_id=$1
      UNION ALL SELECT username, created_at FROM range_unlock_requests WHERE user_id=$1
    ) SELECT LOWER(username) AS username, MAX(updated_at) AS updated_at FROM activity GROUP BY LOWER(username) ORDER BY MAX(updated_at) DESC`, [user.id]);
    return NextResponse.json({ accounts: result.rows });
  } catch { return NextResponse.json({ error: ioConfigurationMessage() }, { status: 503 }); }
}
