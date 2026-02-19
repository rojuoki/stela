/**
 * STELA Excavation — Earliest-100 algorithm.
 *
 * Primary: Full-Archive Search (/2/tweets/search/all)
 *   Phase A — Explore: coarse→fine time windows (years → months) to locate the
 *             earliest region. Uses small max_results (5–10) per probe.
 *             While scanning months, counts consecutive zero-month results
 *             (zeroStreak) to detect a missing-early-period pattern.
 *   Phase B — Collect: bounded pagination from earliest region forward.
 *             Paginate within each window; sort ascending; take first 100.
 *   Phase C — Deep backfill: activated only when zeroStreak ≥ DEEP_TRIGGER_ZERO_STREAK.
 *             Re-runs the same collect code path over [accountCreated, earliestRegionStart)
 *             to recover tweets that the explore phase may have skipped.
 *             Budget: min(remaining, MAX_API_CALLS_DEEP).
 *
 * Fallback: Timeline (/2/users/:id/tweets) when full-archive returns 403.
 *           Marks acquisitionMode = "fallback". Does NOT claim "earliest guaranteed."
 *
 * Rules (all phases):
 *   - NEVER paginate newest→oldest exhaustively.
 *   - NEVER crawl full timeline.
 *   - All calls bounded by MAX_API_CALLS (or callCeiling for deep).
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
import { getDb } from "./db";

// ─── Constants ─────────────────────────────────────────

/** Absolute call ceiling per excavation (explore + collect combined). */
const MAX_API_CALLS = 50;

/**
 * Additional budget reserved for deep backfill.
 * The actual deep budget is min(remaining-after-standard, MAX_API_CALLS_DEEP).
 */
const MAX_API_CALLS_DEEP = 30;

/**
 * Minimum number of consecutive empty-month results (from the start of
 * the month scan) before a month hit triggers the deep backfill pass.
 */
const DEEP_TRIGGER_ZERO_STREAK = 4;

/** Delay between consecutive explore probes to avoid hammering the rate limit. */
const EXPLORE_INTER_REQUEST_DELAY_MS = 1300;

/** Full-archive collect: initial window width when scanning forward. */
const COLLECT_INITIAL_SPAN_DAYS = 30;
const COLLECT_MAX_SPAN_DAYS = 365 * 2;
/** Max pages to paginate within a single collect window (100/page = 500 tweets max). */
const MAX_COLLECT_PAGES_PER_WINDOW = 5;

/** Fallback (timeline) constants — same behaviour as previous implementation. */
const FALLBACK_INITIAL_SPAN_DAYS = 30;
const FALLBACK_MAX_SPAN_DAYS = 365 * 2;

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
  /** True when deep backfill was triggered (zeroStreak ≥ threshold + later month hit). */
  deepTriggered?: boolean;
  /** Number of additional unique tweets added by the deep backfill pass. */
  deepAddedCount?: number;
}

// ─── Entry point ───────────────────────────────────────

export async function excavateEarliest(
  username: string,
  limit: number = 100,
  /** Called after each API probe so the job record can show live api_calls during excavation. */
  onProgress?: (apiCalls: number) => void,
): Promise<ExcavationResult> {
  const stats = createStats();
  const effectiveLimit = Math.min(limit, 100);

  let user: XUser;
  try {
    user = await getUserByUsername(username, stats);
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

  // Attempt full-archive; fall back if the token lacks that access (403).
  const query = `from:${user.username} -is:retweet`;
  try {
    return await excavateFullArchive(user, query, effectiveLimit, stats, onProgress);
  } catch (e) {
    if (e instanceof XApiStop && e.statusCode === 403) {
      console.log(
        `[excavate] Full-archive unavailable (403) for @${username} — switching to timeline fallback`,
      );
      return await excavateTimeline(user, effectiveLimit, stats, onProgress);
    }
    throw e;
  }
}

// ─── Full-Archive (primary) ─────────────────────────────

async function excavateFullArchive(
  user: XUser,
  query: string,
  limit: number,
  stats: ApiCallStats,
  onProgress?: (apiCalls: number) => void,
): Promise<ExcavationResult> {
  const accountCreated = new Date(user.created_at);
  const now = new Date();
  const startYear = accountCreated.getUTCFullYear();
  const endYear = now.getUTCFullYear();

  console.log(
    `[explore] @${user.username} account_created=${user.created_at} query="${query}"`,
  );

  // ── Phase A: Explore — coarse (years) → fine (months) ──

  let earliestRegionStart: Date | null = null;

  // Deep-trigger state — set during month scan, used after collect.
  let deepTriggered = false;
  let earliestHitYear = -1;

  yearLoop: for (
    let year = startYear;
    year <= endYear && stats.totalCalls < MAX_API_CALLS;
    year++
  ) {
    const yearStart =
      year === startYear ? accountCreated : new Date(Date.UTC(year, 0, 1));
    const yearEnd = new Date(Date.UTC(year + 1, 0, 1));
    const yEndStr = minDate(yearEnd, now).toISOString();

    // Explore probes: omit sort_order so the API uses its full-archive index
    // without a recency bias, improving recall of very old tweets.
    let yPage: TimelinePage;
    try {
      yPage = await searchAllTweets(query, yearStart.toISOString(), yEndStr, stats, 5);
    } catch (e) {
      if (e instanceof XApiStop && e.statusCode === 403) throw e;
      if (e instanceof XApiStop) {
        return errorResult(user.username, limit, stats, e.reason as StopReason, "full_archive");
      }
      throw e;
    }

    // Detect based on the OLDEST tweet in the response, not the newest.
    const yOldest = oldestInPage(yPage.tweets);
    console.log(
      `[explore] year=${year} window=[${yearStart.toISOString().slice(0, 10)}, ${yEndStr.slice(0, 10)}] found=${yPage.tweets.length} oldest=${yOldest?.created_at.slice(0, 10) ?? "none"}`,
    );

    onProgress?.(stats.totalCalls);
    await sleep(EXPLORE_INTER_REQUEST_DELAY_MS);

    if (!yOldest) continue;

    // Year has tweets — narrow to earliest month within it.
    earliestHitYear = year;
    const monthFrom = year === startYear ? accountCreated.getUTCMonth() : 0;

    // zeroStreak: consecutive empty months from the start of this month scan.
    // A streak ≥ DEEP_TRIGGER_ZERO_STREAK followed by a hit means we may have
    // missed an early period (e.g. YouTube: Jan–Jul empty, Aug has tweets).
    let zeroStreak = 0;

    for (
      let m = monthFrom;
      m < 12 && stats.totalCalls < MAX_API_CALLS;
      m++
    ) {
      const mStart = new Date(Date.UTC(year, m, 1));
      const mEnd = new Date(Date.UTC(year, m + 1, 1));
      if (mStart >= now) break;

      let mPage: TimelinePage;
      try {
        // No sort_order — same rationale as year probe.
        mPage = await searchAllTweets(
          query,
          mStart.toISOString(),
          minDate(mEnd, now).toISOString(),
          stats,
          5,
        );
      } catch (e) {
        if (e instanceof XApiStop && e.statusCode === 403) throw e;
        if (e instanceof XApiStop) {
          return errorResult(user.username, limit, stats, e.reason as StopReason, "full_archive");
        }
        throw e;
      }

      // Detect based on the OLDEST tweet in the response.
      const mOldest = oldestInPage(mPage.tweets);
      console.log(
        `[explore] month=${year}-${String(m + 1).padStart(2, "0")} window=[${mStart.toISOString().slice(0, 10)}, ${minDate(mEnd, now).toISOString().slice(0, 10)}] found=${mPage.tweets.length} oldest=${mOldest?.created_at.slice(0, 10) ?? "none"}`,
      );

      onProgress?.(stats.totalCalls);
      await sleep(EXPLORE_INTER_REQUEST_DELAY_MS);

      if (!mOldest) {
        // Empty month — extend the streak; existing explore logic unchanged.
        zeroStreak++;
      } else {
        // Found tweets in this month.
        // Check for missing-early-months pattern before setting the region.
        if (zeroStreak >= DEEP_TRIGGER_ZERO_STREAK) {
          deepTriggered = true;
          console.log(
            `[deep] trigger: year=${year} zeroStreak=${zeroStreak} firstHitMonth=${m + 1} reason=MISSING_EARLY_MONTHS`,
          );
        }
        earliestRegionStart = mStart;
        break yearLoop;
      }
    }

    // Month scan exhausted but year had tweets (unlikely API inconsistency).
    // Use year start as a safe collect origin so we don't miss anything.
    if (!earliestRegionStart) {
      earliestRegionStart = yearStart;
      console.log(
        `[explore] month scan yielded nothing despite year hit — using year start ${yearStart.toISOString().slice(0, 10)} as region`,
      );
      break;
    }
  }

  if (!earliestRegionStart) {
    const reason: StopReason =
      stats.totalCalls >= MAX_API_CALLS
        ? "MAX_API_CALLS_REACHED"
        : "ACCOUNT_HAS_LESS_THAN_LIMIT";
    console.log(`[explore] @${user.username} no tweets found — stopReason=${reason}`);
    return {
      username: user.username,
      userId: user.id,
      createdAt: user.created_at,
      requestedLimit: limit,
      fetchedCount: 0,
      stopReason: reason,
      apiCalls: stats.totalCalls,
      storedNewCount: 0,
      errors: stats.errors,
      acquisitionMode: "full_archive",
      deepTriggered: false,
    };
  }

  console.log(
    `[explore] @${user.username} earliest region: ${earliestRegionStart.toISOString().slice(0, 10)} (${stats.totalCalls} calls so far)`,
  );

  // ── Phase B: Collect from earliest region forward ──

  const collected = new Map<string, XTweet>();

  const standardStop = await collectWindowPass(
    query,
    earliestRegionStart,
    now,
    stats,
    collected,
    MAX_API_CALLS,  // budget ceiling (global)
    limit,          // stop once we have enough for normal result
    user.username,
    onProgress,
  );
  let stopReason: StopReason = standardStop;

  // ── Phase C: Deep backfill (missing early period) ──
  //
  // Runs the same collect code path over [accountCreated, earliestRegionStart) to
  // recover tweets the explore phase may have skipped due to API index gaps.
  // Budget: min(remaining calls, MAX_API_CALLS_DEEP) — never exceeds global cap.

  let deepAddedCount = 0;

  if (deepTriggered && earliestHitYear > 0) {
    // Deep range starts at account_created_at — never at year boundary —
    // so accounts created mid-year (e.g. YouTube: 2007-11-13) are fully covered.
    // Optionally clamped to X full-archive floor (2006-03-21) but NOT moved later
    // than accountCreated, so the range is always [accountCreated, earliestRegionStart).
    const X_ARCHIVE_FLOOR = new Date("2006-03-21T00:00:00Z");
    const deepStart = maxDate(X_ARCHIVE_FLOOR, accountCreated);
    const deepEnd = earliestRegionStart; // exclusive upper bound
    const remainingBudget = MAX_API_CALLS - stats.totalCalls;
    const deepCallBudget = Math.min(remainingBudget, MAX_API_CALLS_DEEP);

    if (deepCallBudget > 0 && deepEnd > deepStart) {
      const deepCallCeiling = stats.totalCalls + deepCallBudget;
      const sizeBefore = collected.size;

      console.log(
        `[deep] backfill range=[${deepStart.toISOString().slice(0, 10)}, ${deepEnd.toISOString().slice(0, 10)}) account_created=${accountCreated.toISOString().slice(0, 10)} budget=${deepCallBudget}`,
      );

      const deepStop = await collectWindowPass(
        query,
        deepStart,
        deepEnd,
        stats,
        collected,
        deepCallCeiling,
        Number.MAX_SAFE_INTEGER, // no count limit — merge + sort happens after
        user.username,
        onProgress,
      );

      deepAddedCount = collected.size - sizeBefore;
      console.log(
        `[deep] backfill done: added=${deepAddedCount} stop=${deepStop} totalCalls=${stats.totalCalls}`,
      );

      if (deepStop === "MAX_API_CALLS_REACHED" && stopReason !== "OK_LIMIT_REACHED") {
        stopReason = "MAX_API_CALLS_REACHED";
      }
    } else {
      console.log(
        `[deep] backfill skipped: budget=${deepCallBudget} range_valid=${deepEnd > deepStart}`,
      );
    }
  }

  if (stats.totalCalls >= MAX_API_CALLS && stopReason === "ACCOUNT_HAS_LESS_THAN_LIMIT") {
    stopReason = "MAX_API_CALLS_REACHED";
  }

  // Merge all phases: sort ascending, take earliest `limit`.
  const sorted = [...collected.values()]
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .slice(0, limit);

  const storedNewCount = storeTweets(user.id, sorted);

  console.log(
    `[excavate] @${user.username} done: fetched=${sorted.length} stored_new=${storedNewCount} api_calls=${stats.totalCalls} mode=full_archive stop=${stopReason}${deepTriggered ? ` deep_added=${deepAddedCount}` : ""}`,
  );

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
    deepTriggered,
    deepAddedCount: deepTriggered ? deepAddedCount : undefined,
  };
}

// ─── Shared collect pass ────────────────────────────────

/**
 * Runs one bounded collect pass over [start, end).
 * Paginates windows forward with recency sort, accumulates into `collected`.
 * Stops when: stats.totalCalls ≥ callCeiling, collected.size ≥ collectLimit,
 *             or collectStart ≥ end.
 * Used by both Phase B (standard) and Phase C (deep backfill).
 */
async function collectWindowPass(
  query: string,
  start: Date,
  end: Date,
  stats: ApiCallStats,
  collected: Map<string, XTweet>,
  callCeiling: number,
  collectLimit: number,
  username: string,
  onProgress?: (apiCalls: number) => void,
): Promise<StopReason> {
  let collectStart = start;
  let collectSpanDays = COLLECT_INITIAL_SPAN_DAYS;
  let stopReason: StopReason = "ACCOUNT_HAS_LESS_THAN_LIMIT";

  while (
    collected.size < collectLimit &&
    stats.totalCalls < callCeiling &&
    collectStart < end
  ) {
    const collectEnd = minDate(addDays(collectStart, collectSpanDays), end);

    console.log(
      `[collect] @${username} window=[${collectStart.toISOString().slice(0, 10)}, ${collectEnd.toISOString().slice(0, 10)}] have=${collected.size}`,
    );

    let page: TimelinePage;
    try {
      // Collect phase: use recency sort for consistent newest-first pagination.
      page = await searchAllTweets(
        query,
        collectStart.toISOString(),
        collectEnd.toISOString(),
        stats,
        100,
        undefined,
        "recency",
      );
    } catch (e) {
      if (e instanceof XApiStop && e.statusCode === 403) throw e;
      if (e instanceof XApiStop) {
        stopReason = e.reason as StopReason;
        break;
      }
      throw e;
    }

    // Paginate within window (bounded: MAX_COLLECT_PAGES_PER_WINDOW pages).
    // search/all returns newest-first; we gather all, then sort ascending later.
    const windowTweets: XTweet[] = [...page.tweets];
    let nextToken = page.nextToken;
    let pagesInWindow = 1;

    while (
      nextToken &&
      stats.totalCalls < callCeiling &&
      pagesInWindow < MAX_COLLECT_PAGES_PER_WINDOW
    ) {
      let nextPage: TimelinePage;
      try {
        nextPage = await searchAllTweets(
          query,
          collectStart.toISOString(),
          collectEnd.toISOString(),
          stats,
          100,
          nextToken,
          "recency",
        );
      } catch (e) {
        if (e instanceof XApiStop && e.statusCode === 403) throw e;
        if (e instanceof XApiStop) {
          stopReason = e.reason as StopReason;
          nextToken = undefined;
          break;
        }
        throw e;
      }
      windowTweets.push(...nextPage.tweets);
      nextToken = nextPage.nextToken;
      pagesInWindow++;
    }

    const exhausted = !nextToken;
    console.log(
      `[collect] window yielded ${windowTweets.length} tweets (${pagesInWindow} pages, ${exhausted ? "exhausted" : "page-limit hit"})`,
    );

    onProgress?.(stats.totalCalls);
    for (const t of windowTweets) collected.set(t.id, t);

    if (collected.size >= collectLimit) {
      stopReason = "OK_LIMIT_REACHED";
      break;
    }

    if (stats.totalCalls >= callCeiling) {
      stopReason = "MAX_API_CALLS_REACHED";
      break;
    }

    // Advance window; double span for sparse periods.
    collectStart = collectEnd;
    collectSpanDays = Math.min(collectSpanDays * 2, COLLECT_MAX_SPAN_DAYS);
  }

  if (stats.totalCalls >= callCeiling && stopReason === "ACCOUNT_HAS_LESS_THAN_LIMIT") {
    stopReason = "MAX_API_CALLS_REACHED";
  }

  return stopReason;
}

// ─── Fallback (timeline) ────────────────────────────────

async function excavateTimeline(
  user: XUser,
  limit: number,
  stats: ApiCallStats,
  onProgress?: (apiCalls: number) => void,
): Promise<ExcavationResult> {
  console.log(
    `[excavate] @${user.username} timeline fallback — note: limited to ~3200 most recent tweets; 'earliest' is not guaranteed`,
  );

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

  console.log(
    `[excavate] @${user.username} done (fallback): fetched=${sorted.length} stored_new=${storedNewCount} api_calls=${stats.totalCalls} stop=${stopReason}`,
  );

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

/**
 * Returns the chronologically oldest tweet in an array, or undefined if empty.
 * Used by explore probes so detection is based on the earliest timestamp in the
 * response rather than the newest (which sort_order=recency would surface first).
 */
function oldestInPage(tweets: XTweet[]): XTweet | undefined {
  if (!tweets.length) return undefined;
  return tweets.reduce((oldest, t) =>
    new Date(t.created_at) < new Date(oldest.created_at) ? t : oldest,
  );
}

function addDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + days);
  return r;
}

function minDate(a: Date, b: Date): Date {
  return a < b ? a : b;
}

function maxDate(a: Date, b: Date): Date {
  return a > b ? a : b;
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
