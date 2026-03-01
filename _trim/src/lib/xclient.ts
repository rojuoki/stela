/**
 * STELA X API v2 client — server-only, minimal, observable.
 * Uses Bearer token from env. Never exposed to browser.
 *
 * ALL X API HTTP requests go through xfetch(). There is no other fetch path.
 * end_time is clamped on the URLSearchParams immediately before fetch().
 */

import { tokenPool } from "./tokenPool";
import { recordApiCall } from "./repository";
import { incXApiCalls, incXApi429 } from "./devStats";
import { logger, generateRequestId, getTokenFingerprint } from "./logger";

const API_BASE = process.env.X_API_BASE || "https://api.x.com/2";
const BEARER = () => {
  const t = process.env.X_BEARER_TOKEN;
  if (!t) throw new Error("X_BEARER_TOKEN is not set");
  return t;
};

/** Max retries for network errors and 5xx responses (excludes 429 — handled by queue). */
const MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 1000;

/** Total X API fetch calls since server start — debug only. */
let xCallCount = 0;

// ─── end_time safety ──────────────────────────────────

const SAFE_MARGIN_MS = 120_000;

function clampEndTime(searchParams: URLSearchParams, traceId?: string, jobId?: string): void {
  const safeNow = new Date(Date.now() - SAFE_MARGIN_MS).toISOString();

  const requested = searchParams.get("end_time");
  if (!requested) {
    searchParams.set("end_time", safeNow);
    return;
  }

  if (new Date(requested).getTime() > Date.now() - SAFE_MARGIN_MS) {
    logger.debug({
      trace_id: traceId || 'unknown',
      job_id: jobId || null,
      service: 'lib',
      event: 'x_request', // Time parameter adjustment
      requested_end_time: requested,
      clamped_end_time: safeNow,
    }, `Clamped end_time ${requested} → ${safeNow}`);
    searchParams.set("end_time", safeNow);
  }
}

// ─── Types ────────────────────────────────────────────

export interface XUser {
  id: string;
  username: string;
  name: string;
  created_at: string; // ISO 8601
  protected: boolean;
  profile_image_url?: string;
  public_metrics?: {
    followers_count: number;
    following_count: number;
    tweet_count: number;
    listed_count: number;
  };
}

export interface XMedia {
  media_key: string;
  type: "photo" | "video" | "animated_gif";
  url?: string;
  preview_image_url?: string;
  width?: number;
  height?: number;
  alt_text?: string;
}

export interface XTweet {
  id: string;
  text: string;
  created_at: string;
  author_id: string;
  public_metrics?: {
    like_count: number;
    retweet_count: number;
    reply_count: number;
    quote_count: number;
    impression_count: number;
  };
  attachments?: {
    media_keys?: string[];
  };
}

export interface ApiCallStats {
  totalCalls: number;
  errors: Array<{ status: number; body: string; endpoint: string }>;
  /** Bearer token assigned to this excavation session (overrides X_BEARER_TOKEN env). */
  token?: string;
  /** Called when a 429 is received, before the in-process wait. Arg = reset epoch (seconds). */
  onRateLimit?: (resetEpochSec: number) => void;
}

/** Create a stats object, optionally pre-bound to a token and rate-limit callback. */
export function createStats(
  token?: string,
  onRateLimit?: (resetEpochSec: number) => void,
): ApiCallStats {
  return { totalCalls: 0, errors: [], token, onRateLimit };
}

type StopSignal = "RATE_LIMIT" | "API_ERROR" | "PROTECTED_OR_SUSPENDED_OR_NOT_FOUND";

export class XApiStop extends Error {
  constructor(public reason: StopSignal, public statusCode: number, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "XApiStop";
  }
}

// ─── Telemetry helpers ─────────────────────────────────

/**
 * Normalize an X API endpoint path to a stable label for grouping in the log.
 * Strips variable segments (usernames, numeric IDs) so the log stays clean.
 */
function normalizeEndpoint(endpoint: string): string {
  if (endpoint === "/tweets/search/all") return "tweets/search/all";
  if (endpoint.startsWith("/users/by/username/")) return "users/by/username";
  if (/^\/users\/\d+\/tweets/.test(endpoint)) return "users/:id/tweets";
  // fallback: strip leading slash
  return endpoint.replace(/^\//, "");
}

// ─── Raw rate-limit header logger ─────────────────────

/**
 * Emit a single-line log of raw X API rate-limit response headers.
 * Activated by LOG_RAW_X_RATE=1 (default OFF).
 * Never logs Authorization, URLs, query params, or tokens.
 */
function logRawXRate(res: Response, traceId?: string, jobId?: string): void {
  if (!process.env.LOG_RAW_X_RATE) return;

  const limit      = res.headers.get("x-rate-limit-limit");
  const remaining  = res.headers.get("x-rate-limit-remaining");
  const resetStr   = res.headers.get("x-rate-limit-reset");
  const retryAfter = res.headers.get("retry-after");
  const dateHeader = res.headers.get("date") ?? new Date().toUTCString();

  const now         = Math.floor(Date.now() / 1000);
  const reset       = resetStr !== null ? parseInt(resetStr, 10) : null;
  const until_reset = reset !== null ? reset - now : null;

  logger.debug({
    trace_id: traceId || 'unknown',
    job_id: jobId || null,
    service: 'lib',
    event: 'x_request',
    http_status: res.status,
    rate_limit: limit ? parseInt(limit, 10) : undefined,
    rate_remaining: remaining ? parseInt(remaining, 10) : undefined,
    rate_reset: reset || undefined,
    rate_until_reset: until_reset,
    retry_after: retryAfter ? parseInt(retryAfter, 10) : undefined,
    date_header: dateHeader,
  }, `Raw X rate limit headers`);
}

// ─── Single HTTP gateway ──────────────────────────────

/**
 * All calls are strictly sequential — no Promise.all anywhere in this module.
 * Rate-limit retries (429) use a separate counter so they never consume the
 * general retry budget; the job is never failed solely because of a 429.
 */
async function xfetch(
  endpoint: string,
  params: Record<string, string>,
  stats: ApiCallStats,
  traceId?: string,
  jobId?: string,
): Promise<unknown> {
  const url = new URL(`${API_BASE}${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, v);
  }

  const requestId = generateRequestId();
  const resolvedTraceId = traceId || requestId; // Fallback to req_id
  
  // ── end_time safety gate — runs on the final URLSearchParams ──
  if (url.searchParams.has("start_time")) {
    clampEndTime(url.searchParams, resolvedTraceId, jobId);

    const st = url.searchParams.get("start_time")!;
    const et = url.searchParams.get("end_time")!;
    if (st >= et) {
      logger.info({
        trace_id: resolvedTraceId,
        job_id: jobId || null,
        service: 'lib',
        event: 'x_request',
        req_id: requestId,
        endpoint,
        start_time: st,
        end_time: et,
        skip_reason: 'start_time >= end_time',
      }, `Skipping request: start_time=${st} >= end_time=${et}`);
      return { data: [], meta: {} };
    }

    logger.debug({
      trace_id: resolvedTraceId,
      job_id: jobId || null,
      service: 'lib',
      event: 'x_request',
      req_id: requestId,
      endpoint,
      final_url: url.toString(),
    }, `Final search URL prepared`);
  }

  let generalAttempt = 0;
  let lastError: Error | null = null;

  // Prefer the per-job token, then any pool token, then the raw env var.
  // This ensures non-job callers (e.g. /api/account user lookup) use the same
  // token(s) the pool was initialised with rather than a separate env var that
  // may be unset or stale.
  const activeToken = stats.token ?? tokenPool.peekToken() ?? BEARER();

  while (generalAttempt <= MAX_RETRIES) {
    stats.totalCalls++;
    
    let res: Response;
    try {
      // Log the outgoing request
      logger.info({
        trace_id: resolvedTraceId,
        job_id: jobId || null,
        service: 'lib',
        event: 'x_request',
        req_id: requestId,
        endpoint,
        token_fp: getTokenFingerprint(activeToken),
        attempt: generalAttempt,
      }, `X API request to ${endpoint} (attempt ${generalAttempt})`);

      res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${activeToken}` },
      });
      if (stats.token) {
        tokenPool.updateFromHeaders(activeToken, res.headers);
      }
      logRawXRate(res, resolvedTraceId, jobId);
      const remaining = res.headers.get("x-rate-limit-remaining");
      const reset = res.headers.get("x-rate-limit-reset");
      const now = Math.floor(Date.now() / 1000);
      xCallCount++;
      
      // Persist telemetry — fire-and-forget, never throws
      recordApiCall(normalizeEndpoint(endpoint), false);
      incXApiCalls();
      
      const baseLogFields = {
        trace_id: resolvedTraceId,
        job_id: jobId || null,
        service: 'lib' as const,
        req_id: requestId,
        endpoint,
        token_fp: getTokenFingerprint(activeToken),
        attempt: generalAttempt,
        rate_remaining: remaining ? parseInt(remaining, 10) : undefined,
        rate_reset: reset ? parseInt(reset, 10) : undefined,
        http_status: res.status,
        x_calls_total: xCallCount,
      };

      if (res.status === 429) {
        logger.warn({
          ...baseLogFields,
          event: 'x_429',
          error_code: 'RATE_LIMIT',
          retry_after: reset ? parseInt(reset, 10) - now : undefined,
        }, `Rate limited (429) on ${endpoint}`);
      } else {
        logger.info({
          ...baseLogFields,
          event: 'x_request',
        }, `X API response ${res.status} from ${endpoint}`);
      }
    } catch (e: unknown) {
      lastError = e instanceof Error ? e : new Error(String(e));
      
      logger.error({
        trace_id: resolvedTraceId,
        job_id: jobId || null,
        service: 'lib',
        event: 'x_request',
        req_id: requestId,
        endpoint,
        token_fp: getTokenFingerprint(activeToken),
        attempt: generalAttempt,
        error_code: 'NETWORK_ERROR',
        err_name: lastError.constructor.name,
        err_message: lastError.message,
      }, `Network error on ${endpoint} attempt ${generalAttempt}`);
      
      generalAttempt++;
      if (generalAttempt <= MAX_RETRIES) {
        await sleep(BACKOFF_BASE_MS * 2 ** (generalAttempt - 1));
        continue;
      }
      throw new XApiStop("API_ERROR", 0, lastError.message);
    }

    if (res.ok) {
      return await res.json();
    }

    const body = await res.text().catch(() => "");
    
    logger.error({
      trace_id: resolvedTraceId,
      job_id: jobId || null,
      service: 'lib',
      event: 'x_request',
      req_id: requestId,
      endpoint,
      token_fp: getTokenFingerprint(activeToken),
      attempt: generalAttempt,
      http_status: res.status,
      error_code: res.status === 429 ? 'RATE_LIMIT' : 'HTTP_ERROR',
      response_body: body.slice(0, 300),
    }, `HTTP ${res.status} error from ${endpoint}`);
    
    stats.errors.push({ status: res.status, body: body.slice(0, 500), endpoint });

    if (res.status === 429) {
      incXApi429();
      const resetHeader = res.headers.get("x-rate-limit-reset");
      const resetEpochSec = resetHeader
        ? parseInt(resetHeader, 10)
        : Math.floor((Date.now() + 60_000) / 1000);

      if (stats.token) tokenPool.onRateLimit(activeToken, resetEpochSec);
      stats.onRateLimit?.(resetEpochSec);

      const resumeAt = new Date(resetEpochSec * 1000).toISOString();
      
      logger.warn({
        trace_id: resolvedTraceId,
        job_id: jobId || null,
        service: 'lib',
        event: 'x_429',
        req_id: requestId,
        endpoint,
        token_fp: getTokenFingerprint(activeToken),
        attempt: generalAttempt,
        http_status: 429,
        error_code: 'RATE_LIMIT',
        rate_reset: resetEpochSec,
        resume_at: resumeAt,
        retry_after: resetEpochSec - Math.floor(Date.now() / 1000),
      }, `429 rate limit hit - worker stopping, token cooldown until ${resumeAt}`);
      
      throw new XApiStop("RATE_LIMIT", 429, `Token reset at epoch ${resetEpochSec}`);
    }

    if (res.status === 401 || res.status === 403) {
      throw new XApiStop("API_ERROR", res.status, body.slice(0, 200));
    }

    generalAttempt++;
    if (res.status >= 500 && generalAttempt <= MAX_RETRIES) {
      await sleep(BACKOFF_BASE_MS * 2 ** (generalAttempt - 1));
      continue;
    }

    throw new XApiStop("API_ERROR", res.status, body.slice(0, 200));
  }

  throw lastError || new XApiStop("API_ERROR", 0, "exhausted retries");
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Public methods ────────────────────────────────────

export async function getUserByUsername(
  username: string,
  stats: ApiCallStats,
  traceId?: string,
  jobId?: string,
): Promise<XUser> {
  const json = (await xfetch(
    `/users/by/username/${encodeURIComponent(username)}`,
    {
      "user.fields": "created_at,protected,public_metrics,profile_image_url",
    },
    stats,
    traceId,
    jobId,
  )) as { data?: XUser; errors?: Array<{ title: string; detail: string; type: string }> };

  if (!json.data) {
    const detail = json.errors?.[0]?.detail || "User not found";
    throw new XApiStop("PROTECTED_OR_SUSPENDED_OR_NOT_FOUND", 404, detail);
  }

  return json.data;
}

export interface TimelinePage {
  tweets: XTweet[];
  media: XMedia[];
  nextToken?: string;
}

/**
 * Full-Archive Search: GET /2/tweets/search/all
 * Requires Academic/Pro access; throws XApiStop(statusCode=403) if unavailable.
 *
 * sortOrder:
 *   "recency"  — newest-first (required for reliable paginated collect).
 *   undefined  — omit the parameter; lets the API use its archive index without
 *                a recency bias, which is more reliable for old tweet detection
 *                during explore probes.
 */
export async function searchAllTweets(
  query: string,
  startTime: string,
  endTime: string,
  stats: ApiCallStats,
  maxResults: number = 10,
  nextToken?: string,
  sortOrder?: "recency" | "relevancy",
  traceId?: string,
  jobId?: string,
): Promise<TimelinePage> {
  const params: Record<string, string> = {
    query,
    start_time: startTime,
    end_time: endTime,
    max_results: String(Math.min(Math.max(maxResults, 10), 500)),
    "tweet.fields": "created_at,public_metrics,attachments,author_id",
    "media.fields": "url,preview_image_url,type,width,height,alt_text",
    expansions: "attachments.media_keys",
  };
  if (sortOrder) params.sort_order = sortOrder;
  if (nextToken) params.next_token = nextToken;

  const json = (await xfetch("/tweets/search/all", params, stats, traceId, jobId)) as {
    data?: XTweet[];
    includes?: { media?: XMedia[] };
    meta?: { next_token?: string; result_count?: number };
  };

  return {
    tweets: json.data || [],
    media: json.includes?.media || [],
    nextToken: json.meta?.next_token,
  };
}

/**
 * Fetch a page of tweets for a user within a time window.
 * Returns newest-first within the window (API default).
 */
export async function getUserTweetsInWindow(
  userId: string,
  startTime: string, // ISO 8601
  endTime: string,   // ISO 8601
  stats: ApiCallStats,
  paginationToken?: string,
  maxResults: number = 100,
  traceId?: string,
  jobId?: string,
): Promise<TimelinePage> {
  const params: Record<string, string> = {
    start_time: startTime,
    end_time: endTime,
    max_results: String(Math.min(maxResults, 100)),
    "tweet.fields": "created_at,public_metrics,attachments,author_id",
    "media.fields": "url,preview_image_url,type,width,height,alt_text",
    expansions: "attachments.media_keys",
    exclude: "retweets,replies",
  };
  if (paginationToken) params.pagination_token = paginationToken;

  const json = (await xfetch(`/users/${userId}/tweets`, params, stats, traceId, jobId)) as {
    data?: XTweet[];
    includes?: { media?: XMedia[] };
    meta?: { next_token?: string; result_count?: number };
  };

  return {
    tweets: json.data || [],
    media: json.includes?.media || [],
    nextToken: json.meta?.next_token,
  };
}
