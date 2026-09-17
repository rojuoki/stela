/**
 * STELA Bulk Excavation — Dev-only variant of excavate.ts.
 *
 * Behavioural differences from excavateEarliest:
 *   1. Dense windows are paginated directly. Only a window that is still
 *      paginated at the 20-page ceiling is split; the split point is estimated
 *      from the oldest timestamp observed in its cursor pages.
 *   2. BLAST_DENSE_THRESHOLD = 100 — windows are widened until they yield 100+
 *      tweets (same 7 → 30 → 120 → endOfYear steps as normal, just triggered
 *      at a higher threshold).
 *   3. BLAST_MAX_PAGES_PER_WINDOW = 20 — deeper per-window pagination (vs 5).
 *   4. No 100-tweet clip on effectiveLimit — `limit` is used as-is so callers
 *      can request 1 000+ tweets.
 *
 * Everything else (explore phase, checkpoint/resume, 429 suspend, stagnation
 * detection, wholeCollectFromProbe) is identical to excavate.ts.
 *
 * NEVER import this file from production code paths.
 * All callers must guard with NEXT_PUBLIC_DEV_PANEL === "1".
 */

import {
  getUserByUsername,
  searchAllTweets,
  createStats,
  XApiStop,
  type XUser,
  type XTweet,
  type XMedia,
  type TimelinePage,
  type ApiCallStats,
} from "./xclient";
import { pgQuery } from "./db";
import {
  type ExcavationResult,
  type ExcavationCheckpoint,
  type StopReason,
} from "./excavate";

// ─── Blast constants ──────────────────────────────────────────────────────────

/** Same as excavate.ts — not increased; dense accounts hit 1000 within 50 calls. */
const MAX_API_CALLS = 50;

/** Expand window until a single probe yields this many tweets. */
const BLAST_DENSE_THRESHOLD = 100;

/** Max pages to paginate within one collect window (vs 5 in excavate.ts). */
const BLAST_MAX_PAGES_PER_WINDOW = 20;

const EXPLORE_INTER_REQUEST_DELAY_MS = 1300;
const COLLECT_INITIAL_SPAN_DAYS = 7;
/** Keep a minimum temporal width on either child of a density split. */
const MIN_SPLIT_WINDOW_MS = 60_000;
/** Bias the oldest child below the cursor-observed page budget. */
const DENSITY_SPLIT_SAFETY_FACTOR = 0.6;
const STEP_30_DAYS = 30;
const STEP_120_DAYS = 120;
const MIN_COLLECT_SPAN_DAYS = 7;
const STAGNATION_THRESHOLD = 2;
const END_TIME_SAFETY_MS = 60_000;
const DEEP_TRIGGER_ZERO_STREAK = 4; // logging compat only

// ─── Private types ────────────────────────────────────────────────────────────

interface CollectCheckpointOpts {
  userId: string;
  resumeFrom?: Date | null;
  initialSpanDays?: number;
  initialStagnationCount?: number;
  initialLastWindowKey?: string | null;
  resumeCheckpoint?: ExcavationCheckpoint;
  saveWindowCheckpoint?: (
    nextWindowStart: Date,
    nextSpanDays: number,
    collectedIds: string[],
    stag: { count: number; lastWindowKey: string | null },
    splitQueue?: BulkSplitWindow[],
  ) => void;
  storedNewTarget?: number;
}

interface BulkSplitWindow {
  start: string;
  end: string;
  spanDays: number;
}

export type BulkSplitMethod = "density" | "half";

export interface BulkSplitPoint {
  point: Date;
  method: BulkSplitMethod;
}

// ─── Utility functions (identical copies from excavate.ts) ────────────────────

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

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

/**
 * Choose a split point without making another API request.
 *
 * A capped newest-first cursor tells us how much time it traversed from the
 * window end back to the oldest returned post.  Size the older child to 60% of
 * that observed range; if the timestamps are unusable, fall back to a balanced
 * split.  Both children retain at least one minute whenever the parent permits
 * it, which avoids zero-width or timestamp-boundary loops.
 */
export function chooseBulkSplitPoint(
  start: Date,
  end: Date,
  oldestObserved?: Date,
): BulkSplitPoint | null {
  const startMs = start.getTime();
  const endMs = end.getTime();
  const widthMs = endMs - startMs;
  if (widthMs < 2) return null;

  const childMarginMs = Math.min(
    MIN_SPLIT_WINDOW_MS,
    Math.max(1, Math.floor(widthMs / 4)),
  );
  const lowerBound = startMs + childMarginMs;
  const upperBound = endMs - childMarginMs;
  if (lowerBound >= upperBound) return null;

  if (oldestObserved) {
    const oldestMs = oldestObserved.getTime();
    const observedSpanMs = endMs - oldestMs;
    if (oldestMs > startMs && oldestMs < endMs && observedSpanMs > 0) {
      const estimatedMs = startMs + Math.floor(
        observedSpanMs * DENSITY_SPLIT_SAFETY_FACTOR,
      );
      if (estimatedMs > lowerBound && estimatedMs < upperBound) {
        return { point: new Date(estimatedMs), method: "density" };
      }
    }
  }

  const midpointMs = startMs + Math.floor(widthMs / 2);
  if (midpointMs <= lowerBound || midpointMs >= upperBound) return null;
  return { point: new Date(midpointMs), method: "half" };
}

function makeWindowKey(start: Date, end: Date): string {
  return `${start.toISOString()}-${end.toISOString()}`;
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
    accountId: "",
    createdAt: "",
    requestedLimit: limit,
    fetchedCount: 0,
    stopReason: reason,
    apiCalls: stats.totalCalls,
    storedNewCount: 0,
    errors: stats.errors,
    acquisitionMode,
    timelineExhausted: true,
    presentHorizonSweepComplete: false,
    deepTriggered: false,
  };
}

// ─── DB helpers (identical copies from excavate.ts) ───────────────────────────

async function upsertAccount(user: XUser) {
  await pgQuery(
    `INSERT INTO accounts (account_id, username, display_name, avatar_url, created_at, protected, fetched_at)
     VALUES ($1, $2, $3, NULL, $4, $5, $6)
     ON CONFLICT(account_id) DO UPDATE SET
       username = excluded.username,
       display_name = excluded.display_name,
       created_at = excluded.created_at,
       protected = excluded.protected,
       fetched_at = excluded.fetched_at`,
    [
      user.id,
      user.username.toLowerCase(),
      user.name,
      user.created_at,
      user.protected,
      new Date().toISOString(),
    ],
  );
}

function createMediaJson(tweet: XTweet, mediaObjects: XMedia[]): string | null {
  if (!tweet.attachments?.media_keys || !mediaObjects.length) return null;
  const tweetMedia: Array<{
    type: string;
    url?: string;
    preview_image_url?: string;
    media_url_https?: string;
    width?: number;
    height?: number;
  }> = [];
  for (const mediaKey of tweet.attachments.media_keys) {
    const mediaObj = mediaObjects.find((m) => m.media_key === mediaKey);
    if (mediaObj) {
      tweetMedia.push({
        type: mediaObj.type,
        url: mediaObj.url,
        preview_image_url: mediaObj.preview_image_url,
        media_url_https: mediaObj.url || mediaObj.preview_image_url,
        width: mediaObj.width,
        height: mediaObj.height,
      });
    }
  }
  return tweetMedia.length > 0 ? JSON.stringify(tweetMedia) : null;
}

async function storeTweets(
  userId: string,
  tweets: XTweet[],
  mediaObjects: XMedia[] = [],
): Promise<number> {
  if (!tweets.length) return 0;
  let newCount = 0;
  for (const t of tweets) {
    const mediaJson = createMediaJson(t, mediaObjects);
    try {
      const result = await pgQuery(
        `INSERT INTO tweets (post_id, account_id, created_at, full_text, media_json, like_count, retweet_count, reply_count, fetched_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (post_id) DO NOTHING`,
        [
          t.id,
          userId,
          t.created_at,
          t.text,
          mediaJson,
          t.public_metrics?.like_count ?? 0,
          t.public_metrics?.retweet_count ?? 0,
          t.public_metrics?.reply_count ?? 0,
          new Date().toISOString(),
        ],
      );
      if (result.rowCount && result.rowCount > 0) newCount++;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("duplicate key")
      ) {
        // already exists — skip
      } else {
        throw error;
      }
    }
  }
  return newCount;
}

async function loadTweetsFromDbByIds(
  accountId: string,
  ids: string[],
): Promise<XTweet[]> {
  if (!ids.length) return [];
  const placeholders = ids.map((_, i) => `$${i + 2}`).join(",");
  const result = await pgQuery(
    `SELECT post_id as id, created_at, full_text as text
     FROM tweets WHERE account_id = $1 AND post_id IN (${placeholders})`,
    [accountId, ...ids],
  );
  return result.rows.map((row: any) => ({
    id: row.id,
    created_at: row.created_at,
    text: row.text,
    author_id: accountId,
    public_metrics: { like_count: 0, retweet_count: 0, reply_count: 0, quote_count: 0, impression_count: 0 },
  }));
}

// ─── WholeCollect (identical to excavate.ts) ──────────────────────────────────

class WholeCollectPaginationAbort extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WholeCollectPaginationAbort";
  }
}

async function wholeCollectFromProbe(
  query: string,
  start: Date,
  end: Date,
  stats: ApiCallStats,
  collected: Map<string, XTweet>,
  callCeiling: number,
  username: string,
  probeResponse: TimelinePage,
  onProgress?: (apiCalls: number) => void,
  userId?: string,
): Promise<{ uniqueNew: number; storedNew: number }> {
  if (stats.totalCalls >= callCeiling) {
    return { uniqueNew: 0, storedNew: 0 };
  }

  console.log(
    `[bulk-whole-collect] @${username} window=[${start.toISOString().slice(0, 10)}, ${end.toISOString().slice(0, 10)}] found=${probeResponse.tweets.length} reusing_probe_as_page1`,
  );

  const sizeBefore = collected.size;
  let storedNew = 0;

  if (probeResponse.tweets.length > 0) {
    if (userId) {
      storedNew += await storeTweets(userId, probeResponse.tweets, probeResponse.media);
    }
    for (const tweet of probeResponse.tweets) {
      collected.set(tweet.id, tweet);
    }
  }

  const nextToken = probeResponse.nextToken;

  // Abort to normal collect flow if pagination detected
  if (nextToken) {
    for (const tweet of probeResponse.tweets) {
      collected.delete(tweet.id);
    }
    throw new WholeCollectPaginationAbort(
      `[bulk-whole-collect] pagination detected after page 1, aborting to collect flow`,
    );
  }

  const uniqueNew = collected.size - sizeBefore;
  return { uniqueNew, storedNew };
}

// ─── Blast collect pass (20-page pagination, split only when capped) ─────────

async function collectWindowPassBulk(
  query: string,
  start: Date,
  end: Date,
  stats: ApiCallStats,
  collected: Map<string, XTweet>,
  callCeiling: number,
  collectLimit: number,
  username: string,
  onProgress?: (apiCalls: number) => void,
  checkpointOpts?: CollectCheckpointOpts,
): Promise<{
  stopReason: StopReason;
  storedNewCount: number;
  timelineExhausted: boolean;
  presentHorizonSweepComplete: boolean;
}> {
  let normalWindowStart = checkpointOpts?.resumeFrom ?? start;
  let normalWindowSpan = checkpointOpts?.initialSpanDays ?? COLLECT_INITIAL_SPAN_DAYS;
  const splitQueue: BulkSplitWindow[] = [];
  for (const entry of checkpointOpts?.resumeCheckpoint?.split_window_queue ?? []) {
    const childStart = new Date(entry.start);
    const childEnd = new Date(entry.end);
    if (
      Number.isFinite(childStart.getTime()) &&
      Number.isFinite(childEnd.getTime()) &&
      childStart < childEnd &&
      Number.isFinite(entry.spanDays) &&
      entry.spanDays > 0
    ) {
      splitQueue.push({
        start: childStart.toISOString(),
        end: childEnd.toISOString(),
        spanDays: entry.spanDays,
      });
    }
  }

  let stopReason: StopReason = "ACCOUNT_HAS_LESS_THAN_LIMIT";
  let storedNewAccumulated = 0;

  const useStoredNewStop = checkpointOpts?.storedNewTarget != null;
  const targetReached = () =>
    useStoredNewStop
      ? storedNewAccumulated >= checkpointOpts!.storedNewTarget!
      : collected.size >= collectLimit;

  let stagnationCount = checkpointOpts?.initialStagnationCount ?? 0;
  let lastWindowKey: string | null = checkpointOpts?.initialLastWindowKey ?? null;

  const persistBoundary = () =>
    checkpointOpts?.saveWindowCheckpoint?.(
      normalWindowStart,
      normalWindowSpan,
      [...collected.keys()],
      { count: stagnationCount, lastWindowKey },
      splitQueue,
    );

  if (
    checkpointOpts?.resumeFrom &&
    (stagnationCount > 0 || lastWindowKey)
  ) {
    console.log(
      `[bulk-collect] resuming stagnation state: count=${stagnationCount} lastKey=${lastWindowKey?.slice(0, 20)}...`,
    );
    if (stagnationCount >= STAGNATION_THRESHOLD) {
      normalWindowStart = addDays(normalWindowStart, -normalWindowSpan);
      stagnationCount = 0;
      lastWindowKey = null;
    }
  }

  if (normalWindowStart >= end && splitQueue.length === 0) {
    return {
      stopReason: "ACCOUNT_HAS_LESS_THAN_LIMIT",
      storedNewCount: 0,
      timelineExhausted: true,
      presentHorizonSweepComplete: true,
    };
  }

  while (
    !targetReached() &&
    stats.totalCalls < callCeiling &&
    (splitQueue.length > 0 || normalWindowStart < end)
  ) {
    const pendingChild = splitQueue[0];
    const isSplitChild = pendingChild !== undefined;
    const currentWindowStart = isSplitChild
      ? new Date(pendingChild.start)
      : normalWindowStart;
    const currentWindowEnd = isSplitChild
      ? new Date(pendingChild.end)
      : minDate(addDays(normalWindowStart, normalWindowSpan), end);
    const currentSpanDays = isSplitChild
      ? pendingChild.spanDays
      : normalWindowSpan;

    console.log(
      `[bulk-collect] @${username} ${isSplitChild ? "split-child" : "window"}=[${currentWindowStart.toISOString().slice(0, 10)}, ${currentWindowEnd.toISOString().slice(0, 10)}] spanDays=${currentSpanDays}`,
    );

    const windowTweets: XTweet[] = [];
    const windowMedia: XMedia[] = [];
    let nextToken: string | undefined;
    let pagesInWindow = 0;
    let page: TimelinePage;
    try {
      page = await searchAllTweets(
        query,
        currentWindowStart.toISOString(),
        currentWindowEnd.toISOString(),
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

    // Keep a window in memory until it is known to be resolved. A saturated
    // parent is diagnostic-only and must not leak into the DB or candidates.
    windowTweets.push(...page.tweets);
    windowMedia.push(...(page.media ?? []));
    nextToken = page.nextToken;
    pagesInWindow = 1;
    if (nextToken) await sleep(EXPLORE_INTER_REQUEST_DELAY_MS);

    // Paginate within window (up to BLAST_MAX_PAGES_PER_WINDOW)
    while (
      nextToken &&
      stats.totalCalls < callCeiling &&
      pagesInWindow < BLAST_MAX_PAGES_PER_WINDOW
    ) {
      let nextPage: TimelinePage;
      try {
        nextPage = await searchAllTweets(
          query,
          currentWindowStart.toISOString(),
          currentWindowEnd.toISOString(),
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
      windowMedia.push(...(nextPage.media ?? []));
      nextToken = nextPage.nextToken;
      pagesInWindow++;

      if (nextToken) await sleep(EXPLORE_INTER_REQUEST_DELAY_MS);
    }

    if (stopReason && stopReason !== "ACCOUNT_HAS_LESS_THAN_LIMIT") break;

    if (nextToken && stats.totalCalls >= callCeiling) {
      stopReason = "MAX_API_CALLS_REACHED";
      break;
    }

    const exhausted = !nextToken;
    if (!exhausted) {
      const oldestObserved = oldestInPage(windowTweets);
      const split = chooseBulkSplitPoint(
        currentWindowStart,
        currentWindowEnd,
        oldestObserved ? new Date(oldestObserved.created_at) : undefined,
      );
      if (!split) {
        const detail =
          `cannot split saturated window ${currentWindowStart.toISOString()}..` +
          currentWindowEnd.toISOString();
        stats.errors.push({ status: 0, body: detail, endpoint: "bulk-collect" });
        console.error(`[bulk-collect][split] ${detail}`);
        stopReason = "API_ERROR";
        break;
      }

      const older: BulkSplitWindow = {
        start: currentWindowStart.toISOString(),
        end: split.point.toISOString(),
        spanDays: Math.max(
          1,
          Math.ceil(
            (split.point.getTime() - currentWindowStart.getTime()) /
              (24 * 60 * 60 * 1000),
          ),
        ),
      };
      const newer: BulkSplitWindow = {
        start: split.point.toISOString(),
        end: currentWindowEnd.toISOString(),
        spanDays: Math.max(
          1,
          Math.ceil(
            (currentWindowEnd.getTime() - split.point.getTime()) /
              (24 * 60 * 60 * 1000),
          ),
        ),
      };

      if (isSplitChild) {
        splitQueue.splice(0, 1, older, newer);
      } else {
        // Child windows take priority over the next normal window.  Advancing
        // this pointer now makes the queued split durable across a restart.
        normalWindowStart = currentWindowEnd;
        normalWindowSpan = currentSpanDays;
        splitQueue.push(older, newer);
      }

      console.log(
        `[bulk-collect][split] ${split.method} parent=[${currentWindowStart.toISOString().slice(0, 10)}, ${currentWindowEnd.toISOString().slice(0, 10)}] pages=${pagesInWindow} oldest=${oldestObserved?.created_at ?? "unknown"} -> [${older.start.slice(0, 10)}, ${older.end.slice(0, 10)}] + [${newer.start.slice(0, 10)}, ${newer.end.slice(0, 10)}]; discarding ${windowTweets.length} parent tweets`,
      );
      onProgress?.(stats.totalCalls);
      persistBoundary();
      continue;
    }

    console.log(
      `[bulk-collect] window yielded ${windowTweets.length} tweets (${pagesInWindow} pages, ${exhausted ? "exhausted" : "page-limit hit"})`,
    );

    const sizeBeforeWindow = collected.size;
    onProgress?.(stats.totalCalls);

    const sortedTweets = windowTweets.sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
    for (const t of sortedTweets) {
      if (!collected.has(t.id)) collected.set(t.id, t);
    }
    const uniqueNew = collected.size - sizeBeforeWindow;

    if (windowTweets.length > 0) {
      console.log(
        `[bulk-collect][boundary] window=[${currentWindowStart.toISOString().slice(0, 10)}, ${currentWindowEnd.toISOString().slice(0, 10)}] tweets=${windowTweets.length} uniqueNew=${uniqueNew}`,
      );
    }

    if (checkpointOpts?.userId && sortedTweets.length > 0) {
      storedNewAccumulated += await storeTweets(
        checkpointOpts.userId,
        sortedTweets,
        windowMedia,
      );
    }

    // A split child has fully resolved here (a capped child continued above
    // after replacing itself with smaller children). It must not influence the
    // normal 7 → 30 → 120 → end-of-year expansion schedule.
    if (isSplitChild) {
      splitQueue.shift();
      persistBoundary();

      if (targetReached()) {
        stopReason = "OK_LIMIT_REACHED";
        break;
      }
      if (stats.totalCalls >= callCeiling) {
        stopReason = "MAX_API_CALLS_REACHED";
        break;
      }
      continue;
    }

    // ── Blast window-size adaptation ─────────────────────────────────────────
    // Dense = uniqueNew >= 100 (vs 10 in normal mode). Once we hit 100+,
    // keep the current span (pagination already handled above).
    const dense = uniqueNew >= BLAST_DENSE_THRESHOLD;

    const currentWindowYear = currentWindowStart.getUTCFullYear();
    const endOfYear = new Date(
      Date.UTC(currentWindowYear, 11, 31, 23, 59, 59, 999),
    );

    let nextSpanDays: number;
    let adaptAction: string;

    if (dense) {
      nextSpanDays = currentSpanDays;
      adaptAction = "keep_dense";
    } else if (currentSpanDays === MIN_COLLECT_SPAN_DAYS) {
      nextSpanDays = STEP_30_DAYS;
      adaptAction = "step_to_30";
    } else if (currentSpanDays === STEP_30_DAYS) {
      if (uniqueNew >= BLAST_DENSE_THRESHOLD) {
        nextSpanDays = STEP_30_DAYS;
        adaptAction = "keep_30";
      } else {
        nextSpanDays = STEP_120_DAYS;
        adaptAction = "step_to_120";
      }
    } else if (currentSpanDays === STEP_120_DAYS) {
      if (uniqueNew >= BLAST_DENSE_THRESHOLD) {
        nextSpanDays = STEP_120_DAYS;
        adaptAction = "keep_120";
      } else {
        const daysToEndOfYear = Math.ceil(
          (endOfYear.getTime() - currentWindowStart.getTime()) /
            (24 * 60 * 60 * 1000),
        );
        nextSpanDays = Math.max(daysToEndOfYear, MIN_COLLECT_SPAN_DAYS);
        adaptAction = "step_to_end_of_year";
      }
    } else {
      nextSpanDays = MIN_COLLECT_SPAN_DAYS;
      adaptAction = "reset_to_7";
    }

    console.log(
      `[bulk-collect][adapt] spanDays=${currentSpanDays} uniqueNew=${uniqueNew} dense=${dense} pages=${pagesInWindow} exhausted=${exhausted} action=${adaptAction} nextSpanDays=${nextSpanDays}`,
    );

    // ── Stagnation detection ──────────────────────────────────────────────────
    const windowKey = makeWindowKey(currentWindowStart, currentWindowEnd);
    if (windowKey === lastWindowKey && uniqueNew === 0) {
      stagnationCount++;
    } else if (uniqueNew > 0) {
      stagnationCount = 0;
      lastWindowKey = windowKey;
    } else {
      stagnationCount = uniqueNew === 0 ? 1 : 0;
      lastWindowKey = windowKey;
    }

    if (stagnationCount >= STAGNATION_THRESHOLD) {
      console.log(
        `[bulk-collect][stagnation] detected → shift window (count=${stagnationCount})`,
      );
      normalWindowStart = addDays(normalWindowStart, -normalWindowSpan);
      stagnationCount = 0;
      lastWindowKey = null;
      persistBoundary();
      continue;
    }

    normalWindowStart = currentWindowEnd;
    normalWindowSpan = nextSpanDays;

    persistBoundary();

    if (targetReached()) {
      stopReason = "OK_LIMIT_REACHED";
      break;
    }
    if (stats.totalCalls >= callCeiling) {
      stopReason = "MAX_API_CALLS_REACHED";
      break;
    }
  }

  if (
    stats.totalCalls >= callCeiling &&
    stopReason === "ACCOUNT_HAS_LESS_THAN_LIMIT"
  ) {
    stopReason = "MAX_API_CALLS_REACHED";
  }

  const atHorizon = normalWindowStart >= end && splitQueue.length === 0;
  const timelineExhausted =
    stopReason === "ACCOUNT_HAS_LESS_THAN_LIMIT" && atHorizon;
  const presentHorizonSweepComplete =
    atHorizon &&
    (stopReason === "ACCOUNT_HAS_LESS_THAN_LIMIT" ||
      stopReason === "OK_LIMIT_REACHED");

  return {
    stopReason,
    storedNewCount: storedNewAccumulated,
    timelineExhausted:
      stopReason === "MAX_API_CALLS_REACHED" ? false : timelineExhausted,
    presentHorizonSweepComplete:
      stopReason === "MAX_API_CALLS_REACHED"
        ? false
        : presentHorizonSweepComplete,
  };
}

// ─── Bulk full-archive excavation ─────────────────────────────────────────────
// Explore phase is identical to excavate.ts. Collect phase uses collectWindowPassBulk.

async function excavateFullArchiveBulk(
  user: XUser,
  query: string,
  limit: number,
  stats: ApiCallStats,
  onProgress?: (apiCalls: number) => void,
  saveCheckpoint?: (cp: ExcavationCheckpoint) => void,
  cp?: ExcavationCheckpoint | null,
  continuationStartTime?: string,
  missingCount?: number,
): Promise<ExcavationResult> {
  const startTime = continuationStartTime
    ? new Date(continuationStartTime)
    : new Date(user.created_at);
  const now = new Date(Date.now() - END_TIME_SAFETY_MS);
  const startYear = startTime.getUTCFullYear();
  const endYear = now.getUTCFullYear();

  console.log(
    `[bulk-explore] @${user.username} start_time=${startTime.toISOString()} query="${query}"${continuationStartTime ? " (continuation)" : ""}${cp ? ` (resuming phase=${cp.phase})` : ""}`,
  );

  const allowDeep: boolean = cp?.allow_deep ?? startTime.getUTCFullYear() <= 2018;

  let earliestRegionStart: Date | null = null;
  let deepTriggered: boolean = cp?.deep_triggered ?? false;
  let earliestHitYear: number = cp?.earliest_hit_year ?? -1;

  const collected = new Map<string, XTweet>();
  let totalStoredNew = 0;

  interface CollectedRange { start: Date; end: Date }
  const wholeCollectedRanges: CollectedRange[] = [];
  const isRangeFullyCollected = (start: Date, end: Date): boolean =>
    wholeCollectedRanges.some((r) => start >= r.start && end <= r.end);

  // ── Restore from collect-phase checkpoint ──────────────────────────────────
  if (cp?.phase === "collect" && cp.earliest_region_start) {
    earliestRegionStart = new Date(cp.earliest_region_start);
    deepTriggered = cp.deep_triggered;
    earliestHitYear = cp.earliest_hit_year;

    if (cp.collected_ids && cp.collected_ids.length > 0) {
      const restored = await loadTweetsFromDbByIds(user.id, cp.collected_ids);
      for (const t of restored) collected.set(t.id, t);
      console.log(
        `[bulk-checkpoint] Restored ${collected.size} tweets for @${user.username}`,
      );
    }
  } else {
    // ── Phase A: Explore ────────────────────────────────────────────────────

    const resumeFromYear =
      cp?.phase === "explore_year" ? cp.next_year : startYear;
    const skipYearProbeFor =
      cp?.phase === "explore_month" ? cp.month_scan_year : undefined;

    yearLoop: for (
      let year = resumeFromYear;
      year <= endYear && stats.totalCalls < MAX_API_CALLS;
      year++
    ) {
      const yearStart =
        year === startYear ? startTime : new Date(Date.UTC(year, 0, 1));
      const yearEnd = new Date(Date.UTC(year + 1, 0, 1));
      const yEndStr = minDate(yearEnd, now).toISOString();

      if (isRangeFullyCollected(yearStart, minDate(yearEnd, now))) {
        console.log(
          `[bulk-explore] year=${year} → skipping (already whole-collected)`,
        );
        continue;
      }

      if (year !== skipYearProbeFor) {
        let yPage: TimelinePage;
        try {
          yPage = await searchAllTweets(query, yearStart.toISOString(), yEndStr, stats, 10);
        } catch (e) {
          if (e instanceof XApiStop && e.statusCode === 403) throw e;
          if (e instanceof XApiStop) {
            return errorResult(user.username, limit, stats, e.reason as StopReason, "full_archive");
          }
          throw e;
        }

        const yOldest = oldestInPage(yPage.tweets);
        console.log(
          `[bulk-explore] year=${year} found=${yPage.tweets.length} oldest=${yOldest?.created_at.slice(0, 10) ?? "none"}`,
        );
        onProgress?.(stats.totalCalls);

        if (!yOldest) {
          saveCheckpoint?.({
            phase: "explore_year",
            next_year: year + 1,
            earliest_hit_year: -1,
            zero_streak: 0,
            deep_triggered: false,
            allow_deep: allowDeep,
            earliest_region_start: null,
            collect_window_start: null,
            collect_span_days: COLLECT_INITIAL_SPAN_DAYS,
          });
          await sleep(EXPLORE_INTER_REQUEST_DELAY_MS);
          continue;
        }

        earliestHitYear = year;

        const yearTweetCount = yPage.tweets.length;
        if (yearTweetCount >= 1 && yearTweetCount <= 9) {
          console.log(
            `[bulk-explore] year probe found=${yearTweetCount} → whole-collect`,
          );
          const wholeCollectEnd = minDate(yearEnd, now);
          try {
            const wcResult = await wholeCollectFromProbe(
              query, yearStart, wholeCollectEnd, stats, collected,
              MAX_API_CALLS, user.username, yPage, onProgress, user.id,
            );
            totalStoredNew += wcResult.storedNew;
            wholeCollectedRanges.push({ start: yearStart, end: wholeCollectEnd });
          } catch (e) {
            if (e instanceof WholeCollectPaginationAbort) {
              earliestRegionStart = yearStart;
              saveCheckpoint?.({
                phase: "collect",
                next_year: year,
                month_scan_year: year,
                next_month: 0,
                earliest_hit_year: year,
                zero_streak: 0,
                deep_triggered: deepTriggered,
                allow_deep: allowDeep,
                earliest_region_start: earliestRegionStart.toISOString(),
                collect_window_start: earliestRegionStart.toISOString(),
                collect_span_days: COLLECT_INITIAL_SPAN_DAYS,
                collected_ids: [...collected.keys()],
              });
              await sleep(EXPLORE_INTER_REQUEST_DELAY_MS);
              break yearLoop;
            } else { throw e; }
          }
          saveCheckpoint?.({
            phase: "explore_year",
            next_year: year + 1,
            earliest_hit_year: year,
            zero_streak: 0,
            deep_triggered: deepTriggered,
            allow_deep: allowDeep,
            earliest_region_start: null,
            collect_window_start: null,
            collect_span_days: COLLECT_INITIAL_SPAN_DAYS,
            collected_ids: [...collected.keys()],
          });
          await sleep(EXPLORE_INTER_REQUEST_DELAY_MS);
          continue;
        }

        saveCheckpoint?.({
          phase: "explore_month",
          next_year: year,
          month_scan_year: year,
          next_month: year === startYear ? startTime.getUTCMonth() : 0,
          earliest_hit_year: year,
          zero_streak: 0,
          deep_triggered: deepTriggered,
          allow_deep: allowDeep,
          earliest_region_start: null,
          collect_window_start: null,
          collect_span_days: COLLECT_INITIAL_SPAN_DAYS,
        });
        await sleep(EXPLORE_INTER_REQUEST_DELAY_MS);
      } else {
        console.log(
          `[bulk-explore] year=${year} — skipping year probe (resuming mid-month-scan)`,
        );
      }

      // ── Month scan ────────────────────────────────────────────────────────
      const scanYear = earliestHitYear;
      const monthFrom =
        scanYear === skipYearProbeFor && cp?.next_month !== undefined
          ? cp.next_month
          : scanYear === startYear
            ? startTime.getUTCMonth()
            : 0;

      let zeroStreak =
        scanYear === skipYearProbeFor ? (cp?.zero_streak ?? 0) : 0;
      if (year !== skipYearProbeFor) deepTriggered = false;

      saveCheckpoint?.({
        phase: "explore_month",
        next_year: scanYear,
        month_scan_year: scanYear,
        next_month: monthFrom,
        earliest_hit_year: scanYear,
        zero_streak: zeroStreak,
        deep_triggered: deepTriggered,
        allow_deep: allowDeep,
        earliest_region_start: null,
        collect_window_start: null,
        collect_span_days: COLLECT_INITIAL_SPAN_DAYS,
      });

      for (
        let m = monthFrom;
        m < 12 && stats.totalCalls < MAX_API_CALLS;
        m++
      ) {
        const mStart =
          scanYear === startYear && m === startTime.getUTCMonth()
            ? startTime
            : new Date(Date.UTC(scanYear, m, 1));
        const mEnd = new Date(Date.UTC(scanYear, m + 1, 1));
        if (mStart >= now) break;

        const monthEndBounded = minDate(mEnd, now);
        if (isRangeFullyCollected(mStart, monthEndBounded)) {
          console.log(
            `[bulk-explore] month=${scanYear}-${String(m + 1).padStart(2, "0")} → skipping (already whole-collected)`,
          );
          continue;
        }

        let mPage: TimelinePage;
        try {
          mPage = await searchAllTweets(
            query, mStart.toISOString(), monthEndBounded.toISOString(), stats, 10,
          );
        } catch (e) {
          if (e instanceof XApiStop && e.statusCode === 403) throw e;
          if (e instanceof XApiStop) {
            return errorResult(user.username, limit, stats, e.reason as StopReason, "full_archive");
          }
          throw e;
        }

        const mOldest = oldestInPage(mPage.tweets);
        console.log(
          `[bulk-explore] month=${scanYear}-${String(m + 1).padStart(2, "0")} found=${mPage.tweets.length} oldest=${mOldest?.created_at.slice(0, 10) ?? "none"}`,
        );
        onProgress?.(stats.totalCalls);

        if (!mOldest) {
          zeroStreak++;
          saveCheckpoint?.({
            phase: "explore_month",
            next_year: scanYear,
            month_scan_year: scanYear,
            next_month: m + 1,
            earliest_hit_year: scanYear,
            zero_streak: zeroStreak,
            deep_triggered: deepTriggered,
            allow_deep: allowDeep,
            earliest_region_start: null,
            collect_window_start: null,
            collect_span_days: COLLECT_INITIAL_SPAN_DAYS,
          });
          await sleep(EXPLORE_INTER_REQUEST_DELAY_MS);
        } else {
          if (zeroStreak >= DEEP_TRIGGER_ZERO_STREAK) {
            console.log(
              `[bulk-deep] trigger detected but deep backfill disabled: year=${scanYear} zeroStreak=${zeroStreak}`,
            );
          }

          const monthTweetCount = mPage.tweets.length;
          if (monthTweetCount >= 1 && monthTweetCount <= 9) {
            console.log(
              `[bulk-explore] month found=${monthTweetCount} → whole-collect`,
            );
            try {
              const wcResult = await wholeCollectFromProbe(
                query, mStart, monthEndBounded, stats, collected,
                MAX_API_CALLS, user.username, mPage, onProgress, user.id,
              );
              totalStoredNew += wcResult.storedNew;
              wholeCollectedRanges.push({ start: mStart, end: monthEndBounded });
            } catch (e) {
              if (e instanceof WholeCollectPaginationAbort) {
                earliestRegionStart = mStart;
                saveCheckpoint?.({
                  phase: "collect",
                  next_year: scanYear,
                  month_scan_year: scanYear,
                  next_month: m,
                  earliest_hit_year: scanYear,
                  zero_streak: zeroStreak,
                  deep_triggered: deepTriggered,
                  allow_deep: allowDeep,
                  earliest_region_start: earliestRegionStart.toISOString(),
                  collect_window_start: earliestRegionStart.toISOString(),
                  collect_span_days: COLLECT_INITIAL_SPAN_DAYS,
                  collected_ids: [...collected.keys()],
                });
                await sleep(EXPLORE_INTER_REQUEST_DELAY_MS);
                break yearLoop;
              } else { throw e; }
            }
            if (!earliestRegionStart) earliestRegionStart = mStart;
            await sleep(EXPLORE_INTER_REQUEST_DELAY_MS);
            continue;
          }

          earliestRegionStart = mStart;
          saveCheckpoint?.({
            phase: "collect",
            next_year: scanYear,
            month_scan_year: scanYear,
            next_month: m,
            earliest_hit_year: scanYear,
            zero_streak: zeroStreak,
            deep_triggered: deepTriggered,
            allow_deep: allowDeep,
            earliest_region_start: earliestRegionStart.toISOString(),
            collect_window_start: earliestRegionStart.toISOString(),
            collect_span_days: COLLECT_INITIAL_SPAN_DAYS,
            collected_ids: [...collected.keys()],
          });
          await sleep(EXPLORE_INTER_REQUEST_DELAY_MS);
          break yearLoop;
        }
      }

      if (!earliestRegionStart) {
        const scanYearStart = new Date(Date.UTC(scanYear, 0, 1));
        earliestRegionStart = scanYearStart;
        saveCheckpoint?.({
          phase: "collect",
          next_year: scanYear,
          month_scan_year: scanYear,
          next_month: 0,
          earliest_hit_year: scanYear,
          zero_streak: 0,
          deep_triggered: deepTriggered,
          allow_deep: allowDeep,
          earliest_region_start: earliestRegionStart.toISOString(),
          collect_window_start: earliestRegionStart.toISOString(),
          collect_span_days: COLLECT_INITIAL_SPAN_DAYS,
          collected_ids: [],
        });
        break;
      }
    }
  }

  if (!earliestRegionStart) {
    const reason: StopReason =
      stats.totalCalls >= MAX_API_CALLS
        ? "MAX_API_CALLS_REACHED"
        : "ACCOUNT_HAS_LESS_THAN_LIMIT";
    return {
      username: user.username,
      accountId: user.id,
      createdAt: user.created_at,
      requestedLimit: limit,
      fetchedCount: 0,
      stopReason: reason,
      apiCalls: stats.totalCalls,
      storedNewCount: 0,
      errors: stats.errors,
      acquisitionMode: "full_archive",
      timelineExhausted: true,
      presentHorizonSweepComplete: false,
      deepTriggered: false,
    };
  }

  console.log(
    `[bulk-explore] @${user.username} earliest region: ${earliestRegionStart.toISOString().slice(0, 10)} (${stats.totalCalls} calls so far)`,
  );

  // ── Early completion check ─────────────────────────────────────────────────
  const effectiveTargetCount = missingCount ?? limit;
  const earlyTargetMet =
    missingCount != null
      ? totalStoredNew >= effectiveTargetCount
      : collected.size >= effectiveTargetCount;

  if (earlyTargetMet) {
    const sorted = [...collected.values()]
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
      .slice(0, effectiveTargetCount);
    await storeTweets(user.id, sorted, []);
    return {
      username: user.username,
      accountId: user.id,
      createdAt: user.created_at,
      requestedLimit: limit,
      fetchedCount: sorted.length,
      stopReason: "OK_LIMIT_REACHED",
      apiCalls: stats.totalCalls,
      storedNewCount: totalStoredNew,
      errors: stats.errors,
      acquisitionMode: "full_archive",
      timelineExhausted: false,
      presentHorizonSweepComplete: false,
      deepTriggered: false,
    };
  }

  // ── Phase B: Collect (blast variant) ──────────────────────────────────────
  const collectResumeFrom =
    cp?.phase === "collect" && cp.collect_window_start
      ? new Date(cp.collect_window_start)
      : null;
  const collectInitialSpan =
    cp?.phase === "collect" ? cp.collect_span_days : COLLECT_INITIAL_SPAN_DAYS;
  const collectStagnationCount =
    cp?.phase === "collect" ? (cp.collect_stagnation_count ?? 0) : 0;
  const collectLastWindowKey =
    cp?.phase === "collect" ? (cp.collect_last_window_key ?? null) : null;

  const makeCollectCp = (
    nextWindowStart: Date,
    nextSpanDays: number,
    collectedIds: string[],
    stagnation?: { count: number; lastWindowKey: string | null },
    splitQueue: BulkSplitWindow[] = [],
  ): ExcavationCheckpoint => ({
    phase: "collect",
    next_year: earliestHitYear,
    earliest_hit_year: earliestHitYear,
    zero_streak: 0,
    deep_triggered: deepTriggered,
    allow_deep: allowDeep,
    earliest_region_start: earliestRegionStart!.toISOString(),
    collect_window_start: nextWindowStart.toISOString(),
    collect_span_days: nextSpanDays,
    collected_ids: collectedIds,
    // A bulk window is committed only after it is exhausted. On interruption
    // we re-fetch the in-memory window from page one, so a capped parent can
    // still be discarded safely before any of its posts are stored.
    collect_window_end: null,
    collect_next_token: null,
    collect_exhausted: undefined,
    collect_pages_fetched: undefined,
    collect_stagnation_count: stagnation?.count ?? 0,
    collect_last_window_key: stagnation?.lastWindowKey ?? null,
    split_window_queue: splitQueue,
  });

  const collectResult = await collectWindowPassBulk(
    query,
    earliestRegionStart,
    now,
    stats,
    collected,
    MAX_API_CALLS,
    effectiveTargetCount,
    user.username,
    onProgress,
    {
      userId: user.id,
      resumeFrom: collectResumeFrom,
      initialSpanDays: collectInitialSpan,
      initialStagnationCount: collectStagnationCount,
      initialLastWindowKey: collectLastWindowKey,
      resumeCheckpoint: cp || undefined,
      storedNewTarget:
        missingCount != null
          ? Math.max(0, missingCount - totalStoredNew)
          : undefined,
      saveWindowCheckpoint: saveCheckpoint
        ? (ws, sd, ids, stag, splitQueue) =>
            saveCheckpoint(makeCollectCp(ws, sd, ids, stag, splitQueue))
        : undefined,
    },
  );

  totalStoredNew += collectResult.storedNewCount;
  let stopReason: StopReason = collectResult.stopReason;
  let timelineExhausted = collectResult.timelineExhausted;
  let presentHorizonSweepComplete = collectResult.presentHorizonSweepComplete;

  if (
    stats.totalCalls >= MAX_API_CALLS &&
    stopReason === "ACCOUNT_HAS_LESS_THAN_LIMIT"
  ) {
    stopReason = "MAX_API_CALLS_REACHED";
    timelineExhausted = false;
    presentHorizonSweepComplete = false;
  }

  const sorted = [...collected.values()]
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .slice(0, effectiveTargetCount);

  await storeTweets(user.id, sorted, []);

  console.log(
    `[bulk-excavate] @${user.username} done: fetched=${sorted.length} stored_new=${totalStoredNew} api_calls=${stats.totalCalls} stop=${stopReason}`,
  );

  return {
    username: user.username,
    accountId: user.id,
    createdAt: user.created_at,
    requestedLimit: limit,
    fetchedCount: sorted.length,
    stopReason,
    apiCalls: stats.totalCalls,
    storedNewCount: totalStoredNew,
    errors: stats.errors,
    acquisitionMode: "full_archive",
    deepTriggered: false,
    timelineExhausted,
    presentHorizonSweepComplete,
  };
}

// ─── Public entry point ────────────────────────────────────────────────────────

/**
 * Dev-only bulk excavation.
 *
 * Drop-in replacement for excavateEarliest with blast-mode collect behaviour:
 * - A 20-page-capped window is split from its observed cursor density;
 *   its parent results are discarded before storage
 * - Window widened until single yield ≥ 100 (vs 10 in normal mode)
 * - Up to 20 pages per window (vs 5)
 * - No 100-tweet cap on effectiveLimit
 *
 * Signature is identical to excavateEarliest so jobs.ts can call it the same way.
 *
 * NEVER call from production code. Guard all callers with NEXT_PUBLIC_DEV_PANEL.
 */
export async function excavateBulk(
  username: string,
  limit: number,
  onProgress?: (apiCalls: number) => void,
  token?: string,
  onRateLimit?: (resetEpochSec: number) => void,
  saveCheckpoint?: (cp: ExcavationCheckpoint) => void,
  initialCheckpoint?: ExcavationCheckpoint | null,
  jobId?: string,
  continuationStartTime?: string,
  missingCount?: number,
): Promise<ExcavationResult> {
  const stats = createStats(token, onRateLimit, jobId);
  // No Math.min(limit, 100) cap — bulk mode is designed for large counts.
  const effectiveLimit = limit;

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

  await upsertAccount(user);

  const query = `from:${user.username} -is:retweet`;
  try {
    return await excavateFullArchiveBulk(
      user,
      query,
      effectiveLimit,
      stats,
      onProgress,
      saveCheckpoint,
      initialCheckpoint,
      continuationStartTime,
      missingCount,
    );
  } catch (e) {
    if (e instanceof XApiStop && e.statusCode === 403) {
      // Full-archive unavailable — fall through to a simplified error result.
      // (No fallback timeline in bulk mode — dev tool only.)
      console.warn(`[bulk-excavate] Full-archive 403 for @${username} — no fallback in bulk mode`);
      return errorResult(username, effectiveLimit, stats, "API_ERROR", "full_archive");
    }
    throw e;
  }
}
