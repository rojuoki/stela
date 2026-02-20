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
 *
 * Checkpoint / resume:
 *   Callers may pass saveCheckpoint + initialCheckpoint to enable
 *   checkpoint-based resume after a 429 suspension. The checkpoint is saved
 *   at every safe boundary (after each successful API probe or collect window).
 *   On resume, the excavation continues from the exact last saved point.
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

// ── Adaptive window sizing constants ──────────────────────────────────────────
// Controls how collectSpanDays grows/shrinks based on hit density per window.
const TARGET_MIN_HITS = 10;        // below this → window is "low density"
const MIN_COLLECT_SPAN_DAYS = 7;   // floor to prevent runaway shrink
// ceiling = COLLECT_MAX_SPAN_DAYS (reuse existing)
const GROW_FACTOR_ZERO = 8;        // aggressive grow when window is empty
const GROW_FACTOR_LOW  = 4;        // gentle grow when window has <TARGET_MIN_HITS tweets
const SHRINK_FACTOR_FULL = 0.5;    // halve span when window is clogged (page cap hit)

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

/**
 * Persisted at every safe boundary (after each successful probe or collect window).
 * On resume, the excavation restores state from this snapshot and continues
 * from the exact last saved point — without re-running any completed step.
 *
 * Lifecycle:
 *   jobs.ts writes this to DB on every saveCheckpoint call.
 *   On success/failure the DB column is set to NULL.
 *   On 429 suspend the column is left as-is (preserved for next run).
 */
export interface ExcavationCheckpoint {
  /** Current phase at the time of the checkpoint. */
  phase: "explore_year" | "explore_month" | "collect";

  // ── Explore state ───────────────────────────────────
  /** Year loop should resume from this year (all prior years confirmed done). */
  next_year: number;
  /** Set when phase === "explore_month": which year we were scanning. */
  month_scan_year?: number;
  /** Set when phase === "explore_month": next month index (0-based) to probe. */
  next_month?: number;
  earliest_hit_year: number;
  zero_streak: number;
  deep_triggered: boolean;
  allow_deep: boolean;

  // ── Region / collect state ──────────────────────────
  /** ISO string — set once the earliest region is found. */
  earliest_region_start: string | null;
  /** ISO string — the NEXT window start for the collect phase. null = collect done. */
  collect_window_start: string | null;
  collect_span_days: number;
  /**
   * Tweet IDs already collected and stored to DB during this job.
   * Used to reconstruct the in-memory collected Map on resume without
   * loading tweets from prior jobs.
   */
  collected_ids?: string[];

  // ── Mid-window pagination resume (COLLECT phase only) ──────────────────────
  // Set after every successful page fetch when next_token is non-null.
  // Cleared (null) by saveWindowCheckpoint when the window finishes.
  /** ISO string — the end boundary of the window currently being paginated. */
  collect_window_end?: string | null;
  /** X API next_token for the next page to fetch in the current window. null = no mid-window state. */
  collect_next_token?: string | null;
  /** Whether the window's pagination was exhausted (always false when next_token is set). */
  collect_exhausted?: boolean;
  /** Number of pages already fetched in the current window (for debug logging). */
  collect_pages_fetched?: number;
}

// ─── Entry point ───────────────────────────────────────

export async function excavateEarliest(
  username: string,
  limit: number = 100,
  /** Called after each API probe so the job record can show live api_calls during excavation. */
  onProgress?: (apiCalls: number) => void,
  /** Bearer token assigned by TokenPool for this excavation session. */
  token?: string,
  /** Called when a 429 is received (before the in-process wait). Arg = reset epoch (seconds). */
  onRateLimit?: (resetEpochSec: number) => void,
  /** Called at every safe boundary to persist checkpoint to DB. */
  saveCheckpoint?: (cp: ExcavationCheckpoint) => void,
  /** Checkpoint from a previous run; when present, resume from that point. */
  initialCheckpoint?: ExcavationCheckpoint | null,
): Promise<ExcavationResult> {
  const stats = createStats(token, onRateLimit);
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
    return await excavateFullArchive(
      user,
      query,
      effectiveLimit,
      stats,
      onProgress,
      saveCheckpoint,
      initialCheckpoint,
    );
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
  saveCheckpoint?: (cp: ExcavationCheckpoint) => void,
  cp?: ExcavationCheckpoint | null,
): Promise<ExcavationResult> {
  const accountCreated = new Date(user.created_at);
  const now = new Date();
  const startYear = accountCreated.getUTCFullYear();
  const endYear = now.getUTCFullYear();

  console.log(
    `[explore] @${user.username} account_created=${user.created_at} query="${query}"${cp ? ` (resuming from phase=${cp.phase})` : ""}`,
  );

  // ── Restore from checkpoint ─────────────────────────

  const allowDeep: boolean =
    cp?.allow_deep ?? (accountCreated.getUTCFullYear() <= 2018);
  console.log(`[deep] account_created=${accountCreated.getUTCFullYear()} allowDeep=${allowDeep}`);

  let earliestRegionStart: Date | null = null;
  let deepTriggered: boolean = cp?.deep_triggered ?? false;
  let earliestHitYear: number = cp?.earliest_hit_year ?? -1;

  const collected = new Map<string, XTweet>();

  // If resuming from collect phase, skip explore entirely and reload saved tweets.
  if (cp?.phase === "collect" && cp.earliest_region_start) {
    earliestRegionStart = new Date(cp.earliest_region_start);
    deepTriggered = cp.deep_triggered;
    earliestHitYear = cp.earliest_hit_year;

    if (cp.collected_ids && cp.collected_ids.length > 0) {
      const restored = loadTweetsFromDbByIds(user.id, cp.collected_ids);
      for (const t of restored) collected.set(t.id, t);
      console.log(
        `[checkpoint] Restored ${collected.size} tweets for @${user.username} (${cp.collected_ids.length} IDs)`,
      );
    }
  } else {
    // ── Phase A: Explore — coarse (years) → fine (months) ──

    // Determine where to resume in the year loop.
    const resumeFromYear =
      cp?.phase === "explore_year" ? cp.next_year : startYear;

    // If resuming mid-month-scan, we'll skip the year probe for that year.
    const skipYearProbeFor =
      cp?.phase === "explore_month" ? cp.month_scan_year : undefined;

    yearLoop: for (
      let year = resumeFromYear;
      year <= endYear && stats.totalCalls < MAX_API_CALLS;
      year++
    ) {
      const yearStart =
        year === startYear ? accountCreated : new Date(Date.UTC(year, 0, 1));
      const yearEnd = new Date(Date.UTC(year + 1, 0, 1));
      const yEndStr = minDate(yearEnd, now).toISOString();

      // ── Year probe (skipped when resuming mid-month-scan for this year) ──

      if (year !== skipYearProbeFor) {
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

        const yOldest = oldestInPage(yPage.tweets);
        console.log(
          `[explore] year=${year} window=[${yearStart.toISOString().slice(0, 10)}, ${yEndStr.slice(0, 10)}] found=${yPage.tweets.length} oldest=${yOldest?.created_at.slice(0, 10) ?? "none"}`,
        );
        onProgress?.(stats.totalCalls);
        await sleep(EXPLORE_INTER_REQUEST_DELAY_MS);

        if (!yOldest) {
          // Year has no tweets — save and move to next year.
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
          continue;
        }

        // Year has tweets — begin month scan.
        earliestHitYear = year;
      } else {
        // Resuming mid-month-scan: we already know this year has tweets.
        earliestHitYear = year;
        console.log(
          `[explore] year=${year} — skipping year probe (resuming mid-month-scan)`,
        );
      }

      // ── Month scan ──────────────────────────────────

      const monthFrom =
        year === skipYearProbeFor && cp?.next_month !== undefined
          ? cp.next_month
          : year === startYear
            ? accountCreated.getUTCMonth()
            : 0;

      let zeroStreak =
        year === skipYearProbeFor ? (cp?.zero_streak ?? 0) : 0;

      // deepTriggered may already be restored; don't reset it for this year's scan.
      if (year !== skipYearProbeFor) deepTriggered = false;

      // Checkpoint: entering month scan for this year.
      saveCheckpoint?.({
        phase: "explore_month",
        next_year: year,
        month_scan_year: year,
        next_month: monthFrom,
        earliest_hit_year: year,
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
        const mStart = new Date(Date.UTC(year, m, 1));
        const mEnd = new Date(Date.UTC(year, m + 1, 1));
        if (mStart >= now) break;

        let mPage: TimelinePage;
        try {
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

        const mOldest = oldestInPage(mPage.tweets);
        console.log(
          `[explore] month=${year}-${String(m + 1).padStart(2, "0")} window=[${mStart.toISOString().slice(0, 10)}, ${minDate(mEnd, now).toISOString().slice(0, 10)}] found=${mPage.tweets.length} oldest=${mOldest?.created_at.slice(0, 10) ?? "none"}`,
        );
        onProgress?.(stats.totalCalls);
        await sleep(EXPLORE_INTER_REQUEST_DELAY_MS);

        if (!mOldest) {
          zeroStreak++;
          // Checkpoint: this month is done, no tweets found.
          saveCheckpoint?.({
            phase: "explore_month",
            next_year: year,
            month_scan_year: year,
            next_month: m + 1,
            earliest_hit_year: year,
            zero_streak: zeroStreak,
            deep_triggered: deepTriggered,
            allow_deep: allowDeep,
            earliest_region_start: null,
            collect_window_start: null,
            collect_span_days: COLLECT_INITIAL_SPAN_DAYS,
          });
        } else {
          // Found tweets in this month.
          if (zeroStreak >= DEEP_TRIGGER_ZERO_STREAK) {
            if (allowDeep) {
              deepTriggered = true;
              console.log(
                `[deep] trigger: year=${year} zeroStreak=${zeroStreak} firstHitMonth=${m + 1} reason=MISSING_EARLY_MONTHS`,
              );
            } else {
              console.log(
                `[deep] skipped: new account (created=${accountCreated.getUTCFullYear()} zeroStreak=${zeroStreak})`,
              );
            }
          }

          earliestRegionStart = mStart;

          // Checkpoint: found the earliest region, about to enter collect.
          saveCheckpoint?.({
            phase: "collect",
            next_year: year,
            month_scan_year: year,
            next_month: m,
            earliest_hit_year: year,
            zero_streak: zeroStreak,
            deep_triggered: deepTriggered,
            allow_deep: allowDeep,
            earliest_region_start: earliestRegionStart.toISOString(),
            collect_window_start: earliestRegionStart.toISOString(),
            collect_span_days: COLLECT_INITIAL_SPAN_DAYS,
            collected_ids: [],
          });

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
        saveCheckpoint?.({
          phase: "collect",
          next_year: year,
          month_scan_year: year,
          next_month: 0,
          earliest_hit_year: year,
          zero_streak: zeroStreak,
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

  // Determine collect resume point from checkpoint.
  const collectResumeFrom =
    cp?.phase === "collect" && cp.collect_window_start
      ? new Date(cp.collect_window_start)
      : null;
  const collectInitialSpan =
    cp?.phase === "collect" ? cp.collect_span_days : COLLECT_INITIAL_SPAN_DAYS;

  // Mid-window pagination resume: extract saved page-level state (if any).
  const collectResumeWindowEnd =
    cp?.phase === "collect" && cp.collect_next_token && cp.collect_window_end
      ? new Date(cp.collect_window_end)
      : null;
  const collectResumeNextToken =
    cp?.phase === "collect" && cp.collect_next_token ? cp.collect_next_token : null;
  const collectResumePagesFetched =
    cp?.phase === "collect" && cp.collect_pages_fetched != null
      ? cp.collect_pages_fetched
      : undefined;

  // Build a full collect-phase checkpoint for the save callback.
  // pageState is set for mid-window page checkpoints; omitted for window-level checkpoints
  // (which clears collect_next_token, preventing stale resume state).
  const makeCollectCp = (
    nextWindowStart: Date,
    nextSpanDays: number,
    collectedIds: string[],
    pageState?: { windowEnd: Date; nextToken: string; pagesFetched: number },
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
    // Page-level fields (null when window-level checkpoint, clearing mid-window state).
    collect_window_end: pageState?.windowEnd.toISOString() ?? null,
    collect_next_token: pageState?.nextToken ?? null,
    collect_exhausted: pageState ? false : undefined,
    collect_pages_fetched: pageState?.pagesFetched,
  });

  const standardStop = await collectWindowPass(
    query,
    earliestRegionStart,
    now,
    stats,
    collected,
    MAX_API_CALLS,
    limit,
    user.username,
    onProgress,
    {
      userId: user.id,
      resumeFrom: collectResumeFrom,
      initialSpanDays: collectInitialSpan,
      resumeWindowEnd: collectResumeWindowEnd,
      resumeNextToken: collectResumeNextToken,
      resumePagesFetched: collectResumePagesFetched,
      // Window-level checkpoint: clears page-level fields (collect_next_token = null).
      saveWindowCheckpoint: saveCheckpoint
        ? (ws, sd, ids) => saveCheckpoint(makeCollectCp(ws, sd, ids))
        : undefined,
      // Page-level checkpoint: saves next_token so resume skips already-fetched pages.
      savePageCheckpoint: saveCheckpoint
        ? (ws, we, nt, pf, ids, sd) =>
            saveCheckpoint(makeCollectCp(ws, sd, ids, { windowEnd: we, nextToken: nt, pagesFetched: pf }))
        : undefined,
    },
  );
  let stopReason: StopReason = standardStop;

  // ── Phase C: Deep backfill (missing early period) ──

  let deepAddedCount = 0;

  if (deepTriggered && earliestHitYear > 0) {
    const X_ARCHIVE_FLOOR = new Date("2006-03-21T00:00:00Z");
    const deepStart = maxDate(X_ARCHIVE_FLOOR, accountCreated);
    const deepEnd = earliestRegionStart;
    const remainingBudget = MAX_API_CALLS - stats.totalCalls;
    const deepCallBudget = Math.min(remainingBudget, MAX_API_CALLS_DEEP);

    if (deepCallBudget > 0 && deepEnd > deepStart) {
      const deepCallCeiling = stats.totalCalls + deepCallBudget;
      const sizeBefore = collected.size;

      console.log(
        `[deep] backfill range=[${deepStart.toISOString().slice(0, 10)}, ${deepEnd.toISOString().slice(0, 10)}) account_created=${accountCreated.toISOString().slice(0, 10)} budget=${deepCallBudget}`,
      );

      // Deep backfill uses incremental storage but no checkpoint (bounded budget,
      // and standard collect results are already safe in DB if 429 hits here).
      const deepStop = await collectWindowPass(
        query,
        deepStart,
        deepEnd,
        stats,
        collected,
        deepCallCeiling,
        Number.MAX_SAFE_INTEGER,
        user.username,
        onProgress,
        { userId: user.id },
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

interface CollectCheckpointOpts {
  /** Account ID for incremental tweet storage after each window. */
  userId: string;
  /** If set, skip windows until collectStart >= resumeFrom. */
  resumeFrom?: Date | null;
  /** Override the default initial window span. */
  initialSpanDays?: number;
  /**
   * Called after each completed window.
   * Args: nextWindowStart, nextSpanDays, all collected IDs so far.
   */
  saveWindowCheckpoint?: (
    nextWindowStart: Date,
    nextSpanDays: number,
    collectedIds: string[],
  ) => void;

  // ── Mid-window pagination resume ─────────────────────────────────────────
  /** The end boundary of the partially-completed window being resumed. */
  resumeWindowEnd?: Date | null;
  /** Pagination token to resume from within the current window (skip already-fetched pages). */
  resumeNextToken?: string | null;
  /** Pages already fetched in the current window before suspend (for logging). */
  resumePagesFetched?: number;
  /**
   * Called after each page fetch when a next_token is available (more pages remain).
   * Fires BEFORE the next API call so the state is saved if 429 hits next.
   * Args: windowStart, windowEnd, nextToken, pagesFetched, collectedIds (all so far), currentSpanDays.
   */
  savePageCheckpoint?: (
    windowStart: Date,
    windowEnd: Date,
    nextToken: string,
    pagesFetched: number,
    collectedIds: string[],
    currentSpanDays: number,
  ) => void;
}

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
  checkpointOpts?: CollectCheckpointOpts,
): Promise<StopReason> {
  // Resume from saved window if provided; otherwise start from the beginning.
  let collectStart = checkpointOpts?.resumeFrom ?? start;
  let collectSpanDays = checkpointOpts?.initialSpanDays ?? COLLECT_INITIAL_SPAN_DAYS;
  let stopReason: StopReason = "ACCOUNT_HAS_LESS_THAN_LIMIT";

  // True only for the very first window when a mid-window pagination token was saved.
  // After the first window completes (or if no token was saved), this is always false.
  let resumingMidWindow =
    checkpointOpts?.resumeFrom != null &&
    checkpointOpts?.resumeWindowEnd != null &&
    checkpointOpts?.resumeNextToken != null;

  // If the resume point is at or past `end`, the collect phase is already done.
  if (collectStart >= end) {
    console.log(
      `[collect] @${username} collect phase already complete (resumeFrom=${collectStart.toISOString().slice(0, 10)} >= end=${end.toISOString().slice(0, 10)})`,
    );
    return "ACCOUNT_HAS_LESS_THAN_LIMIT";
  }

  if (checkpointOpts?.resumeFrom) {
    if (resumingMidWindow) {
      console.log(
        `[collect] @${username} resuming mid-window=${collectStart.toISOString().slice(0, 10)} next_token=${checkpointOpts.resumeNextToken} pages_done=${checkpointOpts.resumePagesFetched ?? "?"} already_have=${collected.size}`,
      );
    } else {
      console.log(
        `[collect] @${username} resuming from window=${collectStart.toISOString().slice(0, 10)} already_have=${collected.size}`,
      );
    }
  }

  while (
    collected.size < collectLimit &&
    stats.totalCalls < callCeiling &&
    collectStart < end
  ) {
    // For a mid-window resume, the window end was already computed and saved.
    // Use it directly rather than re-computing from collectSpanDays.
    const collectEnd = resumingMidWindow
      ? checkpointOpts!.resumeWindowEnd!
      : minDate(addDays(collectStart, collectSpanDays), end);

    console.log(
      `[collect] @${username} window=[${collectStart.toISOString().slice(0, 10)}, ${collectEnd.toISOString().slice(0, 10)}] have=${collected.size}`,
    );

    // Accumulated tweets for this window across all pages.
    const windowTweets: XTweet[] = [];
    let nextToken: string | undefined;
    let pagesInWindow: number;

    if (resumingMidWindow) {
      // Skip page 1 re-fetch; jump straight to the saved pagination position.
      // Tweets from previously-fetched pages are already in DB and will be
      // restored into `collected` from checkpoint (via collected_ids).
      console.log(
        `[checkpoint] COLLECT resume from next_token=${checkpointOpts!.resumeNextToken}`,
      );
      nextToken = checkpointOpts!.resumeNextToken!;
      pagesInWindow = checkpointOpts!.resumePagesFetched ?? 1;
      resumingMidWindow = false; // only applies to the first window
    } else {
      // Fresh window: fetch page 1.
      let page: TimelinePage;
      try {
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

      windowTweets.push(...page.tweets);
      nextToken = page.nextToken;
      pagesInWindow = 1;

      // Store page 1 tweets immediately so they survive a 429 on the next call.
      if (checkpointOpts?.userId && page.tweets.length > 0) {
        storeTweets(checkpointOpts.userId, page.tweets);
      }

      // Save page checkpoint BEFORE making the next API call (if more pages remain).
      if (nextToken && checkpointOpts?.savePageCheckpoint) {
        const pageCollectedIds = [
          ...collected.keys(),
          ...windowTweets.map((t) => t.id),
        ];
        checkpointOpts.savePageCheckpoint(
          collectStart,
          collectEnd,
          nextToken,
          pagesInWindow,
          pageCollectedIds,
          collectSpanDays,
        );
        console.log(
          `[checkpoint] COLLECT page saved next_token=${nextToken} exhausted=false pages=${pagesInWindow}`,
        );
      }
    }

    // Paginate within window (bounded: MAX_COLLECT_PAGES_PER_WINDOW pages).
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

      // Store this page's tweets immediately for the same reason.
      if (checkpointOpts?.userId && nextPage.tweets.length > 0) {
        storeTweets(checkpointOpts.userId, nextPage.tweets);
      }

      // Save page checkpoint when more pages remain.
      if (nextToken && checkpointOpts?.savePageCheckpoint) {
        const pageCollectedIds = [
          ...collected.keys(),
          ...windowTweets.map((t) => t.id),
        ];
        checkpointOpts.savePageCheckpoint(
          collectStart,
          collectEnd,
          nextToken,
          pagesInWindow,
          pageCollectedIds,
          collectSpanDays,
        );
        console.log(
          `[checkpoint] COLLECT page saved next_token=${nextToken} exhausted=false pages=${pagesInWindow}`,
        );
      }
    }

    const exhausted = !nextToken;
    console.log(
      `[collect] window yielded ${windowTweets.length} tweets (${pagesInWindow} pages, ${exhausted ? "exhausted" : "page-limit hit"})`,
    );

    const sizeBeforeWindow = collected.size;
    onProgress?.(stats.totalCalls);
    for (const t of windowTweets) collected.set(t.id, t);
    const uniqueNew = collected.size - sizeBeforeWindow;

    // ── Incremental storage — persist this window's tweets to DB so they
    //    survive a 429 suspend and can be reloaded on resume.
    if (checkpointOpts?.userId && windowTweets.length > 0) {
      storeTweets(checkpointOpts.userId, windowTweets);
    }

    // ── Adaptive window sizing ─────────────────────────────────────────────
    // Grow aggressively on empty windows (sparse/early account) to reduce
    // wasted API calls. Shrink when the page cap is hit (dense period) so we
    // don't skip tweets on the earliest side.
    const clogged = !exhausted && pagesInWindow >= MAX_COLLECT_PAGES_PER_WINDOW;
    let adaptAction: string;
    let nextSpanDays: number;

    if (uniqueNew === 0) {
      nextSpanDays = Math.min(collectSpanDays * GROW_FACTOR_ZERO, COLLECT_MAX_SPAN_DAYS);
      adaptAction = "grow_zero";
    } else if (uniqueNew < TARGET_MIN_HITS) {
      nextSpanDays = Math.min(collectSpanDays * GROW_FACTOR_LOW, COLLECT_MAX_SPAN_DAYS);
      adaptAction = "grow_low";
    } else if (clogged) {
      nextSpanDays = Math.max(Math.floor(collectSpanDays * SHRINK_FACTOR_FULL), MIN_COLLECT_SPAN_DAYS);
      adaptAction = "shrink_full";
    } else {
      nextSpanDays = collectSpanDays;
      adaptAction = "keep";
    }

    console.log(
      `[collect][adaptive] spanDays=${collectSpanDays} uniqueNew=${uniqueNew} pages=${pagesInWindow} exhausted=${exhausted} action=${adaptAction} nextSpanDays=${nextSpanDays}`,
    );

    if (collected.size >= collectLimit) {
      stopReason = "OK_LIMIT_REACHED";
      // Advance window before saving checkpoint to mark this window done.
      collectStart = collectEnd;
      collectSpanDays = nextSpanDays;
      checkpointOpts?.saveWindowCheckpoint?.(
        collectStart,
        collectSpanDays,
        [...collected.keys()],
      );
      break;
    }

    if (stats.totalCalls >= callCeiling) {
      stopReason = "MAX_API_CALLS_REACHED";
      break;
    }

    // Advance window using the adaptively computed span.
    collectStart = collectEnd;
    collectSpanDays = nextSpanDays;

    // Checkpoint: this window done, next window is collectStart.
    checkpointOpts?.saveWindowCheckpoint?.(
      collectStart,
      collectSpanDays,
      [...collected.keys()],
    );
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

/**
 * Load specific tweets from the DB by their IDs.
 * Used on resume to reconstruct the in-memory `collected` Map without
 * loading tweets from prior jobs (which would give a wrong size count).
 */
function loadTweetsFromDbByIds(accountId: string, ids: string[]): XTweet[] {
  if (!ids.length) return [];
  const db = getDb();
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT post_id AS id, created_at, full_text AS text,
              like_count, retweet_count, reply_count, media_json
       FROM tweets
       WHERE account_id = ? AND post_id IN (${placeholders})`,
    )
    .all(accountId, ...ids) as Array<{
    id: string;
    created_at: string;
    text: string;
    like_count: number;
    retweet_count: number;
    reply_count: number;
    media_json: string | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    author_id: accountId,
    created_at: r.created_at,
    text: r.text,
    public_metrics: {
      like_count: r.like_count,
      retweet_count: r.retweet_count,
      reply_count: r.reply_count,
      quote_count: 0,
      impression_count: 0,
    },
    attachments: r.media_json ? JSON.parse(r.media_json) : undefined,
  }));
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
