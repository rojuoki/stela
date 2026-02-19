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

const MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 1000;

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

async function xfetch(
  endpoint: string,
  params: Record<string, string>,
  stats: ApiCallStats,
): Promise<unknown> {
  const url = new URL(`${API_BASE}${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, v);
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    stats.totalCalls++;
    const label = `[X API] ${endpoint} attempt=${attempt}`;
    console.log(`${label} → ${url.toString()}`);

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${BEARER()}` },
      });
    } catch (e: unknown) {
      lastError = e instanceof Error ? e : new Error(String(e));
      console.error(`${label} network error: ${lastError.message}`);
      if (attempt < MAX_RETRIES) {
        await sleep(BACKOFF_BASE_MS * 2 ** attempt);
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

    // 429 → stop immediately, no retry
    if (res.status === 429) {
      throw new XApiStop("RATE_LIMIT", 429, "Rate limited");
    }

    // 401/403 → stop
    if (res.status === 401 || res.status === 403) {
      throw new XApiStop("API_ERROR", res.status, body.slice(0, 200));
    }

    // 5xx → retry with backoff
    if (res.status >= 500 && attempt < MAX_RETRIES) {
      await sleep(BACKOFF_BASE_MS * 2 ** attempt);
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
