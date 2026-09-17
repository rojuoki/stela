import { getIoDatabase } from "./db";

export interface IoAccount {
  account_id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  cover_url: string | null;
  description: string | null;
  created_at: string | null;
  protected: number;
  followers_count: number;
  following_count: number;
  statuses_count: number;
  fetched_at: string;
}

export interface IoPost {
  post_id: string;
  account_id: string;
  author_username: string;
  created_at: string;
  full_text: string;
  url: string | null;
  language: string | null;
  media_json: string | null;
  mentions_json: string | null;
  like_count: number;
  retweet_count: number;
  reply_count: number;
  quote_count: number;
  view_count: number;
  conversation_id: string | null;
  in_reply_to_post_id: string | null;
  in_reply_to_user_id: string | null;
  in_reply_to_username: string | null;
  provider: string;
  source_run_id: string | null;
  coverage_state: "candidate" | "covered";
  candidate_sightings: number;
  fetched_at: string;
}

export type IoRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

export interface IoRun {
  id: string;
  account_id: string | null;
  username: string;
  provider: string;
  collection_mode: string;
  target_count: number | null;
  base_boundary: number | null;
  target_boundary: number | null;
  requested_start_at: string | null;
  status: IoRunStatus;
  progress_message: string | null;
  request_count: number;
  page_count: number;
  unique_count: number;
  candidate_count: number;
  duplicate_count: number;
  output_path: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface AccountWrite {
  accountId: string;
  username: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  coverUrl?: string | null;
  description?: string | null;
  createdAt?: string | null;
  protected?: boolean;
  followersCount?: number;
  followingCount?: number;
  statusesCount?: number;
  fetchedAt?: string;
}

export interface PostWrite {
  postId: string;
  accountId: string;
  authorUsername: string;
  createdAt: string;
  fullText: string;
  url?: string | null;
  language?: string | null;
  media?: unknown[];
  mentions?: string[];
  likeCount?: number;
  retweetCount?: number;
  replyCount?: number;
  quoteCount?: number;
  viewCount?: number;
  conversationId?: string | null;
  inReplyToPostId?: string | null;
  inReplyToUserId?: string | null;
  inReplyToUsername?: string | null;
  provider: string;
  sourceRunId?: string | null;
  coverageState?: "candidate" | "covered";
  candidateSightings?: number;
  fetchedAt?: string;
}

export function getIoAccountByUsername(username: string): IoAccount | null {
  const row = getIoDatabase()
    .prepare("SELECT * FROM accounts WHERE username = ? COLLATE NOCASE")
    .get(username) as IoAccount | undefined;
  return row ?? null;
}

export function getIoAccountById(accountId: string): IoAccount | null {
  const row = getIoDatabase()
    .prepare("SELECT * FROM accounts WHERE account_id = ?")
    .get(accountId) as IoAccount | undefined;
  return row ?? null;
}

export function upsertIoAccount(account: AccountWrite): void {
  const now = account.fetchedAt || new Date().toISOString();
  getIoDatabase()
    .prepare(`
      INSERT INTO accounts (
        account_id, username, display_name, avatar_url, cover_url, description,
        created_at, protected, followers_count, following_count, statuses_count,
        fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        username = excluded.username,
        display_name = excluded.display_name,
        avatar_url = excluded.avatar_url,
        cover_url = excluded.cover_url,
        description = excluded.description,
        created_at = excluded.created_at,
        protected = excluded.protected,
        followers_count = excluded.followers_count,
        following_count = excluded.following_count,
        statuses_count = excluded.statuses_count,
        fetched_at = excluded.fetched_at
    `)
    .run(
      account.accountId,
      account.username.toLowerCase(),
      account.displayName ?? null,
      account.avatarUrl ?? null,
      account.coverUrl ?? null,
      account.description ?? null,
      account.createdAt ?? null,
      account.protected ? 1 : 0,
      account.followersCount ?? 0,
      account.followingCount ?? 0,
      account.statusesCount ?? 0,
      now,
    );
}

export function upsertIoPost(post: PostWrite): void {
  const now = post.fetchedAt || new Date().toISOString();
  getIoDatabase()
    .prepare(`
      INSERT INTO posts (
        post_id, account_id, author_username, created_at, full_text, url,
        language, media_json, mentions_json, like_count, retweet_count,
        reply_count, quote_count, view_count, conversation_id,
        in_reply_to_post_id, in_reply_to_user_id, in_reply_to_username,
        provider, source_run_id, coverage_state, candidate_sightings, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(post_id) DO UPDATE SET
        account_id = excluded.account_id,
        author_username = excluded.author_username,
        created_at = excluded.created_at,
        full_text = excluded.full_text,
        url = COALESCE(excluded.url, posts.url),
        language = COALESCE(excluded.language, posts.language),
        media_json = COALESCE(excluded.media_json, posts.media_json),
        mentions_json = COALESCE(excluded.mentions_json, posts.mentions_json),
        like_count = excluded.like_count,
        retweet_count = excluded.retweet_count,
        reply_count = excluded.reply_count,
        quote_count = excluded.quote_count,
        view_count = excluded.view_count,
        conversation_id = COALESCE(excluded.conversation_id, posts.conversation_id),
        in_reply_to_post_id = COALESCE(excluded.in_reply_to_post_id, posts.in_reply_to_post_id),
        in_reply_to_user_id = COALESCE(excluded.in_reply_to_user_id, posts.in_reply_to_user_id),
        in_reply_to_username = COALESCE(excluded.in_reply_to_username, posts.in_reply_to_username),
        provider = excluded.provider,
        source_run_id = COALESCE(excluded.source_run_id, posts.source_run_id),
        coverage_state = CASE
          WHEN posts.coverage_state = 'covered' OR excluded.coverage_state = 'covered'
          THEN 'covered' ELSE 'candidate' END,
        candidate_sightings = MAX(posts.candidate_sightings, excluded.candidate_sightings),
        fetched_at = excluded.fetched_at
    `)
    .run(
      post.postId,
      post.accountId,
      post.authorUsername,
      post.createdAt,
      post.fullText,
      post.url ?? null,
      post.language ?? null,
      post.media?.length ? JSON.stringify(post.media) : null,
      post.mentions?.length ? JSON.stringify(post.mentions) : null,
      post.likeCount ?? 0,
      post.retweetCount ?? 0,
      post.replyCount ?? 0,
      post.quoteCount ?? 0,
      post.viewCount ?? 0,
      post.conversationId ?? null,
      post.inReplyToPostId ?? null,
      post.inReplyToUserId ?? null,
      post.inReplyToUsername ?? null,
      post.provider,
      post.sourceRunId ?? null,
      post.coverageState ?? "candidate",
      post.candidateSightings ?? 1,
      now,
    );
}

export function getIoPostsForAccount(
  accountId: string,
  options: { limit?: number; query?: string; coveredOnly?: boolean } = {},
): IoPost[] {
  const limit = Math.max(1, Math.min(options.limit ?? 10_000, 50_000));
  const clauses = ["account_id = ?"];
  const params: unknown[] = [accountId];
  if (options.coveredOnly) clauses.push("coverage_state = 'covered'");
  if (options.query?.trim()) {
    clauses.push("LOWER(full_text) LIKE ?");
    params.push(`%${options.query.trim().toLowerCase()}%`);
  }
  params.push(limit);
  return getIoDatabase()
    .prepare(`
      SELECT * FROM posts
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at ASC, LENGTH(post_id) ASC, post_id ASC
      LIMIT ?
    `)
    .all(...params) as unknown as IoPost[];
}

export function countIoPostsForAccount(
  accountId: string,
  options: { coveredOnly?: boolean } = {},
): number {
  const clause = options.coveredOnly ? "AND coverage_state = 'covered'" : "";
  const row = getIoDatabase()
    .prepare(`SELECT COUNT(*) AS count FROM posts WHERE account_id = ? ${clause}`)
    .get(accountId) as { count: number } | undefined;
  return Number(row?.count ?? 0);
}

export function createIoRun(run: {
  id: string;
  username: string;
  provider?: string;
  collectionMode?: string;
  targetCount?: number | null;
  baseBoundary?: number | null;
  targetBoundary?: number | null;
  requestedStartAt?: string | null;
  outputPath?: string | null;
}): IoRun {
  const now = new Date().toISOString();
  getIoDatabase()
    .prepare(`
      INSERT INTO acquisition_runs (
        id, username, provider, collection_mode, target_count, base_boundary,
        target_boundary, requested_start_at, status,
        progress_message, output_path, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'Queued', ?, ?)
    `)
    .run(
      run.id,
      run.username.toLowerCase(),
      run.provider || "twitterapi_io",
      run.collectionMode || "oldest_n",
      run.targetCount ?? null,
      run.baseBoundary ?? null,
      run.targetBoundary ?? null,
      run.requestedStartAt ?? null,
      run.outputPath ?? null,
      now,
    );
  return getIoRun(run.id)!;
}

export function getIoRun(id: string): IoRun | null {
  const row = getIoDatabase()
    .prepare("SELECT * FROM acquisition_runs WHERE id = ?")
    .get(id) as IoRun | undefined;
  return row ?? null;
}

export function getActiveIoRun(username: string): IoRun | null {
  const row = getIoDatabase()
    .prepare(`
      SELECT * FROM acquisition_runs
      WHERE username = ? COLLATE NOCASE AND status IN ('queued','running')
      ORDER BY created_at ASC LIMIT 1
    `)
    .get(username) as IoRun | undefined;
  return row ?? null;
}

export function getLatestIoRun(username: string): IoRun | null {
  const row = getIoDatabase()
    .prepare(`
      SELECT * FROM acquisition_runs
      WHERE username = ? COLLATE NOCASE
      ORDER BY created_at DESC LIMIT 1
    `)
    .get(username) as IoRun | undefined;
  return row ?? null;
}

export function getAnyActiveIoRun(): IoRun | null {
  const row = getIoDatabase()
    .prepare(`
      SELECT * FROM acquisition_runs
      WHERE status IN ('queued','running')
      ORDER BY created_at ASC LIMIT 1
    `)
    .get() as IoRun | undefined;
  return row ?? null;
}

export function updateIoRun(
  id: string,
  fields: Partial<
    Pick<
      IoRun,
      | "account_id"
      | "status"
      | "progress_message"
      | "request_count"
      | "page_count"
      | "unique_count"
      | "candidate_count"
      | "duplicate_count"
      | "output_path"
      | "error_message"
      | "started_at"
      | "finished_at"
    >
  >,
): void {
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (!entries.length) return;
  const columns = entries.map(([key]) => `${key} = ?`).join(", ");
  getIoDatabase()
    .prepare(`UPDATE acquisition_runs SET ${columns} WHERE id = ?`)
    .run(...entries.map(([, value]) => value), id);
}

export function insertCoverageWindow(row: {
  runId: string;
  accountId: string;
  startAt: string;
  endAt: string;
  status: "complete" | "partial" | "unknown";
  resolutionBasis?: string | null;
  terminationReason?: string | null;
  requestCount?: number;
  pageCount?: number;
  uniqueCount?: number;
}): void {
  getIoDatabase()
    .prepare(`
      INSERT INTO coverage_windows (
        run_id, account_id, start_at, end_at, status, resolution_basis,
        termination_reason, request_count, page_count, unique_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, start_at, end_at) DO UPDATE SET
        status = excluded.status,
        resolution_basis = excluded.resolution_basis,
        termination_reason = excluded.termination_reason,
        request_count = excluded.request_count,
        page_count = excluded.page_count,
        unique_count = excluded.unique_count
    `)
    .run(
      row.runId,
      row.accountId,
      row.startAt,
      row.endAt,
      row.status,
      row.resolutionBasis ?? null,
      row.terminationReason ?? null,
      row.requestCount ?? 0,
      row.pageCount ?? 0,
      row.uniqueCount ?? 0,
      new Date().toISOString(),
    );
}

export function withIoTransaction<T>(callback: () => T): T {
  const db = getIoDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
