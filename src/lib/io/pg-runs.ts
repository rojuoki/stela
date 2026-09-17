import { randomUUID } from "node:crypto";
import { ioPgQuery, withIoPgTransaction } from "./pg-db";
import type { PoolClient } from "pg";

export type IoPgRunStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";
export type IoPgCollectionMode = "prefix_initial" | "prefix_extend" | "prefix_grant" | "date_range";

export interface IoPgRun {
  id: string;
  account_id: string | null;
  username: string;
  requested_by_user_id: string | null;
  provider: string;
  collection_mode: IoPgCollectionMode;
  target_count: number | null;
  base_boundary: number | null;
  target_boundary: number | null;
  granted_boundary: number | null;
  requested_start_at: string | null;
  requested_end_at: string | null;
  status: IoPgRunStatus;
  progress_message: string | null;
  request_count: number;
  page_count: number;
  unique_count: number;
  candidate_count: number;
  duplicate_count: number;
  estimated_cost_usd: number | null;
  checkpoint_json: unknown | null;
  result_json: unknown | null;
  output_path: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  worker_id: string | null;
  lease_expires_at: string | null;
  attempt_count: number;
  range_request_id: string | null;
}

function numberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value: unknown): string | null {
  return value == null ? null : String(value);
}

function toRun(row: Record<string, unknown>): IoPgRun {
  return {
    id: String(row.id), account_id: iso(row.account_id), username: String(row.username),
    requested_by_user_id: iso(row.requested_by_user_id), provider: String(row.provider),
    collection_mode: row.collection_mode as IoPgCollectionMode,
    target_count: numberOrNull(row.target_count), base_boundary: numberOrNull(row.base_boundary),
    target_boundary: numberOrNull(row.target_boundary), granted_boundary: numberOrNull(row.granted_boundary),
    requested_start_at: iso(row.requested_start_at), requested_end_at: iso(row.requested_end_at),
    status: row.status as IoPgRunStatus, progress_message: iso(row.progress_message),
    request_count: Number(row.request_count ?? 0), page_count: Number(row.page_count ?? 0),
    unique_count: Number(row.unique_count ?? 0), candidate_count: Number(row.candidate_count ?? 0),
    duplicate_count: Number(row.duplicate_count ?? 0), estimated_cost_usd: numberOrNull(row.estimated_cost_usd),
    checkpoint_json: row.checkpoint_json ?? null, result_json: row.result_json ?? null,
    output_path: iso(row.output_path), error_code: iso(row.error_code), error_message: iso(row.error_message),
    created_at: String(row.created_at), started_at: iso(row.started_at), finished_at: iso(row.finished_at),
    worker_id: iso(row.worker_id), lease_expires_at: iso(row.lease_expires_at),
    attempt_count: Number(row.attempt_count ?? 0),
    range_request_id: iso(row.range_request_id),
  };
}

export async function getIoPgRun(id: string): Promise<IoPgRun | null> {
  const result = await ioPgQuery<Record<string, unknown>>(
    "SELECT *, created_at::text, started_at::text, finished_at::text, requested_start_at::text, requested_end_at::text, lease_expires_at::text FROM acquisition_runs WHERE id = $1",
    [id],
  );
  return result.rows[0] ? toRun(result.rows[0]) : null;
}

export async function getIoPgRunForUser(id: string, userId: string): Promise<IoPgRun | null> {
  const result = await ioPgQuery<Record<string, unknown>>(
    `SELECT *, created_at::text, started_at::text, finished_at::text,
            requested_start_at::text, requested_end_at::text, lease_expires_at::text
     FROM acquisition_runs WHERE id = $1 AND requested_by_user_id = $2`,
    [id, userId],
  );
  return result.rows[0] ? toRun(result.rows[0]) : null;
}

export async function getActiveIoPgRunForUsername(username: string): Promise<IoPgRun | null> {
  const result = await ioPgQuery<Record<string, unknown>>(
    `SELECT *, created_at::text, started_at::text, finished_at::text,
            requested_start_at::text, requested_end_at::text, lease_expires_at::text
     FROM acquisition_runs
     WHERE LOWER(username) = LOWER($1) AND status IN ('queued', 'running')
       AND collection_mode <> 'prefix_grant'
     ORDER BY acquisition_runs.created_at ASC LIMIT 1`,
    [username],
  );
  return result.rows[0] ? toRun(result.rows[0]) : null;
}

export async function getActiveIoPgRunForUserAndUsername(
  userId: string,
  username: string,
): Promise<IoPgRun | null> {
  const result = await ioPgQuery<Record<string, unknown>>(
    `SELECT *, created_at::text, started_at::text, finished_at::text,
            requested_start_at::text, requested_end_at::text, lease_expires_at::text
     FROM acquisition_runs
     WHERE requested_by_user_id = $1 AND LOWER(username) = LOWER($2)
       AND status IN ('queued', 'running')
     ORDER BY acquisition_runs.created_at ASC LIMIT 1`,
    [userId, username],
  );
  return result.rows[0] ? toRun(result.rows[0]) : null;
}

export interface CreateIoPgRunInput {
  accountId?: string | null;
  username: string;
  requestedByUserId: string;
  provider: string;
  collectionMode: IoPgCollectionMode;
  targetCount?: number | null;
  baseBoundary?: number | null;
  targetBoundary?: number | null;
  requestedStartAt?: string | null;
  requestedEndAt?: string | null;
  rangeRequestId?: string | null;
}

export async function createIoPgRunWithClient(
  client: PoolClient,
  input: CreateIoPgRunInput,
): Promise<IoPgRun> {
  const id = randomUUID();
  const result = await client.query<Record<string, unknown>>(
    `INSERT INTO acquisition_runs (
       id, account_id, username, requested_by_user_id, provider, collection_mode,
       target_count, base_boundary, target_boundary, requested_start_at, requested_end_at,
       range_request_id, status, progress_message
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'queued','Queued')
     RETURNING *, created_at::text, started_at::text, finished_at::text,
       requested_start_at::text, requested_end_at::text, lease_expires_at::text`,
    [id, input.accountId ?? null, input.username.toLowerCase(), input.requestedByUserId,
      input.provider, input.collectionMode, input.targetCount ?? null,
      input.baseBoundary ?? null, input.targetBoundary ?? null,
      input.requestedStartAt ?? null, input.requestedEndAt ?? null, input.rangeRequestId ?? null],
  );
  return toRun(result.rows[0]);
}

export async function createIoPgRun(input: CreateIoPgRunInput): Promise<IoPgRun> {
  return withIoPgTransaction((client) => createIoPgRunWithClient(client, input));
}

/** Atomically claims one queued or expired lease run for a long-lived worker. */
export async function claimNextIoPgRun(workerId: string, leaseSeconds = 90): Promise<IoPgRun | null> {
  return withIoPgTransaction(async (client) => {
    const result = await client.query<Record<string, unknown>>(
      `WITH candidate AS (
         SELECT id, username, collection_mode FROM acquisition_runs
         WHERE (status = 'queued'
            OR (status = 'running' AND lease_expires_at < NOW()))
           AND (collection_mode = 'prefix_grant' OR NOT EXISTS (
             SELECT 1 FROM acquisition_runs active
             WHERE LOWER(active.username) = LOWER(acquisition_runs.username)
               AND active.id <> acquisition_runs.id
               AND active.status = 'running'
               AND active.lease_expires_at >= NOW()
           ))
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE acquisition_runs run
       SET status = 'running', worker_id = $1,
           lease_expires_at = NOW() + ($2 * INTERVAL '1 second'),
           attempt_count = attempt_count + 1,
           started_at = COALESCE(started_at, NOW()),
           progress_message = 'Starting acquisition worker'
       FROM candidate
       WHERE run.id = candidate.id
       RETURNING run.*, run.created_at::text, run.started_at::text, run.finished_at::text,
         run.requested_start_at::text, run.requested_end_at::text, run.lease_expires_at::text`,
      [workerId, leaseSeconds],
    );
    const claimed = result.rows[0] ? toRun(result.rows[0]) : null;
    if (claimed?.range_request_id) {
      await client.query(
        "UPDATE range_unlock_requests SET status = 'running' WHERE id = $1 AND status = 'queued'",
        [claimed.range_request_id],
      );
    }
    return claimed;
  });
}

export async function updateIoPgRunProgress(input: {
  id: string; workerId: string; message?: string; requestCount?: number;
  pageCount?: number; uniqueCount?: number; candidateCount?: number;
  duplicateCount?: number; checkpoint?: unknown;
}): Promise<boolean> {
  const result = await ioPgQuery(
    `UPDATE acquisition_runs SET
       progress_message = COALESCE($3, progress_message),
       request_count = COALESCE($4, request_count), page_count = COALESCE($5, page_count),
       unique_count = COALESCE($6, unique_count), candidate_count = COALESCE($7, candidate_count),
       duplicate_count = COALESCE($8, duplicate_count), checkpoint_json = COALESCE($9::jsonb, checkpoint_json),
       lease_expires_at = NOW() + INTERVAL '90 seconds'
     WHERE id = $1 AND worker_id = $2 AND status = 'running'`,
    [input.id, input.workerId, input.message ?? null, input.requestCount ?? null,
      input.pageCount ?? null, input.uniqueCount ?? null, input.candidateCount ?? null,
      input.duplicateCount ?? null, input.checkpoint == null ? null : JSON.stringify(input.checkpoint)],
  );
  return result.rowCount === 1;
}

export async function cancelIoPgRunForUser(id: string, userId: string): Promise<IoPgRun | null> {
  const result = await ioPgQuery<Record<string, unknown>>(
    `UPDATE acquisition_runs
     SET status = 'canceled', progress_message = 'Acquisition canceled',
         error_code = 'canceled', error_message = NULL,
         finished_at = NOW(), lease_expires_at = NULL
     WHERE id = $1 AND requested_by_user_id = $2
       AND status IN ('queued', 'running')
     RETURNING *, created_at::text, started_at::text, finished_at::text,
       requested_start_at::text, requested_end_at::text, lease_expires_at::text`,
    [id, userId],
  );
  return result.rows[0] ? toRun(result.rows[0]) : null;
}

/** Return interrupted work only after its child has stopped and progress is saved. */
export async function requeueIoPgRun(id: string, workerId: string): Promise<void> {
  await ioPgQuery(
    `UPDATE acquisition_runs SET status = 'queued', worker_id = NULL,
       lease_expires_at = NULL, progress_message = 'Acquisition will resume'
     WHERE id = $1 AND worker_id = $2 AND status = 'running'`,
    [id, workerId],
  );
}

export async function failIoPgRun(input: {
  id: string; workerId: string; message: string; errorCode: string; outputPath?: string | null;
}): Promise<void> {
  await ioPgQuery(
    `UPDATE acquisition_runs
     SET status = 'failed', progress_message = $3, error_code = $4, error_message = $3,
         output_path = COALESCE($5, output_path), finished_at = NOW(), lease_expires_at = NULL
     WHERE id = $1 AND worker_id = $2 AND status = 'running'`,
    [input.id, input.workerId, input.message, input.errorCode, input.outputPath ?? null],
  );
}

/** Marks a cache-only prefix run ready for the normal atomic settlement path. */
export async function completeIoPgCacheGrant(input: {
  id: string;
  workerId: string;
}): Promise<void> {
  const result = await ioPgQuery(
    `UPDATE acquisition_runs
     SET status = 'succeeded', progress_message = 'Acquisition complete',
         request_count = 0, page_count = 0, estimated_cost_usd = 0,
         finished_at = NOW(), lease_expires_at = NULL
     WHERE id = $1 AND worker_id = $2 AND status = 'running'
       AND collection_mode = 'prefix_grant'`,
    [input.id, input.workerId],
  );
  if (result.rowCount !== 1) {
    throw new Error("Cache-only prefix run could not be completed");
  }
}

export async function clearIoPgRunOutputPath(id: string, workerId: string): Promise<void> {
  await ioPgQuery(
    `UPDATE acquisition_runs SET output_path = NULL, checkpoint_json = NULL
     WHERE id = $1 AND worker_id = $2 AND status = 'succeeded'`,
    [id, workerId],
  );
}
