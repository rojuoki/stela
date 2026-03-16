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
import { promises as fs } from "fs";
import path from "path";

const API_BASE = process.env.X_API_BASE || "https://api.x.com/2";
const BEARER = () => {
  const t = process.env.X_BEARER_TOKEN;
  if (!t) throw new Error("X_BEARER_TOKEN is not set");
  return t;
};

/** Max retries for network errors and 5xx responses (excludes 429 — handled by queue). */
const MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 1000;

/** Inter-request delay to maintain rate limit spacing (matches EXPLORE_INTER_REQUEST_DELAY_MS). */
const INTER_REQUEST_DELAY_MS = 1300;

/** Total X API fetch calls since server start — debug only. */
let xCallCount = 0;

/** Track last tweets/search/all call timestamp for rate limit spacing. */
let lastSearchAllTimestamp = 0;

// ─── end_time safety ──────────────────────────────────

const SAFE_MARGIN_MS = 120_000;

function clampEndTime(searchParams: URLSearchParams): void {
  const safeNow = new Date(Date.now() - SAFE_MARGIN_MS).toISOString();

  const requested = searchParams.get("end_time");
  if (!requested) {
    searchParams.set("end_time", safeNow);
    return;
  }

  if (new Date(requested).getTime() > Date.now() - SAFE_MARGIN_MS) {
    console.log(`[clamp] end_time ${requested} → ${safeNow}`);
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
  url?: string; // photo URLs
  preview_image_url?: string; // video/gif preview
  width?: number;
  height?: number;
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
  /** Job ID for token switching (optional). */
  jobId?: string;
  /** Track token switch attempts to prevent infinite loops. */
  tokenSwitchAttempts?: number;
}

/** Create a stats object, optionally pre-bound to a token and rate-limit callback. */
export function createStats(
  token?: string,
  onRateLimit?: (resetEpochSec: number) => void,
  jobId?: string,
): ApiCallStats {
  return { totalCalls: 0, errors: [], token, onRateLimit, jobId, tokenSwitchAttempts: 0 };
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

// ─── Debug response logger ────────────────────────────

/**
 * Mask sensitive headers for debug logging.
 * Never logs Authorization, API keys, cookies, or other credentials.
 */
function maskHeaders(headers: Headers): Record<string, string> {
  const masked: Record<string, string> = {};
  const sensitiveHeaders = [
    'authorization',
    'x-api-key', 
    'cookie',
    'set-cookie',
    'x-bearer-token'
  ];
  
  for (const [key, value] of headers.entries()) {
    const lowerKey = key.toLowerCase();
    if (sensitiveHeaders.includes(lowerKey)) {
      masked[key] = '[MASKED]';
    } else {
      masked[key] = value;
    }
  }
  
  return masked;
}

/**
 * Extract relevant body information based on status code.
 * 200: meta fields only, 429+: full body for error analysis.
 */
function extractBodyInfo(status: number, body: any): any {
  if (status === 200) {
    // For success responses, only extract meta information
    return {
      meta: body?.meta || null,
      data_count: Array.isArray(body?.data) ? body.data.length : 0,
      includes_count: body?.includes ? Object.keys(body.includes).length : 0
    };
  } else {
    // For error responses, include full body for diagnosis
    return body;
  }
}

/**
 * Save debug response to ndjson file when DEBUG_X_API=1.
 * Fire-and-forget async operation, never throws.
 */
async function saveDebugResponse(
  endpoint: string,
  status: number,
  headers: Headers,
  body: any,
  jobId?: string,
  activeToken?: string
): Promise<void> {
  if (!process.env.DEBUG_X_API) return;
  
  try {
    const logDir = process.env.DEBUG_X_API_LOG_DIR || './logs';
    await fs.mkdir(logDir, { recursive: true });
    
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const logFile = path.join(logDir, `x-api-debug-${today}.ndjson`);
    
    const logEntry = {
      timestamp: new Date().toISOString(),
      endpoint: endpoint.replace(/^\//, ''), // strip leading slash
      status,
      job_id: jobId || null,
      token_index: activeToken ? tokenPool.getTokenIndex(activeToken) : null,
      headers: maskHeaders(headers),
      rate_limit_headers: {
        limit: headers.get('x-rate-limit-limit'),
        remaining: headers.get('x-rate-limit-remaining'),
        reset: headers.get('x-rate-limit-reset'),
        retry_after: headers.get('retry-after')
      },
      body: extractBodyInfo(status, body)
    };
    
    const line = JSON.stringify(logEntry) + '\n';
    await fs.appendFile(logFile, line);
    
  } catch (error) {
    // Silent failure - debug logging should never crash the main flow
    console.error('[debug-log] Failed to save debug response:', error);
  }
}

// ─── Raw rate-limit header logger ─────────────────────</thinking>

/**
 * Emit a single-line log of raw X API rate-limit response headers.
 * Activated by LOG_RAW_X_RATE=1 (default OFF).
 * Never logs Authorization, URLs, query params, or tokens.
 */
function logRawXRate(res: Response): void {
  if (!process.env.LOG_RAW_X_RATE) return;

  const limit      = res.headers.get("x-rate-limit-limit");
  const remaining  = res.headers.get("x-rate-limit-remaining");
  const resetStr   = res.headers.get("x-rate-limit-reset");
  const retryAfter = res.headers.get("retry-after");
  const dateHeader = res.headers.get("date") ?? new Date().toUTCString();

  const now         = Math.floor(Date.now() / 1000);
  const reset       = resetStr !== null ? parseInt(resetStr, 10) : null;
  const until_reset = reset !== null ? reset - now : null;

  console.log(
    `[RAW_X_RATE] status=${res.status}` +
    ` limit=${limit ?? "null"}` +
    ` remaining=${remaining ?? "null"}` +
    ` reset=${reset ?? "null"}` +
    ` now=${now}` +
    ` until_reset=${until_reset ?? "null"}` +
    ` retry_after=${retryAfter ?? "null"}` +
    ` date=${dateHeader}`,
  );
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
): Promise<unknown> {
  const url = new URL(`${API_BASE}${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, v);
  }

  // ── end_time safety gate — runs on the final URLSearchParams ──
  if (url.searchParams.has("start_time")) {
    clampEndTime(url.searchParams);

    const st = url.searchParams.get("start_time")!;
    const et = url.searchParams.get("end_time")!;
    if (st >= et) {
      console.log(`[xfetch][skip] start_time=${st} >= end_time=${et} — returning empty`);
      return { data: [], meta: {} };
    }

    console.log(`FINAL_SEARCH_URL ${url.toString()}`);
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
    const label = `[X API] ${endpoint} attempt=${generalAttempt}`;

    let res: Response;
    try {
      // ── Rate limit spacing for tweets/search/all ──────────────────────────
      if (endpoint === "/tweets/search/all") {
        const now = Date.now();
        const timeSinceLastCall = now - lastSearchAllTimestamp;
        
        if (timeSinceLastCall < INTER_REQUEST_DELAY_MS) {
          const waitTime = INTER_REQUEST_DELAY_MS - timeSinceLastCall;
          console.log(`[rate-limit] tweets/search/all spacing: waiting ${waitTime}ms (last call ${timeSinceLastCall}ms ago)`);
          await sleep(waitTime);
        }
        
        lastSearchAllTimestamp = Date.now();
      }

      res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${activeToken}` },
      });
      if (stats.token) {
        tokenPool.updateFromHeaders(activeToken, res.headers);
      }
      logRawXRate(res);

      // [xrl] specialized log for /2/tweets/search/all - tracking token-specific rate limits
      if (endpoint === "/tweets/search/all") {
        const limit = res.headers.get("x-rate-limit-limit");
        const remaining = res.headers.get("x-rate-limit-remaining");
        const resetEpoch = res.headers.get("x-rate-limit-reset");
        const tokenIndex = tokenPool.getTokenIndex(activeToken);
        const at = new Date().toISOString();
        
        console.log(
          `[xrl] job=${stats.jobId ?? "null"} tok=t${tokenIndex} ep=tweets/search/all ` +
          `at=${at} status=${res.status} ` +
          `x-rate-limit-limit=${limit ?? "null"} ` +
          `x-rate-limit-remaining=${remaining ?? "null"} ` +
          `x-rate-limit-reset=${resetEpoch ?? "null"}`
        );
      }

      const remaining = res.headers.get("x-rate-limit-remaining");
      const reset = res.headers.get("x-rate-limit-reset");
      const now = Math.floor(Date.now() / 1000);
      xCallCount++;
      // Persist telemetry — fire-and-forget, never throws
      recordApiCall(normalizeEndpoint(endpoint), false);
      incXApiCalls();
      console.log(`[rate] remaining=${remaining} reset=${reset} now=${now} x_calls=${xCallCount}`);
      if (res.status === 429) {
        console.log(`[rate][429] remaining=${remaining} reset=${reset} now=${now} x_calls=${xCallCount}`);
      }
    } catch (e: unknown) {
      lastError = e instanceof Error ? e : new Error(String(e));
      console.error(`${label} network error: ${lastError.message}`);
      generalAttempt++;
      if (generalAttempt <= MAX_RETRIES) {
        await sleep(BACKOFF_BASE_MS * 2 ** (generalAttempt - 1));
        continue;
      }
      throw new XApiStop("API_ERROR", 0, lastError.message);
    }

    if (res.ok) {
      const responseBody = await res.json();
      
      // Debug logging for successful responses
      saveDebugResponse(endpoint, res.status, res.headers, responseBody, stats.jobId, activeToken);
      
      return responseBody;
    }

    const body = await res.text().catch(() => "");
    console.error(`${label} HTTP ${res.status}: ${body.slice(0, 300)}`);
    stats.errors.push({ status: res.status, body: body.slice(0, 500), endpoint });

    // Debug logging for error responses (429, 4xx, 5xx)
    let bodyForDebug: any;
    try {
      bodyForDebug = JSON.parse(body);
    } catch {
      bodyForDebug = body; // Keep as string if not valid JSON
    }
    saveDebugResponse(endpoint, res.status, res.headers, bodyForDebug, stats.jobId, activeToken);

    if (res.status === 429) {
      incXApi429();
      const resetHeader = res.headers.get("x-rate-limit-reset");
      const resetEpochSec = resetHeader
        ? parseInt(resetHeader, 10)
        : Math.floor((Date.now() + 60_000) / 1000);

      if (stats.token) tokenPool.onRateLimit(activeToken, resetEpochSec);
      stats.onRateLimit?.(resetEpochSec);

      const resumeAt = new Date(resetEpochSec * 1000).toISOString();
      
      // 🚀 MAGIC TOKEN SWITCH: Try alternative token before giving up
      const maxTokenSwitches = 2; // Prevent infinite loops
      const switchAttempts = stats.tokenSwitchAttempts || 0;
      
      if (switchAttempts < maxTokenSwitches && stats.jobId) {
        console.log(`[token-switch] 429 detected, trying alternative token (attempt ${switchAttempts + 1}/${maxTokenSwitches})...`);
        
        // Release current failed token
        if (stats.token) {
          tokenPool.releaseToken(stats.token);
        }
        
        // Check if token switching is strategically viable
        if (!tokenPool.canSwitchToken(activeToken)) {
          // Debug: show token states to understand why switching is blocked
          const diagnostic = tokenPool.getDiagnosticInfo();
          console.log(`[token-switch] STRATEGIC BLOCK: canSwitchToken() prevents switching from token[${tokenPool.getTokenIndex(activeToken)}]`);
          console.log(`[token-switch] DEBUG: ${diagnostic.map(d => `t${d.index}=${d.assigned ? 'ASSIGNED' : 'FREE'}${d.hardCooldownUntil ? `(cool:${d.hardCooldownUntil.slice(11, 19)})` : ''}`).join(' ')}`);
        } else {
          // Try emergency token acquisition using the SAME jobId (unified job ID strategy)
          // This prevents orphaned tokens by keeping all tokens under one job tracking
          const alternativeToken = tokenPool.acquireEmergencyToken(stats.jobId!, activeToken);
          
          if (alternativeToken && alternativeToken !== activeToken) {
            const altTokenIdx = tokenPool.getTokenIndex(alternativeToken);
            console.log(`[token-switch] SUCCESS! Switching to token[${altTokenIdx}] for job ${stats.jobId} (unified jobId)`);
            
            // Update stats with new token
            stats.token = alternativeToken;
            stats.tokenSwitchAttempts = switchAttempts + 1;
            
            // Wait before retry with new token to maintain rate limit spacing
            console.log(`[token-switch] Waiting ${INTER_REQUEST_DELAY_MS}ms before retry with new token`);
            await sleep(INTER_REQUEST_DELAY_MS);
            return xfetch(endpoint, params, stats);
          } else {
            console.log(`[token-switch] FAILED: No alternative token available (current: ...${activeToken.slice(-6)})`);
          }
        }
      } else if (switchAttempts >= maxTokenSwitches) {
        console.log(`[token-switch] EXHAUSTED: Already tried ${switchAttempts} token switches, giving up`);
      } else {
        console.log(`[token-switch] SKIP: No jobId provided for token switching`);
      }

      // Fallback to original behavior: fail with 429
      console.warn(
        `${label} 429 — worker stopping. Token cooldown until ${resumeAt}. ` +
          `Job will be re-queued by scheduler after reset.`,
      );
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
): Promise<XUser> {
  const json = (await xfetch(
    `/users/by/username/${encodeURIComponent(username)}`,
    {
      "user.fields": "created_at,protected,public_metrics",
    },
    stats,
  )) as { data?: XUser; errors?: Array<{ title: string; detail: string; type: string }> };

  if (!json.data) {
    const detail = json.errors?.[0]?.detail || "User not found";
    throw new XApiStop("PROTECTED_OR_SUSPENDED_OR_NOT_FOUND", 404, detail);
  }

  return json.data;
}

export interface TimelinePage {
  tweets: XTweet[];
  nextToken?: string;
  media?: XMedia[]; // expanded media objects
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
): Promise<TimelinePage> {
  const params: Record<string, string> = {
    query,
    start_time: startTime,
    end_time: endTime,
    max_results: String(Math.min(Math.max(maxResults, 10), 500)),
    "tweet.fields": "created_at,public_metrics,attachments,author_id",
    "expansions": "attachments.media_keys",
    "media.fields": "type,url,preview_image_url,media_key,width,height",
  };
  if (sortOrder) params.sort_order = sortOrder;
  if (nextToken) params.next_token = nextToken;

  const json = (await xfetch("/tweets/search/all", params, stats)) as {
    data?: XTweet[];
    meta?: { next_token?: string; result_count?: number };
    includes?: { media?: XMedia[] };
  };

  return {
    tweets: json.data || [],
    nextToken: json.meta?.next_token,
    media: json.includes?.media || [],
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
): Promise<TimelinePage> {
  const params: Record<string, string> = {
    start_time: startTime,
    end_time: endTime,
    max_results: String(Math.min(maxResults, 100)),
    "tweet.fields": "created_at,public_metrics,attachments,author_id",
    "expansions": "attachments.media_keys",
    "media.fields": "type,url,preview_image_url,media_key,width,height",
    exclude: "retweets,replies",
  };
  if (paginationToken) params.pagination_token = paginationToken;

  const json = (await xfetch(`/users/${userId}/tweets`, params, stats)) as {
    data?: XTweet[];
    meta?: { next_token?: string; result_count?: number };
    includes?: { media?: XMedia[] };
  };

  return {
    tweets: json.data || [],
    nextToken: json.meta?.next_token,
    media: json.includes?.media || [],
  };
}
