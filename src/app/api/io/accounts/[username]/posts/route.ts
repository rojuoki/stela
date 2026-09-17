import { NextRequest, NextResponse } from "next/server";
import { getIoUserFromRequest } from "@/lib/io/auth";
import { getIoPgAccountByUsername, getIoCoveredPostsForRange, getIoCoveredPrefixPostsByRank } from "@/lib/io/pg-cache";
import { ioPgQuery } from "@/lib/io/pg-db";
import { ioProductModeEnabled } from "@/lib/io/product-mode";
import { getIoPgRunForUser } from "@/lib/io/pg-runs";
import { getIoUnlockBoundary } from "@/lib/io/pg-users";
import { getIoAccountByUsername, getIoPostsForAccount } from "@/lib/io/repository";
import { normalizeIoUsername } from "@/lib/io/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ username: string }> },
) {
  const username = normalizeIoUsername((await params).username);
  if (!username) {
    return NextResponse.json({ error: "Invalid username" }, { status: 400 });
  }
  if (ioProductModeEnabled()) {
    const user = await getIoUserFromRequest(request);
    if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    const account = await getIoPgAccountByUsername(username);
    if (!account) return NextResponse.json({ error: "Account not found" }, { status: 404 });
    const url = new URL(request.url);
    const view = url.searchParams.get("view") || "prefix";
    let start = 0;
    let end = await getIoUnlockBoundary(user.id, account.account_id);
    if (view === "delta") {
      const runId = url.searchParams.get("runId");
      if (!runId) return NextResponse.json({ error: "runId is required for delta" }, { status: 400 });
      const run = await getIoPgRunForUser(runId, user.id);
      if (!run || run.account_id !== account.account_id || run.status !== "succeeded") {
        return NextResponse.json({ error: "Delta is not available" }, { status: 404 });
      }
      start = run.base_boundary ?? 0;
      end = Math.min(end, run.granted_boundary ?? start);
    } else if (view === "range") {
      const startAt = url.searchParams.get("startAt");
      const endAt = url.searchParams.get("endAt");
      if (!startAt || !endAt || !Number.isFinite(Date.parse(startAt)) || !Number.isFinite(Date.parse(endAt))) {
        return NextResponse.json({ error: "Valid startAt and endAt are required" }, { status: 400 });
      }
      const entitlement = await ioPgQuery(
        `SELECT 1 FROM user_range_unlocks
         WHERE user_id = $1 AND account_id = $2 AND start_at = $3::timestamptz AND end_at = $4::timestamptz`,
        [user.id, account.account_id, startAt, endAt],
      );
      if (!entitlement.rowCount) return NextResponse.json({ error: "Range is not unlocked" }, { status: 403 });
      const requestedLimit = Number(url.searchParams.get("limit") || 50_000);
      const posts = await getIoCoveredPostsForRange(
        account.account_id, "twitterapi_io", startAt, endAt,
        Number.isFinite(requestedLimit) ? requestedLimit : 50_000,
      );
      return NextResponse.json({ posts, count: posts.length, startAt, endAt });
    } else if (view !== "prefix") {
      return NextResponse.json({ error: "Unsupported post view" }, { status: 400 });
    }
    const requestedLimit = Number(url.searchParams.get("limit") || Math.max(1, end - start));
    const count = Math.max(0, Math.min(Number.isFinite(requestedLimit) ? requestedLimit : 0, end - start));
    if (count === 0) return NextResponse.json({ posts: [], count: 0, boundary: end });
    const result = await getIoCoveredPrefixPostsByRank(account.account_id, "twitterapi_io", {
      offset: start,
      limit: count,
    });
    return NextResponse.json({
      posts: result?.posts || [], count: result?.posts.length || 0, boundary: end,
      availableBoundary: result?.summary.coveredPostCount ?? 0,
    });
  }
  const account = getIoAccountByUsername(username);
  if (!account) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }
  const url = new URL(request.url);
  const query = url.searchParams.get("q") || undefined;
  const requestedLimit = Number(url.searchParams.get("limit") || 10_000);
  const coveredOnly = url.searchParams.get("coveredOnly") === "1";
  const posts = getIoPostsForAccount(account.account_id, {
    query,
    limit: Number.isFinite(requestedLimit) ? requestedLimit : 10_000,
    coveredOnly,
  });
  return NextResponse.json({ posts, count: posts.length });
}
