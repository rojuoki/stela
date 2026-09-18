import fs from "node:fs";
import path from "node:path";
import type { PoolClient } from "pg";
import { computeIoCoverageFrontier, type IoCoverageInterval } from "./coverage-frontier";
import { withIoPgTransaction } from "./pg-db";

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}
function records(value: unknown): RecordValue[] {
  return Array.isArray(value) ? value.map(record) : [];
}
function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
function jsonArray(value: unknown): string | null {
  // node-postgres encodes JS arrays as PostgreSQL arrays, not JSON.
  return Array.isArray(value) && value.length ? JSON.stringify(value) : null;
}

interface CompleteWindow extends IoCoverageInterval {
  source: RecordValue;
}

function completeWindow(value: RecordValue): CompleteWindow | null {
  const startAt = text(value.start);
  const endAt = text(value.end);
  const status = text(value.status);
  if (!startAt || !endAt || (status !== "RESOLVED" && status !== "COMPLETE")) return null;
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  return Number.isFinite(start) && Number.isFinite(end) && start < end
    ? { startAt, endAt, source: value }
    : null;
}

function inWindows(value: string, windows: readonly CompleteWindow[]): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && windows.some((window) =>
    timestamp >= Date.parse(window.startAt) && timestamp < Date.parse(window.endAt),
  );
}

async function completeWindows(
  client: PoolClient,
  accountId: string,
  provider: string,
): Promise<IoCoverageInterval[]> {
  const result = await client.query<{ startAt: string; endAt: string }>(
    `SELECT start_at::text AS "startAt", end_at::text AS "endAt"
     FROM coverage_windows
     WHERE account_id = $1 AND provider = $2 AND status = 'complete'
     ORDER BY start_at ASC, end_at ASC`,
    [accountId, provider],
  );
  return result.rows;
}

function attachedWindows(input: {
  baseFrontier: string;
  incoming: RecordValue[];
}): CompleteWindow[] {
  let frontier = Date.parse(input.baseFrontier);
  const accepted: CompleteWindow[] = [];
  for (const window of input.incoming.map(completeWindow).filter((row): row is CompleteWindow => !!row)
    .sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt))) {
    const start = Date.parse(window.startAt);
    const end = Date.parse(window.endAt);
    if (end <= frontier || start > frontier) continue;
    accepted.push(window);
    frontier = Math.max(frontier, end);
  }
  return accepted;
}

export interface IoPgResultImport {
  accountId: string | null;
  discarded: boolean;
  terminalSuccess: boolean;
}

/**
 * Imports only coverage that attaches to the run's declared prefix start.
 * An island has no product value for prefix unlocks, so its run is removed in
 * the same transaction without persisting posts or coverage.
 */
export async function importIoPgAcquisitionResult(
  inputPath: string,
  runId: string,
  workerId?: string,
): Promise<IoPgResultImport> {
  const absolutePath = path.resolve(inputPath);
  const payload = record(JSON.parse(fs.readFileSync(absolutePath, "utf8")));
  const profile = record(payload.profile);
  const config = record(payload.config);
  const result = record(payload.result);
  const metrics = record(payload.metrics);
  const accountId = text(profile.account_id) || text(profile.id);
  const username = (text(payload.username) || text(profile.username) || "").toLowerCase();
  if (!accountId || !username) throw new Error("Result JSON is missing username or profile.account_id");

  return withIoPgTransaction(async (client) => {
    const runResult = await client.query<{
      id: string; account_id: string | null; provider: string; collection_mode: string;
      status: string; worker_id: string | null;
      requested_start_at: string | null; requested_end_at: string | null; target_boundary: number | null;
      range_request_id: string | null;
    }>(
      `SELECT id, account_id, provider, collection_mode, status, worker_id, requested_start_at::text,
              requested_end_at::text, target_boundary
              , range_request_id
       FROM acquisition_runs WHERE id = $1 FOR UPDATE`,
      [runId],
    );
    const run = runResult.rows[0];
    if (!run) throw new Error("Acquisition run no longer exists");
    if (workerId && (run.worker_id !== workerId || run.status !== "running")) {
      throw new Error("Worker no longer owns this acquisition run");
    }
    if (run.status === "canceled") {
      return { accountId: run.account_id, discarded: true, terminalSuccess: false };
    }

    await client.query(
      `INSERT INTO accounts (
         account_id, username, display_name, avatar_url, cover_url, description,
         created_at, protected, followers_count, following_count, statuses_count
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (account_id) DO UPDATE SET
         username = EXCLUDED.username, display_name = EXCLUDED.display_name,
         avatar_url = EXCLUDED.avatar_url, cover_url = EXCLUDED.cover_url,
         description = EXCLUDED.description, created_at = EXCLUDED.created_at,
         protected = EXCLUDED.protected, followers_count = EXCLUDED.followers_count,
         following_count = EXCLUDED.following_count, statuses_count = EXCLUDED.statuses_count,
         fetched_at = NOW()`,
      [accountId, username, text(profile.display_name), text(profile.avatar_url),
        text(profile.cover_url), text(profile.description), text(profile.created_at),
        Boolean(profile.protected), number(profile.followers_count), number(profile.following_count),
        number(profile.statuses_count)],
    );
    if (run.range_request_id) {
      await client.query(
        "UPDATE range_unlock_requests SET account_id = $2, username = $3, status = 'running' WHERE id = $1",
        [run.range_request_id, accountId, username],
      );
    }
    const account = await client.query<{ created_at: string | null }>(
      "SELECT created_at::text AS created_at FROM accounts WHERE account_id = $1 FOR UPDATE",
      [accountId],
    );
    const createdAt = account.rows[0]?.created_at;
    if (!createdAt) throw new Error("Account creation time is unavailable");

    const existing = await completeWindows(client, accountId, run.provider);
    const existingFrontier = computeIoCoverageFrontier(createdAt, existing);
    if (!existingFrontier) throw new Error("Existing coverage frontier is invalid");
    const expectedStart = run.collection_mode === "prefix_extend"
      ? existingFrontier.frontierAt
      : run.collection_mode === "date_range"
        ? run.requested_start_at
        : existingFrontier.startsAt;
    const declaredStart = run.collection_mode === "prefix_extend" || run.collection_mode === "date_range"
      ? run.requested_start_at
      : text(config.collect_start) || createdAt;
    if (!expectedStart || !declaredStart || Date.parse(declaredStart) !== Date.parse(expectedStart)) {
      await client.query("DELETE FROM acquisition_runs WHERE id = $1", [run.id]);
      return { accountId: null, discarded: true, terminalSuccess: false };
    }

    const accepted = attachedWindows({ baseFrontier: expectedStart, incoming: records(payload.windows) });
    const candidateRows = records(payload.candidate_posts).length
      ? records(payload.candidate_posts) : records(payload.posts);
    for (const post of candidateRows) {
      const postId = text(post.post_id) || text(post.id);
      const createdAtPost = text(post.created_at) || text(post.date);
      if (!postId || !createdAtPost || !inWindows(createdAtPost, accepted)) continue;
      await client.query(
        `INSERT INTO posts (
           post_id, account_id, author_username, created_at, full_text, url, language,
           media_json, mentions_json, like_count, retweet_count, reply_count, quote_count,
           view_count, conversation_id, in_reply_to_post_id, in_reply_to_user_id,
           in_reply_to_username, provider, source_run_id, coverage_state, candidate_sightings
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'covered',$21)
         ON CONFLICT (post_id) DO UPDATE SET
           coverage_state = 'covered', candidate_sightings = GREATEST(posts.candidate_sightings, EXCLUDED.candidate_sightings),
           source_run_id = COALESCE(posts.source_run_id, EXCLUDED.source_run_id), fetched_at = NOW()`,
        [postId, accountId, text(post.author_username) || username, createdAtPost,
          text(post.text) || text(post.full_text) || "", text(post.url), text(post.language),
          jsonArray(post.media), jsonArray(post.mentions), number(post.like_count), number(post.retweet_count),
          number(post.reply_count), number(post.quote_count), number(post.view_count),
          text(post.conversation_id), text(post.in_reply_to_post_id) || text(post.in_reply_to_tweet_id),
          text(post.in_reply_to_user_id), text(post.in_reply_to_username), run.provider, run.id,
          Math.max(1, number(post.candidate_sightings))],
      );
    }
    for (const window of accepted) {
      const source = window.source;
      await client.query(
        `INSERT INTO coverage_windows (
           run_id, account_id, provider, start_at, end_at, status, resolution_basis,
           termination_reason, request_count, page_count, unique_count
         ) VALUES ($1,$2,$3,$4,$5,'complete',$6,$7,$8,$9,$10)
         ON CONFLICT (run_id, start_at, end_at) DO NOTHING`,
        [run.id, accountId, run.provider, window.startAt, window.endAt,
          text(source.resolution_basis), text(source.termination_reason),
          number(source.requests), number(source.pages), number(source.unique_post_count)],
      );
    }
    const runnerStatus = text(result.status);
    const terminalSuccess = runnerStatus === "EXPERIMENTAL_SUCCESS"
      || runnerStatus === "EXPERIMENTAL_ACCOUNT_HAS_LESS_THAN_TARGET";
    await client.query(
      `UPDATE acquisition_runs SET account_id = $2, username = $3,
         status = $4, progress_message = $5, request_count = $6, page_count = $7,
         unique_count = $8, candidate_count = $9, duplicate_count = $10,
         estimated_cost_usd = $11, result_json = $12::jsonb, output_path = $13,
         error_message = $14, error_code = CASE WHEN $4 = 'failed' THEN 'runner_incomplete' ELSE NULL END,
         finished_at = NOW(), lease_expires_at = NULL
       WHERE id = $1`,
      [run.id, accountId, username, terminalSuccess ? "succeeded" : "failed",
        terminalSuccess ? "Acquisition complete" : "Acquisition did not reach a terminal resolved result",
        number(metrics.total_requests ?? metrics.total_request_calls), number(metrics.total_pages),
        number(result.unique_post_count), candidateRows.length, number(metrics.duplicate_sightings),
        number(metrics.estimated_cost_usd), JSON.stringify({ config, result, metrics }), absolutePath,
        terminalSuccess ? null : text(result.error)],
    );
    return { accountId, discarded: false, terminalSuccess };
  });
}
