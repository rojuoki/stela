/**
 * STELA X API v2 client — server-only, minimal, observable.
 * Uses Bearer token from env. Never exposed to browser.
 *
 * ALL X API HTTP requests go through xfetch(). There is no other fetch path.
 * end_time is clamped on the URLSearchParams immediately before fetch().
 */

import { tokenPool } from "./tokenPool";

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

  const activeToken = stats.token ?? BEARER();

  while (generalAttempt <= MAX_RETRIES) {
    stats.totalCalls++;
    const label = `[X API] ${endpoint} attempt=${generalAttempt}`;

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${activeToken}` },
      });
      if (stats.token) {
        tokenPool.updateFromHeaders(activeToken, res.headers);
      }
      const remaining = res.headers.get("x-rate-limit-remaining");
      const reset = res.headers.get("x-rate-limit-reset");
      const now = Math.floor(Date.now() / 1000);
      xCallCount++;
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
      return await res.json();
    }

    const body = await res.text().catch(() => "");
    console.error(`${label} HTTP ${res.status}: ${body.slice(0, 300)}`);
    stats.errors.push({ status: res.status, body: body.slice(0, 500), endpoint });

    if (res.status === 429) {
      const resetHeader = res.headers.get("x-rate-limit-reset");
      const resetEpochSec = resetHeader
        ? parseInt(resetHeader, 10)
        : Math.floor((Date.now() + 60_000) / 1000);

      if (stats.token) tokenPool.onRateLimit(activeToken, resetEpochSec);
      stats.onRateLimit?.(resetEpochSec);

      const resumeAt = new Date(resetEpochSec * 1000).toISOString();
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
  };
  if (sortOrder) params.sort_order = sortOrder;
  if (nextToken) params.next_token = nextToken;

  const json = (await xfetch("/tweets/search/all", params, stats)) as {
    data?: XTweet[];
    meta?: { next_token?: string; result_count?: number };
  };

  return {
    tweets: json.data || [],
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
): Promise<TimelinePage> {
  const params: Record<string, string> = {
    start_time: startTime,
    end_time: endTime,
    max_results: String(Math.min(maxResults, 100)),
    "tweet.fields": "created_at,public_metrics,attachments,author_id",
    exclude: "retweets,replies",
  };
  if (paginationToken) params.pagination_token = paginationToken;

  const json = (await xfetch(`/users/${userId}/tweets`, params, stats)) as {
    data?: XTweet[];
    meta?: { next_token?: string; result_count?: number };
  };

  return {
    tweets: json.data || [],
    nextToken: json.meta?.next_token,
  };
}
