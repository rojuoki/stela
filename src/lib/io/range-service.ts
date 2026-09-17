import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { IoCoverageInterval } from "./coverage-frontier";
import { getIoPgAccountByUsername } from "./pg-cache";
import { ioPgQuery, withIoPgTransaction } from "./pg-db";
import { createIoPgRunWithClient, getIoPgRun, type IoPgRun } from "./pg-runs";

const MAX_RANGE_DAYS = 31;
const RANGE_TARGET_COUNT = 2_147_483_647;

export interface IoRangeGap { startAt: string; endAt: string }

function normalize(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("Range timestamps must be valid ISO-8601 values");
  return new Date(parsed).toISOString();
}

export function validateIoRange(startAt: string, endAt: string): IoRangeGap {
  const start = normalize(startAt);
  const end = normalize(endAt);
  if (Date.parse(start) >= Date.parse(end)) throw new Error("Range start must be before end");
  if (Date.parse(end) - Date.parse(start) > MAX_RANGE_DAYS * 86_400_000) {
    throw new Error(`Range cannot exceed ${MAX_RANGE_DAYS} days`);
  }
  return { startAt: start, endAt: end };
}

export function subtractIoCoverage(range: IoRangeGap, windows: readonly IoCoverageInterval[]): IoRangeGap[] {
  const start = Date.parse(range.startAt);
  const end = Date.parse(range.endAt);
  let cursor = start;
  const gaps: IoRangeGap[] = [];
  for (const row of [...windows].sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt))) {
    const windowStart = Math.max(start, Date.parse(row.startAt));
    const windowEnd = Math.min(end, Date.parse(row.endAt));
    if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd) || windowEnd <= cursor) continue;
    if (windowStart > cursor) gaps.push({ startAt: new Date(cursor).toISOString(), endAt: new Date(windowStart).toISOString() });
    cursor = Math.max(cursor, windowEnd);
  }
  if (cursor < end) gaps.push({ startAt: new Date(cursor).toISOString(), endAt: new Date(end).toISOString() });
  return gaps;
}

export async function getIoRangeGaps(input: {
  accountId: string; provider: string; startAt: string; endAt: string;
}): Promise<IoRangeGap[]> {
  const rows = await ioPgQuery<{ start_at: string; end_at: string }>(
    `SELECT start_at::text, end_at::text FROM coverage_windows
     WHERE account_id = $1 AND provider = $2 AND status = 'complete'
       AND end_at > $3::timestamptz AND start_at < $4::timestamptz
     ORDER BY start_at ASC, end_at ASC`,
    [input.accountId, input.provider, input.startAt, input.endAt],
  );
  return subtractIoCoverage(
    { startAt: input.startAt, endAt: input.endAt },
    rows.rows.map((row) => ({ startAt: row.start_at, endAt: row.end_at })),
  );
}

async function getIoRangeGapsWithClient(client: PoolClient, input: {
  accountId: string; provider: string; startAt: string; endAt: string;
}): Promise<IoRangeGap[]> {
  const rows = await client.query<{ start_at: string; end_at: string }>(
    `SELECT start_at::text, end_at::text FROM coverage_windows
     WHERE account_id = $1 AND provider = $2 AND status = 'complete'
       AND end_at > $3::timestamptz AND start_at < $4::timestamptz
     ORDER BY start_at ASC, end_at ASC`,
    [input.accountId, input.provider, input.startAt, input.endAt],
  );
  return subtractIoCoverage(
    { startAt: input.startAt, endAt: input.endAt },
    rows.rows.map((row) => ({ startAt: row.start_at, endAt: row.end_at })),
  );
}

async function grantIoRange(userId: string, accountId: string, range: IoRangeGap, sourceRunId: string | null) {
  await ioPgQuery(
    `INSERT INTO user_range_unlocks (user_id, account_id, start_at, end_at, source_run_id)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id, account_id, start_at, end_at) DO NOTHING`,
    [userId, accountId, range.startAt, range.endAt, sourceRunId],
  );
}

async function grantIoRangeWithClient(
  client: PoolClient, userId: string, accountId: string, range: IoRangeGap, sourceRunId: string | null,
) {
  await client.query(
    `INSERT INTO user_range_unlocks (user_id, account_id, start_at, end_at, source_run_id)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id, account_id, start_at, end_at) DO NOTHING`,
    [userId, accountId, range.startAt, range.endAt, sourceRunId],
  );
}

export type IoRangeRequestResult =
  | { kind: "granted"; range: IoRangeGap }
  | { kind: "queued"; range: IoRangeGap; requestId: string; run: IoPgRun };

export interface IoRangeRequestStatus {
  id: string;
  username: string;
  startAt: string;
  endAt: string;
  status: "queued" | "running" | "succeeded" | "failed" | "canceled";
  errorMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
  run: IoPgRun | null;
}

export async function getIoRangeRequestForUser(
  requestId: string,
  userId: string,
): Promise<IoRangeRequestStatus | null> {
  const request = await ioPgQuery<{
    id: string; username: string; start_at: string; end_at: string; status: IoRangeRequestStatus["status"];
    error_message: string | null; created_at: string; finished_at: string | null;
  }>(
    `SELECT id, username, start_at::text, end_at::text, status, error_message,
            created_at::text, finished_at::text
     FROM range_unlock_requests WHERE id = $1 AND user_id = $2`,
    [requestId, userId],
  );
  const row = request.rows[0];
  if (!row) return null;
  const runs = await ioPgQuery<Record<string, unknown>>(
    `SELECT *, created_at::text, started_at::text, finished_at::text,
            requested_start_at::text, requested_end_at::text, lease_expires_at::text
     FROM acquisition_runs WHERE range_request_id = $1
     ORDER BY created_at DESC LIMIT 1`,
    [requestId],
  );
  const latest = runs.rows[0] ? await getIoPgRun(String(runs.rows[0].id)) : null;
  return {
    id: row.id, username: row.username, startAt: row.start_at, endAt: row.end_at,
    status: row.status, errorMessage: row.error_message, createdAt: row.created_at,
    finishedAt: row.finished_at, run: latest,
  };
}

export async function requestIoRangeUnlock(input: {
  userId: string; username: string; startAt: string; endAt: string;
}): Promise<IoRangeRequestResult> {
  const range = validateIoRange(input.startAt, input.endAt);
  const provider = "twitterapi_io";
  const account = await getIoPgAccountByUsername(input.username);
  const gaps = account
    ? await getIoRangeGaps({ accountId: account.account_id, provider, ...range })
    : [range];
  if (account && gaps.length === 0) {
    await grantIoRange(input.userId, account.account_id, range, null);
    return { kind: "granted", range };
  }
  const requestId = randomUUID();
  const first = gaps[0];
  const run = await withIoPgTransaction(async (client) => {
    await client.query(
      `INSERT INTO range_unlock_requests (id, user_id, account_id, username, start_at, end_at, provider, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'queued')`,
      [requestId, input.userId, account?.account_id ?? null, input.username.toLowerCase(),
        range.startAt, range.endAt, provider],
    );
    return createIoPgRunWithClient(client, {
      accountId: account?.account_id ?? null, username: input.username,
      requestedByUserId: input.userId, provider, collectionMode: "date_range",
      targetCount: RANGE_TARGET_COUNT, requestedStartAt: first.startAt, requestedEndAt: first.endAt,
      rangeRequestId: requestId,
    });
  });
  return { kind: "queued", range, requestId, run };
}

/** Called after a terminal range child run: grant the full request only when every gap is resolved. */
export async function advanceIoRangeRequest(requestId: string, sourceRunId: string, succeeded: boolean): Promise<void> {
  await withIoPgTransaction(async (client) => {
    const request = await client.query<{
    id: string; user_id: string; account_id: string | null; username: string; start_at: string; end_at: string; provider: string;
    }>(`SELECT id, user_id, account_id, username, start_at::text, end_at::text, provider
        FROM range_unlock_requests WHERE id = $1 FOR UPDATE`, [requestId]);
    const row = request.rows[0];
    if (!row) return;
    if (!succeeded || !row.account_id) {
      await client.query(
      "UPDATE range_unlock_requests SET status = 'failed', error_message = 'Range acquisition did not resolve all required coverage', finished_at = NOW() WHERE id = $1",
      [requestId],
      );
      return;
    }
    const range = { startAt: row.start_at, endAt: row.end_at };
    const gaps = await getIoRangeGapsWithClient(client, { accountId: row.account_id, provider: row.provider, ...range });
    if (gaps.length === 0) {
      await grantIoRangeWithClient(client, row.user_id, row.account_id, range, sourceRunId);
      await client.query("UPDATE range_unlock_requests SET status = 'succeeded', finished_at = NOW() WHERE id = $1", [requestId]);
      return;
    }
    const next = gaps[0];
    await createIoPgRunWithClient(client, {
      accountId: row.account_id, username: row.username, requestedByUserId: row.user_id,
      provider: row.provider, collectionMode: "date_range", targetCount: RANGE_TARGET_COUNT,
      requestedStartAt: next.startAt, requestedEndAt: next.endAt, rangeRequestId: requestId,
    });
  });
}
