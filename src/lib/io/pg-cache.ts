import { ioPgQuery } from "./pg-db";
import type { IoPost } from "./repository";
import {
  computeIoCoverageFrontier,
  type IoCoverageFrontier,
  type IoCoverageInterval,
} from "./coverage-frontier";

export { computeIoCoverageFrontier } from "./coverage-frontier";
export type { IoCoverageFrontier, IoCoverageInterval } from "./coverage-frontier";

export interface IoPgAccount {
  account_id: string;
  username: string;
  created_at: string | null;
}

export interface IoCoveredPrefixSummary {
  account: IoPgAccount;
  provider: string;
  frontier: IoCoverageFrontier;
  coveredPostCount: number;
}

export interface IoRankedPost extends IoPost {
  rank: number;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : value == null ? null : String(value);
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toIoPost(row: Record<string, unknown>): IoPost {
  return {
    post_id: text(row.post_id) || "",
    account_id: text(row.account_id) || "",
    author_username: text(row.author_username) || "",
    created_at: text(row.created_at) || "",
    full_text: text(row.full_text) || "",
    url: text(row.url),
    language: text(row.language),
    media_json: text(row.media_json),
    mentions_json: text(row.mentions_json),
    like_count: number(row.like_count),
    retweet_count: number(row.retweet_count),
    reply_count: number(row.reply_count),
    quote_count: number(row.quote_count),
    view_count: number(row.view_count),
    conversation_id: text(row.conversation_id),
    in_reply_to_post_id: text(row.in_reply_to_post_id),
    in_reply_to_user_id: text(row.in_reply_to_user_id),
    in_reply_to_username: text(row.in_reply_to_username),
    provider: text(row.provider) || "",
    source_run_id: text(row.source_run_id),
    coverage_state: row.coverage_state === "covered" ? "covered" : "candidate",
    candidate_sightings: number(row.candidate_sightings),
    fetched_at: text(row.fetched_at) || "",
  };
}

export async function getIoPgAccountById(accountId: string): Promise<IoPgAccount | null> {
  const result = await ioPgQuery<Record<string, unknown>>(
    `SELECT account_id, username, created_at::text AS created_at
     FROM accounts WHERE account_id = $1`,
    [accountId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    account_id: text(row.account_id) || accountId,
    username: text(row.username) || "",
    created_at: text(row.created_at),
  };
}

export async function getIoPgAccountByUsername(username: string): Promise<IoPgAccount | null> {
  const result = await ioPgQuery<Record<string, unknown>>(
    `SELECT account_id, username, created_at::text AS created_at
     FROM accounts WHERE LOWER(username) = LOWER($1)`,
    [username],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    account_id: text(row.account_id) || "",
    username: text(row.username) || "",
    created_at: text(row.created_at),
  };
}

async function getCompleteIoCoverageWindows(
  accountId: string,
  provider: string,
): Promise<IoCoverageInterval[]> {
  const result = await ioPgQuery<Record<string, unknown>>(
    `SELECT start_at::text AS "startAt", end_at::text AS "endAt"
     FROM coverage_windows
     WHERE account_id = $1 AND provider = $2 AND status = 'complete'
     ORDER BY start_at ASC, end_at ASC`,
    [accountId, provider],
  );
  return result.rows.flatMap((row) => {
    const startAt = text(row.startAt);
    const endAt = text(row.endAt);
    return startAt && endAt ? [{ startAt, endAt }] : [];
  });
}

/**
 * Returns only the prefix that is proven complete from account creation.
 * A provider is required: coverage from two providers is not silently merged.
 */
export async function getIoCoveredPrefixSummary(
  accountId: string,
  provider: string,
): Promise<IoCoveredPrefixSummary | null> {
  const account = await getIoPgAccountById(accountId);
  if (!account?.created_at) return null;

  const frontier = computeIoCoverageFrontier(
    account.created_at,
    await getCompleteIoCoverageWindows(accountId, provider),
  );
  if (!frontier) return null;

  const count = await ioPgQuery<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM posts
     WHERE account_id = $1
       AND provider = $2
       AND coverage_state = 'covered'
       AND created_at >= $3::timestamptz
       AND created_at < $4::timestamptz`,
    [accountId, provider, frontier.startsAt, frontier.frontierAt],
  );

  return {
    account,
    provider,
    frontier,
    coveredPostCount: number(count.rows[0]?.count),
  };
}

/**
 * Reads a deterministic 1-based slice of the covered prefix. The caller can
 * use the returned rank directly as the unlock boundary contract.
 */
export async function getIoCoveredPrefixPostsByRank(
  accountId: string,
  provider: string,
  options: { offset?: number; limit?: number } = {},
): Promise<{ summary: IoCoveredPrefixSummary; posts: IoRankedPost[] } | null> {
  const summary = await getIoCoveredPrefixSummary(accountId, provider);
  if (!summary) return null;

  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const limit = Math.max(1, Math.min(50_000, Math.floor(options.limit ?? 100)));
  const result = await ioPgQuery<Record<string, unknown>>(
    `WITH ranked_posts AS (
       SELECT posts.*, ROW_NUMBER() OVER (ORDER BY created_at ASC, post_id ASC)::integer AS rank
       FROM posts
       WHERE account_id = $1
         AND provider = $2
         AND coverage_state = 'covered'
         AND created_at >= $3::timestamptz
         AND created_at < $4::timestamptz
     )
     SELECT ranked_posts.*, created_at::text AS created_at,
            fetched_at::text AS fetched_at,
            media_json::text AS media_json, mentions_json::text AS mentions_json
     FROM ranked_posts
     ORDER BY rank ASC
     LIMIT $5 OFFSET $6`,
    [
      accountId,
      provider,
      summary.frontier.startsAt,
      summary.frontier.frontierAt,
      limit,
      offset,
    ],
  );

  return {
    summary,
    posts: result.rows.map((row) => ({ ...toIoPost(row), rank: number(row.rank) })),
  };
}

export async function getIoCoveredPostsForRange(
  accountId: string,
  provider: string,
  startAt: string,
  endAt: string,
  limit = 50_000,
): Promise<IoPost[]> {
  const result = await ioPgQuery<Record<string, unknown>>(
    `SELECT *, created_at::text AS created_at, fetched_at::text AS fetched_at,
            media_json::text AS media_json, mentions_json::text AS mentions_json
     FROM posts
     WHERE account_id = $1 AND provider = $2 AND coverage_state = 'covered'
       AND created_at >= $3::timestamptz AND created_at < $4::timestamptz
     ORDER BY created_at ASC, post_id ASC LIMIT $5`,
    [accountId, provider, startAt, endAt, Math.max(1, Math.min(50_000, Math.floor(limit)))],
  );
  return result.rows.map(toIoPost);
}
