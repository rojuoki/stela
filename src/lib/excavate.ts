/**
 * STELA Excavation — Binary-search earliest algorithm.
 *
 * Primary: Full-Archive Search (/2/tweets/search/all)
 *   Single phase: binary-search end_time with start_time fixed at
 *   account_created_at to find the narrowest window [created, end) that
 *   contains exactly BINSEARCH_TARGET_MIN–MAX (51–99) tweets in one page.
 *
 *   Because max_results=100 and the target window has ≤ 99 tweets, the API
 *   returns all of them with no next_token — single-page collection, guaranteed.
 *   The result is sorted ascending; the UI shows the first 50.
 *
 *   Binary-search invariants:
 *     lo  — end_time where count([created, lo)) < BINSEARCH_TARGET_MIN
 *     hi  — end_time where count([created, hi)) ≥ 100 (or = now if unconstrained)
 *   Termination:
 *     • count ∈ [51, 99] with no next_token  → success
 *     • hi − lo < BINSEARCH_MIN_WINDOW_MS   → account has < 51 tweets total;
 *       return the last sub-51 probe's tweets (all of them)
 *     • budget exhausted                     → MAX_API_CALLS_REACHED
 *
 * Fallback: Timeline (/2/users/:id/tweets) when full-archive returns 403.
 *           Marks acquisitionMode = "fallback". Does NOT claim "earliest guaranteed."
 *
 * Checkpoint / resume:
 *   On 429 the binary-search state (lo, hi) is persisted so the search
 *   continues exactly where it left off rather than restarting from scratch.
 */

import {
  getUserByUsername,
  getUserTweetsInWindow,
  searchAllTweets,
  createStats,
  XApiStop,
  type XUser,
  type XTweet,
  type TimelinePage,
  type ApiCallStats,
} from "./xclient";
import { logger } from './logger';
import { getDb } from "./db";

// ─── Constants ─────────────────────────────────────────

/** Absolute call ceiling per excavation. */
const MAX_API_CALLS = 50;

/** Binary-search target range (inclusive). One page covers this exactly. */
const BINSEARCH_TARGET_MIN = 51;
const BINSEARCH_TARGET_MAX = 99; // documents intent; checked via !nextToken

/**
 * Smallest window the binary search will try to split further.
 * Below this threshold we accept that the account has < BINSEARCH_TARGET_MIN
 * tweets and return whatever the last probe found.
 */
const BINSEARCH_MIN_WINDOW_MS = 3_600_000; // 1 hour

/** Delay between consecutive binary-search probes. */
const BINSEARCH_INTER_REQUEST_DELAY_MS = 1300;

/** Fallback (timeline) constants. */
const FALLBACK_INITIAL_SPAN_DAYS = 30;
const FALLBACK_MAX_SPAN_DAYS = 365 * 2;

/**
 * end_time safety buffer: keep end_time at least this many ms before now.
 * 60 s covers the X API's 10 s minimum requirement plus ~50 s of clock skew.
 */
const END_TIME_SAFETY_MS = 60_000;

// ─── Types ─────────────────────────────────────────────

export type StopReason =
  | "OK_LIMIT_REACHED"
  | "ACCOUNT_HAS_LESS_THAN_LIMIT"
  | "PROTECTED_OR_SUSPENDED_OR_NOT_FOUND"
  | "RATE_LIMIT"
  | "API_ERROR"
  | "MAX_API_CALLS_REACHED";

export interface ExcavationResult {
  username: string;
  userId: string;
  createdAt: string;
  requestedLimit: number;
  fetchedCount: number;
  stopReason: StopReason;
  apiCalls: number;
  storedNewCount: number;
  errors: ApiCallStats["errors"];
  /** "full_archive" = /2/tweets/search/all; "fallback" = /2/users/:id/tweets */
  acquisitionMode: "full_archive" | "fallback";
}

/**
 * Persisted when a 429 suspends a job mid-binary-search.
 * On resume the search continues from (lo, hi) without restarting.
 */
export interface ExcavationCheckpoint {
  phase: "binsearch";
  /**
   * ISO — current lower bound for end_time.
   * Invariant: count([account_created, lo)) < BINSEARCH_TARGET_MIN.
   */
  binsearch_lo: string;
  /**
   * ISO — current upper bound for end_time.
   * Invariant: count([account_created, hi)) ≥ 100, OR hi = now (unconstrained).
   */
  binsearch_hi: string;
}

// ─── Entry point ───────────────────────────────────────

export async function excavateEarliest(
  username: string,
  limit: number = 100,
  /** Called after each API probe so the job record can show live api_calls. */
  onProgress?: (apiCalls: number) => void,
  /** Bearer token assigned by TokenPool for this excavation session. */
  token?: string,
  /** Called when a 429 is received (before the in-process wait). */
  onRateLimit?: (resetEpochSec: number) => void,
  /** Called at every safe boundary to persist checkpoint to DB. */
  saveCheckpoint?: (cp: ExcavationCheckpoint) => void,
  /** Checkpoint from a previous run; when present, resume from that point. */
  initialCheckpoint?: ExcavationCheckpoint | null,
  /** Trace ID for logging correlation */
  traceId?: string,
  /** Job ID for logging */
  jobId?: string,
): Promise<ExcavationResult> {
  const stats = createStats(token, onRateLimit);
  const effectiveLimit = Math.min(limit, 100);

  let user: XUser;
  try {
    user = await getUserByUsername(username, stats, traceId, jobId);
  } catch (e) {
    if (e instanceof XApiStop) {
      return errorResult(username, effectiveLimit, stats, e.reason as StopReason, "full_archive");
    }
    throw e;
  }

  if (user.protected) {
    return errorResult(
      username,
      effectiveLimit,
      stats,
      "PROTECTED_OR_SUSPENDED_OR_NOT_FOUND",
      "full_archive",
    );
  }

  upsertAccount(user);

  const query = `from:${user.username} -is:retweet`;
  try {
    return await excavateFullArchive(
      user,
      query,
      effectiveLimit,
      stats,
      onProgress,
      saveCheckpoint,
      initialCheckpoint,
      traceId,
      jobId,
    );
  } catch (e) {
    if (e instanceof XApiStop && e.statusCode === 403) {
      logger.warn({
        trace_id: traceId || 'unknown',
        job_id: jobId || null,
        service: 'lib',
        event: 'x_request',
        username: username,
        user_id: user.id,
        error_code: 'FULL_ARCHIVE_FORBIDDEN',
        http_status: 403,
        fallback: 'timeline',
      }, `Full-archive unavailable (403) for @${username} - switching to timeline fallback`);
      return await excavateTimeline(user, effectiveLimit, stats, onProgress, traceId, jobId);
    }
    throw e;
  }
}

// ─── Full-Archive (primary): binary-search end_time ────

async function excavateFullArchive(
  user: XUser,
  query: string,
  limit: number,
  stats: ApiCallStats,
  onProgress?: (apiCalls: number) => void,
  saveCheckpoint?: (cp: ExcavationCheckpoint) => void,
  cp?: ExcavationCheckpoint | null,
  traceId?: string,
  jobId?: string,
): Promise<ExcavationResult> {
  const accountCreated = new Date(user.created_at);
  const now = new Date(Date.now() - END_TIME_SAFETY_MS);

  // start_time is always fixed at account creation.
  const startTime = accountCreated;

  // Restore binary-search bounds from checkpoint, or initialise.
  // lo  = largest end_time we know has count < BINSEARCH_TARGET_MIN (starts at created = 0 tweets)
  // hi  = smallest end_time we know has count ≥ 100 (starts at now = unconstrained)
  let lo: Date = cp?.phase === "binsearch" ? new Date(cp.binsearch_lo) : accountCreated;
  let hi: Date = cp?.phase === "binsearch" ? new Date(cp.binsearch_hi) : now;

  logger.info({
    trace_id: traceId || 'unknown',
    job_id: jobId || null,
    service: 'lib',
    event: cp ? 'job_resumed' : 'job_started',
    username: user.username,
    user_id: user.id,
    account_created: user.created_at,
    binsearch_lo: lo.toISOString().slice(0, 10),
    binsearch_hi: hi.toISOString().slice(0, 10),
    is_resume: !!cp,
  }, `Binary search for @${user.username}${cp ? ' (resuming)' : ' (starting)'}`);

  let resultTweets: XTweet[] | null = null;
  let stopReason: StopReason = "ACCOUNT_HAS_LESS_THAN_LIMIT";

  // Tracks the most-recent sub-51-count probe's tweets so we have a fallback
  // if the binary search converges without ever finding 51–99.
  let bestFallback: XTweet[] = [];

  while (stats.totalCalls < MAX_API_CALLS) {
    // Convergence: window too narrow to subdivide — account has < 51 tweets total.
    if (hi.getTime() - lo.getTime() < BINSEARCH_MIN_WINDOW_MS) {
      logger.info({
        trace_id: traceId || 'unknown',
        job_id: jobId || null,
        service: 'lib',
        event: 'job_succeeded', // Binary search converged
        username: user.username,
        user_id: user.id,
        window_size_ms: hi.getTime() - lo.getTime(),
        min_window_threshold: BINSEARCH_MIN_WINDOW_MS,
        target_min_tweets: BINSEARCH_TARGET_MIN,
        stop_reason: 'ACCOUNT_HAS_LESS_THAN_LIMIT',
      }, `Binary search for @${user.username} converged - account has < ${BINSEARCH_TARGET_MIN} tweets`);
      resultTweets = bestFallback;
      stopReason = "ACCOUNT_HAS_LESS_THAN_LIMIT";
      break;
    }

    const midMs = Math.floor((lo.getTime() + hi.getTime()) / 2);
    const mid = new Date(midMs);

    let page: TimelinePage;
    try {
      page = await searchAllTweets(
        query,
        startTime.toISOString(),
        mid.toISOString(),
        stats,
        100,
        undefined,
        "recency",
        traceId,
        jobId,
      );
    } catch (e) {
      if (e instanceof XApiStop && e.statusCode === 403) throw e;
      if (e instanceof XApiStop) {
        // Save binary-search state before propagating so resume picks up here.
        saveCheckpoint?.({ phase: "binsearch", binsearch_lo: lo.toISOString(), binsearch_hi: hi.toISOString() });
        stopReason = e.reason as StopReason;
        return errorResult(user.username, limit, stats, stopReason, "full_archive");
      }
      throw e;
    }

    const count = page.tweets.length;
    onProgress?.(stats.totalCalls);
    logger.debug({
      trace_id: traceId || 'unknown',
      job_id: jobId || null,
      service: 'lib',
      event: 'x_request',
      username: user.username,
      user_id: user.id,
      binsearch_mid: mid.toISOString().slice(0, 10),
      tweet_count: count,
      has_next_token: !!page.nextToken,
      api_calls_total: stats.totalCalls,
    }, `Binary search probe: mid=${mid.toISOString().slice(0, 10)} count=${count}`);

    if (count >= BINSEARCH_TARGET_MIN && !page.nextToken) {
      // 51–99 tweets, no next_token → we have all of them. Success.
      logger.info({
        trace_id: traceId || 'unknown',
        job_id: jobId || null,
        service: 'lib',
        event: 'job_succeeded',
        username: user.username,
        user_id: user.id,
        end_time: mid.toISOString().slice(0, 10),
        tweet_count: count,
        acquisition_mode: 'full_archive',
      }, `Binary search success: @${user.username} end=${mid.toISOString().slice(0, 10)} count=${count}`);
      resultTweets = page.tweets;
      stopReason = "OK_LIMIT_REACHED";
      break;
    } else if (count >= 100 || page.nextToken) {
      // ≥ 100 tweets (or API signals more via next_token): too dense, shrink end_time.
      hi = mid;
    } else {
      // count < 51, no next_token: too sparse, expand end_time.
      // Save these tweets as fallback in case binary search never finds 51–99.
      if (count > bestFallback.length) bestFallback = page.tweets;
      lo = mid;
    }

    // Persist binary-search state after every probe so a 429-triggered resume
    // continues from this exact point rather than restarting from scratch.
    saveCheckpoint?.({ phase: "binsearch", binsearch_lo: lo.toISOString(), binsearch_hi: hi.toISOString() });

    await sleep(BINSEARCH_INTER_REQUEST_DELAY_MS);
  }

  if (stats.totalCalls >= MAX_API_CALLS && resultTweets === null) {
    stopReason = "MAX_API_CALLS_REACHED";
  }

  if (!resultTweets) {
    logger.warn({
      trace_id: traceId || 'unknown',
      job_id: jobId || null,
      service: 'lib',
      event: 'job_failed',
      username: user.username,
      user_id: user.id,
      stop_reason: stopReason,
      api_calls: stats.totalCalls,
      acquisition_mode: 'full_archive',
    }, `Binary search failed: @${user.username} stop_reason=${stopReason}`);
    return {
      username: user.username,
      userId: user.id,
      createdAt: user.created_at,
      requestedLimit: limit,
      fetchedCount: 0,
      stopReason,
      apiCalls: stats.totalCalls,
      storedNewCount: 0,
      errors: stats.errors,
      acquisitionMode: "full_archive",
    };
  }

  // Sort ascending (oldest first). UI takes the first 50.
  const sorted = [...resultTweets].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );

  const storedNewCount = storeTweets(user.id, sorted);

  logger.info({
    trace_id: traceId || 'unknown',
    job_id: jobId || null,
    service: 'lib',
    event: 'job_succeeded',
    username: user.username,
    user_id: user.id,
    fetched_count: sorted.length,
    stored_new_count: storedNewCount,
    api_calls: stats.totalCalls,
    acquisition_mode: 'full_archive',
    stop_reason: stopReason,
  }, `Excavation complete: @${user.username} fetched=${sorted.length} stored_new=${storedNewCount}`);

  return {
    username: user.username,
    userId: user.id,
    createdAt: user.created_at,
    requestedLimit: limit,
    fetchedCount: sorted.length,
    stopReason,
    apiCalls: stats.totalCalls,
    storedNewCount,
    errors: stats.errors,
    acquisitionMode: "full_archive",
  };
}

// ─── Fallback (timeline) ────────────────────────────────

async function excavateTimeline(
  user: XUser,
  limit: number,
  stats: ApiCallStats,
  onProgress?: (apiCalls: number) => void,
  traceId?: string,
  jobId?: string,
): Promise<ExcavationResult> {
  logger.warn({
    trace_id: traceId || 'unknown',
    job_id: jobId || null,
    service: 'lib',
    event: 'job_started',
    username: user.username,
    user_id: user.id,
    acquisition_mode: 'timeline_fallback',
    limitation: '~3200 most recent tweets only',
  }, `Timeline fallback for @${user.username} - 'earliest' not guaranteed`);

  const accountCreated = new Date(user.created_at);
  const now = new Date();
  const collected = new Map<string, XTweet>();
  let spanDays = FALLBACK_INITIAL_SPAN_DAYS;
  let windowStart = accountCreated;
  let stopReason: StopReason = "ACCOUNT_HAS_LESS_THAN_LIMIT";

  while (windowStart < now && stats.totalCalls < MAX_API_CALLS) {
    const windowEnd = minDate(addDays(windowStart, spanDays), now);

    let page: TimelinePage;
    try {
      page = await getUserTweetsInWindow(
        user.id,
        windowStart.toISOString(),
        windowEnd.toISOString(),
        stats,
        undefined, // paginationToken
        100, // maxResults
        traceId,
        jobId,
      );
    } catch (e) {
      if (e instanceof XApiStop) {
        stopReason = e.reason as StopReason;
        break;
      }
      throw e;
    }

    onProgress?.(stats.totalCalls);

    if (page.tweets.length === 0) {
      if (spanDays >= FALLBACK_MAX_SPAN_DAYS) {
        windowStart = windowEnd;
        spanDays = FALLBACK_INITIAL_SPAN_DAYS;
      } else {
        spanDays = Math.min(spanDays * 2, FALLBACK_MAX_SPAN_DAYS);
      }
      continue;
    }

    for (const t of page.tweets) collected.set(t.id, t);

    let nextToken = page.nextToken;
    while (nextToken && collected.size < limit && stats.totalCalls < MAX_API_CALLS) {
      try {
        page = await getUserTweetsInWindow(
          user.id,
          windowStart.toISOString(),
          windowEnd.toISOString(),
          stats,
          nextToken,
          100, // maxResults
          traceId,
          jobId,
        );
      } catch (e) {
        if (e instanceof XApiStop) {
          stopReason = e.reason as StopReason;
          nextToken = undefined;
          break;
        }
        throw e;
      }
      for (const t of page.tweets) collected.set(t.id, t);
      nextToken = page.nextToken;
    }

    if (collected.size >= limit) {
      stopReason = "OK_LIMIT_REACHED";
      break;
    }

    if (stats.totalCalls >= MAX_API_CALLS) {
      stopReason = "MAX_API_CALLS_REACHED";
      break;
    }

    windowStart = windowEnd;
    spanDays = FALLBACK_INITIAL_SPAN_DAYS;
  }

  if (
    stats.totalCalls >= MAX_API_CALLS &&
    stopReason === "ACCOUNT_HAS_LESS_THAN_LIMIT"
  ) {
    stopReason = "MAX_API_CALLS_REACHED";
  }

  const sorted = [...collected.values()]
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .slice(0, limit);

  const storedNewCount = storeTweets(user.id, sorted);

  logger.info({
    trace_id: traceId || 'unknown',
    job_id: jobId || null,
    service: 'lib',
    event: 'job_succeeded',
    username: user.username,
    user_id: user.id,
    fetched_count: sorted.length,
    stored_new_count: storedNewCount,
    api_calls: stats.totalCalls,
    acquisition_mode: 'timeline_fallback',
    stop_reason: stopReason,
  }, `Timeline fallback complete: @${user.username} fetched=${sorted.length} stored_new=${storedNewCount}`);

  return {
    username: user.username,
    userId: user.id,
    createdAt: user.created_at,
    requestedLimit: limit,
    fetchedCount: sorted.length,
    stopReason,
    apiCalls: stats.totalCalls,
    storedNewCount,
    errors: stats.errors,
    acquisitionMode: "fallback",
  };
}

// ─── DB helpers ─────────────────────────────────────────

function upsertAccount(user: XUser) {
  const db = getDb();
  db.prepare(`
    INSERT INTO accounts (account_id, username, display_name, avatar_url, created_at, protected, fetched_at)
    VALUES (?, ?, ?, NULL, ?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET
      username = excluded.username,
      display_name = excluded.display_name,
      created_at = excluded.created_at,
      protected = excluded.protected,
      fetched_at = excluded.fetched_at
  `).run(
    user.id,
    user.username.toLowerCase(),
    user.name,
    user.created_at,
    user.protected ? 1 : 0,
    new Date().toISOString(),
  );
}

function storeTweets(userId: string, tweets: XTweet[]): number {
  if (!tweets.length) return 0;
  const db = getDb();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO tweets (post_id, account_id, created_at, full_text, media_json, like_count, retweet_count, reply_count, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let newCount = 0;
  const tx = db.transaction(() => {
    for (const t of tweets) {
      const r = insert.run(
        t.id,
        userId,
        t.created_at,
        t.text,
        t.attachments ? JSON.stringify(t.attachments) : null,
        t.public_metrics?.like_count ?? 0,
        t.public_metrics?.retweet_count ?? 0,
        t.public_metrics?.reply_count ?? 0,
        new Date().toISOString(),
      );
      if (r.changes > 0) newCount++;
    }
  });
  tx();
  return newCount;
}

// ─── Util ───────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function addDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + days);
  return r;
}

function minDate(a: Date, b: Date): Date {
  return a < b ? a : b;
}

function errorResult(
  username: string,
  limit: number,
  stats: ApiCallStats,
  reason: StopReason,
  acquisitionMode: "full_archive" | "fallback",
): ExcavationResult {
  return {
    username,
    userId: "",
    createdAt: "",
    requestedLimit: limit,
    fetchedCount: 0,
    stopReason: reason,
    apiCalls: stats.totalCalls,
    storedNewCount: 0,
    errors: stats.errors,
    acquisitionMode,
  };
}
