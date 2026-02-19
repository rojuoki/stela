/**
 * STELA Excavation — Earliest-100 algorithm.
 *
 * Strategy: time-window jump toward oldest side.
 * 1. Resolve user → get created_at
 * 2. Start window at [created_at, created_at + span]
 * 3. If zero tweets, double span (coarse search)
 * 4. Once tweets found, paginate within window, then advance window
 * 5. Accumulate until limit (100) or exhausted
 *
 * NEVER paginates newest→oldest across full timeline.
 */

import {
  getUserByUsername,
  getUserTweetsInWindow,
  createStats,
  XApiStop,
  type XUser,
  type XTweet,
  type ApiCallStats,
} from "./xclient";
import { getDb } from "./db";

// Hard bounds
const MAX_API_CALLS = 50; // absolute ceiling per excavation
const INITIAL_SPAN_DAYS = 30;
const MAX_SPAN_DAYS = 365 * 2; // 2 years max single window

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
}

export async function excavateEarliest(
  username: string,
  limit: number = 100,
): Promise<ExcavationResult> {
  const stats = createStats();
  const effectiveLimit = Math.min(limit, 100);

  let user: XUser;
  try {
    user = await getUserByUsername(username, stats);
  } catch (e) {
    if (e instanceof XApiStop) {
      return errorResult(username, effectiveLimit, stats, e.reason);
    }
    throw e;
  }

  // Check protected
  if (user.protected) {
    return errorResult(username, effectiveLimit, stats, "PROTECTED_OR_SUSPENDED_OR_NOT_FOUND");
  }

  // Upsert account
  upsertAccount(user);

  // ── Time-window jump algorithm ──
  const accountCreated = new Date(user.created_at);
  const now = new Date();
  const collected = new Map<string, XTweet>(); // dedupe by id
  let spanDays = INITIAL_SPAN_DAYS;
  let windowStart = accountCreated;
  let stopReason: StopReason = "ACCOUNT_HAS_LESS_THAN_LIMIT";

  // Phase A: coarse search — find the first window that has tweets
  while (windowStart < now && stats.totalCalls < MAX_API_CALLS) {
    const windowEnd = minDate(addDays(windowStart, spanDays), now);

    let page;
    try {
      page = await getUserTweetsInWindow(
        user.id,
        windowStart.toISOString(),
        windowEnd.toISOString(),
        stats,
      );
    } catch (e) {
      if (e instanceof XApiStop) {
        stopReason = e.reason as StopReason;
        break;
      }
      throw e;
    }

    if (page.tweets.length === 0) {
      // No tweets in this window → expand
      if (spanDays >= MAX_SPAN_DAYS) {
        // Jump window forward instead of expanding further
        windowStart = windowEnd;
        spanDays = INITIAL_SPAN_DAYS;
      } else {
        spanDays = Math.min(spanDays * 2, MAX_SPAN_DAYS);
      }
      continue;
    }

    // Found tweets! Add them.
    for (const t of page.tweets) collected.set(t.id, t);

    // Paginate within this window
    let nextToken = page.nextToken;
    while (nextToken && collected.size < effectiveLimit && stats.totalCalls < MAX_API_CALLS) {
      try {
        page = await getUserTweetsInWindow(
          user.id,
          windowStart.toISOString(),
          windowEnd.toISOString(),
          stats,
          nextToken,
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

    if (collected.size >= effectiveLimit) {
      stopReason = "OK_LIMIT_REACHED";
      break;
    }

    if (stats.totalCalls >= MAX_API_CALLS) {
      stopReason = "MAX_API_CALLS_REACHED";
      break;
    }

    // Advance window forward (shrink span back for fine-grained collection)
    windowStart = windowEnd;
    spanDays = INITIAL_SPAN_DAYS;
  }

  if (stats.totalCalls >= MAX_API_CALLS && stopReason === "ACCOUNT_HAS_LESS_THAN_LIMIT") {
    stopReason = "MAX_API_CALLS_REACHED";
  }

  // Sort collected by created_at ascending, take earliest `limit`
  const sorted = [...collected.values()]
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .slice(0, effectiveLimit);

  // Store
  const storedNewCount = storeTweets(user.id, sorted);

  return {
    username: user.username,
    userId: user.id,
    createdAt: user.created_at,
    requestedLimit: effectiveLimit,
    fetchedCount: sorted.length,
    stopReason,
    apiCalls: stats.totalCalls,
    storedNewCount,
    errors: stats.errors,
  };
}

// ─── DB helpers ────────────────────────────────────────

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

// ─── Util ──────────────────────────────────────────────

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
  };
}
