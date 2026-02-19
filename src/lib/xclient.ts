/**
 * STELA X API v2 client — server-only, minimal, observable.
 * Uses Bearer token from env. Never exposed to browser.
 */

const API_BASE = process.env.X_API_BASE || "https://api.x.com/2";
const BEARER = () => {
  const t = process.env.X_BEARER_TOKEN;
  if (!t) throw new Error("X_BEARER_TOKEN is not set");
  return t;
};

/** Max retries for network errors and 5xx responses. */
const MAX_RETRIES = 2;
/** Max waits for 429 rate-limit responses (independent of MAX_RETRIES). */
const MAX_RATE_LIMIT_RETRIES = 3;
const BACKOFF_BASE_MS = 1000;
/** Extra buffer added on top of x-rate-limit-reset to avoid races. */
const RATE_LIMIT_RESET_BUFFER_MS = 2000;

/** Total X API fetch calls since server start — debug only. */
let xCallCount = 0;

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
}

/** Shared call counter — create per-excavation */
export function createStats(): ApiCallStats {
  return { totalCalls: 0, errors: [] };
}

type StopSignal = "RATE_LIMIT" | "API_ERROR" | "PROTECTED_OR_SUSPENDED_OR_NOT_FOUND";

export class XApiStop extends Error {
  constructor(public reason: StopSignal, public statusCode: number, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "XApiStop";
  }
}

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

  let generalAttempt = 0;   // counts network-error / 5xx retries
  let rateLimitAttempts = 0; // counts 429 waits (independent)
  let lastError: Error | null = null;

  while (generalAttempt <= MAX_RETRIES) {
    stats.totalCalls++;
    const label = `[X API] ${endpoint} attempt=${generalAttempt} rl=${rateLimitAttempts}`;
    console.log(`${label} → ${url.toString()}`);

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${BEARER()}` },
      });
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

    // 429 — wait until reset (+ buffer) then continue the same phase.
    // Rate-limit retries are tracked separately; a 429 never fails the job by itself.
    if (res.status === 429) {
      rateLimitAttempts++;
      if (rateLimitAttempts > MAX_RATE_LIMIT_RETRIES) {
        throw new XApiStop("RATE_LIMIT", 429, "Rate limited after max retries");
      }
      const resetHeader = res.headers.get("x-rate-limit-reset");
      let waitMs: number;
      if (resetHeader) {
        const resetAt = parseInt(resetHeader, 10) * 1000;
        waitMs = Math.max(0, resetAt - Date.now()) + RATE_LIMIT_RESET_BUFFER_MS;
        waitMs = Math.min(waitMs, 15 * 60 * 1000); // cap at 15 min
        console.warn(
          `${label} 429 — waiting ${Math.ceil(waitMs / 1000)}s (x-rate-limit-reset + buffer), ` +
          `retry ${rateLimitAttempts}/${MAX_RATE_LIMIT_RETRIES}`,
        );
      } else {
        waitMs = 5000 + Math.random() * 5000; // 5–10 s
        console.warn(
          `${label} 429 — no reset header, waiting ${Math.ceil(waitMs / 1000)}s, ` +
          `retry ${rateLimitAttempts}/${MAX_RATE_LIMIT_RETRIES}`,
        );
      }
      await sleep(waitMs);
      // Do NOT increment generalAttempt — rate-limit waits are not error retries.
      continue;
    }

    // 401/403 → stop immediately
    if (res.status === 401 || res.status === 403) {
      throw new XApiStop("API_ERROR", res.status, body.slice(0, 200));
    }

    // 5xx → retry with backoff
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
