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
  type XMedia,
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

/**
 * Number of consecutive zero-year results before switching to 2-year steps.
 * This optimizes year scanning for accounts with long "initial sparse" periods.
 */
const YEAR_STEP_ZERO_STREAK_THRESHOLD = 3;

/** Delay between consecutive explore probes to avoid hammering the rate limit. */
const EXPLORE_INTER_REQUEST_DELAY_MS = 1300;

/** Full-archive collect: initial window width when scanning forward. */
const COLLECT_INITIAL_SPAN_DAYS = 30;
const COLLECT_MAX_SPAN_DAYS = 365 * 2;
/** Max pages to paginate within a single collect window (100/page = 500 tweets max). */
const MAX_COLLECT_PAGES_PER_WINDOW = 5;

/**
 * Minimum window span for split operation. Windows smaller than this
 * will not be split even if they return next_token on page 1.
 */
const MIN_SPLIT_SPAN_DAYS = 7;

// ── Adaptive window sizing constants ──────────────────────────────────────────
// Controls how collectSpanDays grows/shrinks based on hit density per window.
const TARGET_MIN_HITS = 10;        // below this → window is "low density"
const MIN_COLLECT_SPAN_DAYS = 7;   // floor to prevent runaway shrink
// ceiling = COLLECT_MAX_SPAN_DAYS (reuse existing)
const GROW_FACTOR_ZERO = 8;        // aggressive grow when window is empty
const GROW_FACTOR_LOW  = 4;        // gentle grow when window has <TARGET_MIN_HITS tweets
const SHRINK_FACTOR_FULL = 0.5;    // halve span when window is clogged (page cap hit)

/**
 * Number of consecutive same-window / stored_new=0 iterations before forcing
 * a window shift. Protects against infinite loops on 429 resume when the
 * checkpoint points to a window whose tweets are all already collected.
 */
const STAGNATION_THRESHOLD = 2;

/**
 * Generate normalized window key for stagnation detection.
 * Uses consistent format to ensure checkpoint/resume compatibility.
 */
function makeWindowKey(start: Date, end: Date): string {
  return `${start.toISOString()}-${end.toISOString()}`;
}

/** Fallback (timeline) constants — same behaviour as previous implementation. */
const FALLBACK_INITIAL_SPAN_DAYS = 30;
const FALLBACK_MAX_SPAN_DAYS = 365 * 2;

/**
 * end_time safety buffer: keep end_time at least this many ms before now.
 * 60 s covers the X API's 10 s minimum requirement plus up to ~50 s of
 * clock skew between the local host and X's servers.
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

/**
 * Represents a split child window waiting to be processed.
 */
interface SplitWindow {
  start: string; // ISO string
  end: string;   // ISO string  
  spanDays: number;
}

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
  /** Consecutive zero-year count for step optimization. */
  zero_year_streak: number;
  /** Current year step size (1 or 2). */
  step_years: number;

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

  // ── Stagnation detection ──────────────────────────────────────────────────
  /** Number of consecutive windows with same key and stored_new=0. Reset on any progress. */
  collect_stagnation_count?: number;
  /** Window key (`ISO_start-ISO_end`) of the last processed window for stagnation detection. */
  collect_last_window_key?: string | null;

  // ── Split window queue state ──────────────────────────────────────────────
  /** 
   * Pending split child windows to process (empty = no splits pending).
   * Processed in chronological order (earliest first).
   */
  split_window_queue?: SplitWindow[];
}

// ─── Stage Expansion Entry Point (Phase 4) ────────────────────────────────

/**
 * Excavate a stage expansion (Stage 2, Stage 3) for an account.
 * Extends the previous stage's result by approximately +100 posts.
 * 
 * @param username - Twitter username
 * @param targetStage - Stage to excavate (2, 3, etc.)
 * @param baselineStageResult - Previous stage result to expand from
 * @param onProgress - Progress callback
 * @param token - Bearer token
 * @param onRateLimit - Rate limit callback
 * @param jobId - Job ID for token management
 */
export async function excavateStageExpansion(
  username: string,
  targetStage: number,
  baselineStageResult: { collected_count: number; account_id: string },
  onProgress?: (apiCalls: number) => void,
  token?: string,
  onRateLimit?: (resetEpochSec: number) => void,
  jobId?: string,
): Promise<ExcavationResult> {
  const stats = createStats(token, onRateLimit, jobId);
  
  // Calculate target: baseline + 100 for this stage
  const effectiveLimit = baselineStageResult.collected_count + 100;
  
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

  console.log(
    `[excavate-expansion] @${username} Stage ${targetStage}: expanding from ${baselineStageResult.collected_count} to target ${effectiveLimit} (+100)`
  );

  // For stage expansion, we need to excavate beyond what we already have
  // We'll use a modified approach that starts from the baseline and tries to get more
  const query = `from:${user.username} -is:retweet`;
  
  try {
    return await excavateStageExpansionInternal(
      user,
      query,
      effectiveLimit,
      baselineStageResult.collected_count,
      targetStage,
      stats,
      onProgress,
    );
  } catch (e) {
    if (e instanceof XApiStop && e.statusCode === 403) {
      console.log(
        `[excavate-expansion] Full-archive unavailable (403) for @${username} Stage ${targetStage} — falling back to timeline`
      );
      return await excavateStageExpansionTimeline(user, effectiveLimit, baselineStageResult.collected_count, targetStage, stats, onProgress);
    }
    throw e;
  }
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
  /** Job ID for token switching (optional). */
  jobId?: string,
): Promise<ExcavationResult> {
  const stats = createStats(token, onRateLimit, jobId);
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
  const now = new Date(Date.now() - END_TIME_SAFETY_MS);
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

    // Year-scan optimization state.
    let zeroYearStreak = cp?.zero_year_streak ?? 0;
    let stepYears = cp?.step_years ?? 1;

    yearLoop: for (
      let year = resumeFromYear;
      year <= endYear && stats.totalCalls < MAX_API_CALLS;
      year += stepYears
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

        if (!yOldest) {
          // Year has no tweets — optimize year stepping.
          zeroYearStreak++;
          if (zeroYearStreak >= YEAR_STEP_ZERO_STREAK_THRESHOLD && stepYears === 1) {
            stepYears = 2;
            console.log(
              `[explore] year-scan mode: step=2, zeroStreak=${zeroYearStreak} (switching to 2-year steps)`,
            );
          }

          // Checkpoint BEFORE yielding to prevent re-queue race.
          saveCheckpoint?.({
            phase: "explore_year",
            next_year: year + stepYears,
            earliest_hit_year: -1,
            zero_streak: 0,
            deep_triggered: false,
            allow_deep: allowDeep,
            earliest_region_start: null,
            collect_window_start: null,
            collect_span_days: COLLECT_INITIAL_SPAN_DAYS,
            zero_year_streak: zeroYearStreak,
            step_years: stepYears,
          });
          await sleep(EXPLORE_INTER_REQUEST_DELAY_MS);
          continue;
        }

        // Year has tweets — may need to refine if we were using 2-year steps.
        let actualHitYear = year;
        
        // If we hit with 2-year steps, check the skipped year to find exact hit year.
        if (stepYears === 2 && year > startYear) {
          const prevYear = year - 1;
          if (prevYear >= startYear) {
            const prevYearStart = new Date(Date.UTC(prevYear, 0, 1));
            const prevYearEnd = new Date(Date.UTC(prevYear + 1, 0, 1));
            const prevYEndStr = minDate(prevYearEnd, now).toISOString();

            console.log(
              `[explore] 2-year step hit at ${year} — checking skipped year ${prevYear} for refinement`,
            );

            try {
              const prevPage = await searchAllTweets(query, prevYearStart.toISOString(), prevYEndStr, stats, 5);
              const prevOldest = oldestInPage(prevPage.tweets);
              
              if (prevOldest) {
                actualHitYear = prevYear;
                console.log(
                  `[explore] refinement: year=${prevYear} found=${prevPage.tweets.length} (actual hit year confirmed)`,
                );
              } else {
                console.log(
                  `[explore] refinement: year=${prevYear} found=0 (${year} is correct hit year)`,
                );
              }
            } catch (e) {
              if (e instanceof XApiStop && e.statusCode === 403) throw e;
              if (e instanceof XApiStop) {
                return errorResult(user.username, limit, stats, e.reason as StopReason, "full_archive");
              }
              throw e;
            }
          }
        }

        earliestHitYear = actualHitYear;
        zeroYearStreak = 0;
        stepYears = 1;

        // Save a checkpoint IMMEDIATELY before the inter-request sleep so that
        // an HMR restart (or any crash) during the sleep doesn't leave the
        // checkpoint pointing at the previous empty year.  Without this, the
        // job would resume with phase=explore_year / next_year=<this year> and
        // re-run the same year probe, hitting a duplicate API call (and
        // potentially wasting the 429 budget on an already-answered question).
        saveCheckpoint?.({
          phase: "explore_month",
          next_year: actualHitYear,
          month_scan_year: actualHitYear,
          next_month: actualHitYear === startYear ? accountCreated.getUTCMonth() : 0,
          earliest_hit_year: actualHitYear,
          zero_streak: 0,
          deep_triggered: deepTriggered,
          allow_deep: allowDeep,
          earliest_region_start: null,
          collect_window_start: null,
          collect_span_days: COLLECT_INITIAL_SPAN_DAYS,
          zero_year_streak: 0,
          step_years: 1,
        });
        await sleep(EXPLORE_INTER_REQUEST_DELAY_MS);
      } else {
        // Resuming mid-month-scan: we already know this year has tweets.
        // earliestHitYear is already restored from checkpoint, don't overwrite it.
        zeroYearStreak = 0;
        stepYears = 1;
        console.log(
          `[explore] year=${year} — skipping year probe (resuming mid-month-scan), using saved earliestHitYear=${earliestHitYear}`,
        );
      }

      // For month scanning, always use earliestHitYear which contains the correct year:
      // - New discoveries: earliestHitYear was set to actualHitYear after refinement
      // - Checkpoint resume: earliestHitYear was restored from saved checkpoint

      // ── Month scan ──────────────────────────────────
      // Use earliestHitYear for month scanning (correct after 2-year step refinement & checkpoint resume).
      const scanYear = earliestHitYear;

      const monthFrom =
        scanYear === skipYearProbeFor && cp?.next_month !== undefined
          ? cp.next_month
          : scanYear === startYear
            ? accountCreated.getUTCMonth()
            : 0;

      let zeroStreak =
        scanYear === skipYearProbeFor ? (cp?.zero_streak ?? 0) : 0;

      // deepTriggered may already be restored; don't reset it for this year's scan.
      if (year !== skipYearProbeFor) deepTriggered = false;

      // Checkpoint: entering month scan for this year.
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
        zero_year_streak: 0,
        step_years: 1,
      });

      for (
        let m = monthFrom;
        m < 12 && stats.totalCalls < MAX_API_CALLS;
        m++
      ) {
        // For the first month of the account creation year, use the exact
        // account creation timestamp rather than the start of the month.
        // This avoids requesting dates before the account (or Twitter itself)
        // existed — which the API rejects with 400.
        const mStart =
          scanYear === startYear && m === accountCreated.getUTCMonth()
            ? accountCreated
            : new Date(Date.UTC(scanYear, m, 1));
        const mEnd = new Date(Date.UTC(scanYear, m + 1, 1));
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
          `[explore] month=${scanYear}-${String(m + 1).padStart(2, "0")} window=[${mStart.toISOString().slice(0, 10)}, ${minDate(mEnd, now).toISOString().slice(0, 10)}] found=${mPage.tweets.length} oldest=${mOldest?.created_at.slice(0, 10) ?? "none"}`,
        );
        onProgress?.(stats.totalCalls);

        // Checkpoint BEFORE yielding to prevent stale-checkpoint race on re-queue.
        if (!mOldest) {
          zeroStreak++;
          // Checkpoint: this month is done, no tweets found.
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
            zero_year_streak: 0,
            step_years: 1,
          });
          await sleep(EXPLORE_INTER_REQUEST_DELAY_MS);
        } else {
          // Found tweets in this month.
          if (zeroStreak >= DEEP_TRIGGER_ZERO_STREAK) {
            if (allowDeep) {
              deepTriggered = true;
              console.log(
                `[deep] trigger: year=${scanYear} zeroStreak=${zeroStreak} firstHitMonth=${m + 1} reason=MISSING_EARLY_MONTHS`,
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
            collected_ids: [],
            zero_year_streak: 0,
            step_years: 1,
          });

          await sleep(EXPLORE_INTER_REQUEST_DELAY_MS);
          break yearLoop;
        }
      }

      // Month scan exhausted but year had tweets (unlikely API inconsistency).
      // Use year start as a safe collect origin so we don't miss anything.
      if (!earliestRegionStart) {
        const scanYearStart = new Date(Date.UTC(scanYear, 0, 1));
        earliestRegionStart = scanYearStart;
        console.log(
          `[explore] month scan yielded nothing despite year hit — using year start ${scanYearStart.toISOString().slice(0, 10)} as region`,
        );
        saveCheckpoint?.({
          phase: "collect",
          next_year: scanYear,
          month_scan_year: scanYear,
          next_month: 0,
          earliest_hit_year: scanYear,
          zero_streak: zeroStreak,
          deep_triggered: deepTriggered,
          allow_deep: allowDeep,
          earliest_region_start: earliestRegionStart.toISOString(),
          collect_window_start: earliestRegionStart.toISOString(),
          collect_span_days: COLLECT_INITIAL_SPAN_DAYS,
          collected_ids: [],
          zero_year_streak: 0,
          step_years: 1,
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

  // Stagnation state: restored from checkpoint so 429 resume retains the counter.
  const collectStagnationCount =
    cp?.phase === "collect" ? (cp.collect_stagnation_count ?? 0) : 0;
  const collectLastWindowKey =
    cp?.phase === "collect" ? (cp.collect_last_window_key ?? null) : null;

  // Build a full collect-phase checkpoint for the save callback.
  // pageState is set for mid-window page checkpoints; omitted for window-level checkpoints
  // (which clears collect_next_token, preventing stale resume state).
  const makeCollectCp = (
    nextWindowStart: Date,
    nextSpanDays: number,
    collectedIds: string[],
    pageState?: { windowEnd: Date; nextToken: string; pagesFetched: number },
    stagnation?: { count: number; lastWindowKey: string | null },
    splitQueue?: SplitWindow[],
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
    collect_stagnation_count: stagnation?.count ?? 0,
    collect_last_window_key: stagnation?.lastWindowKey ?? null,
    split_window_queue: splitQueue ?? [],
    zero_year_streak: 0,
    step_years: 1,
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
      initialStagnationCount: collectStagnationCount,
      initialLastWindowKey: collectLastWindowKey,
      resumeWindowEnd: collectResumeWindowEnd,
      resumeNextToken: collectResumeNextToken,
      resumePagesFetched: collectResumePagesFetched,
      resumeCheckpoint: cp || undefined, // Pass full checkpoint for split queue access
      // Window-level checkpoint: clears page-level fields (collect_next_token = null).
      saveWindowCheckpoint: saveCheckpoint
        ? (ws, sd, ids, stag, splitQ) => saveCheckpoint(makeCollectCp(ws, sd, ids, undefined, stag, splitQ))
        : undefined,
      // Page-level checkpoint: saves next_token so resume skips already-fetched pages.
      savePageCheckpoint: saveCheckpoint
        ? (ws, we, nt, pf, ids, sd, stag) =>
            saveCheckpoint(makeCollectCp(ws, sd, ids, { windowEnd: we, nextToken: nt, pagesFetched: pf }, stag, []))
        : undefined,
    },
  );
  let stopReason: StopReason = standardStop;

  // ── Phase C: Deep backfill (missing early period) ──

  let deepAddedCount = 0;

  // Don't start deep backfill when the main collect was already rate-limited:
  // the token is in cooldown and the very first deep API call would hit 429
  // again, burning one call from the budget for nothing.  The job will be
  // re-queued; deep backfill will run on the next resume once the token
  // recovers (standardStop won't be RATE_LIMIT then).
  if (deepTriggered && earliestHitYear > 0 && standardStop !== "RATE_LIMIT") {
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

  const storedNewCount = storeTweets(user.id, sorted, []); // Media already stored during incremental saves

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
  /** Stagnation counter to restore on resume (default 0). */
  initialStagnationCount?: number;
  /** Last window key to restore on resume (default null). */
  initialLastWindowKey?: string | null;
  /** Full checkpoint data for accessing split queue and other extended state. */
  resumeCheckpoint?: ExcavationCheckpoint;
  /**
   * Called after each completed window.
   * Args: nextWindowStart, nextSpanDays, all collected IDs so far, current stagnation state, split queue.
   */
  saveWindowCheckpoint?: (
    nextWindowStart: Date,
    nextSpanDays: number,
    collectedIds: string[],
    stag: { count: number; lastWindowKey: string | null },
    splitQueue?: SplitWindow[],
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
   * Args: windowStart, windowEnd, nextToken, pagesFetched, collectedIds (all so far), currentSpanDays, stagnation state.
   */
  savePageCheckpoint?: (
    windowStart: Date,
    windowEnd: Date,
    nextToken: string,
    pagesFetched: number,
    collectedIds: string[],
    currentSpanDays: number,
    stag: { count: number; lastWindowKey: string | null },
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
  // ── Separated state management ──────────────────────────────────────────
  
  // Normal window progression (independent of splits)
  let normalWindowStart = checkpointOpts?.resumeFrom ?? start;
  let normalWindowSpan = checkpointOpts?.initialSpanDays ?? COLLECT_INITIAL_SPAN_DAYS;
  
  // Split window queue (restored from checkpoint)
  let splitQueue: SplitWindow[] = [];
  if (checkpointOpts?.resumeFrom && checkpointOpts?.resumeCheckpoint?.split_window_queue) {
    splitQueue = [...checkpointOpts.resumeCheckpoint.split_window_queue];
  }
  
  // Track pending normal window advancement after split processing
  let pendingNormalWindowAdvancement: { to: Date; span: number } | null = null;
  
  // Note: Split parent tweets are no longer tracked - each window processes independently
  
  let stopReason: StopReason = "ACCOUNT_HAS_LESS_THAN_LIMIT";

  // True only for the very first window when a mid-window pagination token was saved.
  // After the first window completes (or if no token was saved), this is always false.
  let resumingMidWindow =
    checkpointOpts?.resumeFrom != null &&
    checkpointOpts?.resumeWindowEnd != null &&
    checkpointOpts?.resumeNextToken != null;

  // Stagnation detection: track consecutive same-window / stored_new=0 iterations.
  // Restored from checkpoint so state survives 429 suspensions.
  let stagnationCount = checkpointOpts?.initialStagnationCount ?? 0;
  let lastWindowKey: string | null = checkpointOpts?.initialLastWindowKey ?? null;
  
  if (checkpointOpts?.resumeFrom && (stagnationCount > 0 || lastWindowKey)) {
    console.log(
      `[collect] resuming stagnation state: count=${stagnationCount} lastKey=${lastWindowKey?.slice(0, 20)}...`,
    );
    
    // Force window shift if we resume with stagnation already at threshold.
    // Prevents infinite loops when checkpoint was saved mid-stagnation.
    if (stagnationCount >= STAGNATION_THRESHOLD) {
      console.log(
        `[collect][stagnation] forcing immediate window shift on resume (count=${stagnationCount} >= ${STAGNATION_THRESHOLD})`,
      );
      normalWindowStart = addDays(normalWindowStart, -normalWindowSpan);
      stagnationCount = 0;
      lastWindowKey = null;
    }
  }

  // If the resume point is at or past `end`, the collect phase is already done.
  if (normalWindowStart >= end) {
    console.log(
      `[collect] @${username} collect phase already complete (resumeFrom=${normalWindowStart.toISOString().slice(0, 10)} >= end=${end.toISOString().slice(0, 10)})`,
    );
    return "ACCOUNT_HAS_LESS_THAN_LIMIT";
  }

  if (checkpointOpts?.resumeFrom || splitQueue.length > 0) {
    if (resumingMidWindow) {
      console.log(
        `[collect] @${username} resuming mid-window=${normalWindowStart.toISOString().slice(0, 10)} next_token=${checkpointOpts?.resumeNextToken} pages_done=${checkpointOpts?.resumePagesFetched ?? "?"} already_have=${collected.size}`,
      );
    } else {
      console.log(
        `[collect] @${username} resuming: normal_window=${normalWindowStart.toISOString().slice(0, 10)} pending_splits=${splitQueue.length} already_have=${collected.size}`,
      );
    }
  }

  while (
    collected.size < collectLimit &&
    stats.totalCalls < callCeiling &&
    (splitQueue.length > 0 || normalWindowStart < end)
  ) {
    let currentWindowStart: Date;
    let currentWindowEnd: Date;
    let currentSpanDays: number;
    let isProcessingSplit: boolean;

    // ── Priority 1: Process pending split windows first ────────────────────
    if (splitQueue.length > 0) {
      const nextSplit = splitQueue.shift()!;
      currentWindowStart = new Date(nextSplit.start);
      currentWindowEnd = new Date(nextSplit.end);
      currentSpanDays = nextSplit.spanDays;
      isProcessingSplit = true;
      
      console.log(
        `[collect][split] @${username} processing child window=[${currentWindowStart.toISOString()}, ${currentWindowEnd.toISOString()}] ` +
        `spanDays=${currentSpanDays} remaining_splits=${splitQueue.length}`
      );
    } else {
      // ── Priority 2: Normal window (independent progression) ─────────────────
      
      // ── PENDING ADVANCEMENT: Only apply after ALL split processing is complete ──
      // Split が発生した窓は child A/B の解決完了まで future window に進めない
      if (pendingNormalWindowAdvancement && splitQueue.length === 0) {
        // ── STOP CHECK BEFORE PENDING ADVANCEMENT APPLICATION ─────────────────
        // Final validation before applying queued normal window advancement
        if (collected.size >= collectLimit) {
          stopReason = "OK_LIMIT_REACHED";
          console.log(
            `[collect] @${username} target reached before pending advancement (${collected.size} >= ${collectLimit}) — canceling future window advance`,
          );
          break;
        }
        if (stats.totalCalls >= callCeiling) {
          stopReason = "MAX_API_CALLS_REACHED";
          console.log(
            `[collect] @${username} API budget exhausted before pending advancement (${stats.totalCalls} >= ${callCeiling}) — canceling future window advance`,
          );
          break;
        }
        
        // Apply pending normal window advancement after ALL split processing completes
        normalWindowStart = pendingNormalWindowAdvancement.to;
        normalWindowSpan = pendingNormalWindowAdvancement.span;
        pendingNormalWindowAdvancement = null;
        console.log(
          `[collect] Applied pending normal window advancement to ${normalWindowStart.toISOString().slice(0, 10)} (post-split)`
        );
      } else if (pendingNormalWindowAdvancement && splitQueue.length > 0) {
        console.log(
          `[collect][split] @${username} deferring pending advancement until split processing completes (${splitQueue.length} child windows remaining)`,
        );
      }
      
      if (normalWindowStart >= end) break;
      
      currentWindowStart = normalWindowStart;
      currentWindowEnd = resumingMidWindow
        ? checkpointOpts!.resumeWindowEnd!
        : minDate(addDays(normalWindowStart, normalWindowSpan), end);
      currentSpanDays = normalWindowSpan;
      isProcessingSplit = false;
      
      console.log(
        `[collect] @${username} normal window=[${currentWindowStart.toISOString().slice(0, 10)}, ${currentWindowEnd.toISOString().slice(0, 10)}] spanDays=${currentSpanDays}`,
      );
    }

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

      // ── Dense-window split detection (only for normal windows) ──────────────
      if (!isProcessingSplit && page.nextToken && currentSpanDays >= MIN_SPLIT_SPAN_DAYS) {
        console.log(
          `[split] window=[${currentWindowStart.toISOString().slice(0, 10)}, ${currentWindowEnd.toISOString().slice(0, 10)}] spanDays=${currentSpanDays} next_token_present=true -> splitting`,
        );
        
        const mid = new Date((currentWindowStart.getTime() + currentWindowEnd.getTime()) / 2);
        
        // FIX: Prevent boundary overlap by advancing right window start by 1ms
        const rightStart = new Date(mid.getTime() + 1);
        
        const leftSpan = Math.ceil((mid.getTime() - currentWindowStart.getTime()) / (24 * 60 * 60 * 1000));
        const rightSpan = Math.ceil((currentWindowEnd.getTime() - rightStart.getTime()) / (24 * 60 * 60 * 1000));
        
        // Enqueue child windows (chronological order: left first)
        // Left: [start, mid] (inclusive), Right: [mid+1ms, end] (exclusive at boundary)
        splitQueue.push(
          {
            start: currentWindowStart.toISOString(),
            end: mid.toISOString(), 
            spanDays: leftSpan
          },
          {
            start: rightStart.toISOString(),
            end: currentWindowEnd.toISOString(),
            spanDays: rightSpan
          }
        );
        
        console.log(
          `[split] window=[${currentWindowStart.toISOString().slice(0, 10)}, ${currentWindowEnd.toISOString().slice(0, 10)}] -> [${currentWindowStart.toISOString().slice(0, 10)}, ${mid.toISOString().slice(0, 10)}], [${rightStart.toISOString().slice(0, 10)}, ${currentWindowEnd.toISOString().slice(0, 10)}]`,
        );
        
        // Store parent page1 tweets for historical record only (NOT collected)
        // Parent data is discarded; only child windows contribute to collection
        if (checkpointOpts?.userId && page.tweets.length > 0) {
          storeTweets(checkpointOpts.userId, page.tweets, page.media);
        }
        
        console.log(
          `[split][parent] Discarding ${page.tweets.length} parent tweets (split sample only) — child windows will handle collection`,
        );
        
        onProgress?.(stats.totalCalls);
        
        // FIX: Queue normal window advancement for after split processing completes
        pendingNormalWindowAdvancement = { to: currentWindowEnd, span: currentSpanDays };
        
        continue; // Process split queue next
      }

      // Normal processing path
      windowTweets.push(...page.tweets);
      nextToken = page.nextToken;
      pagesInWindow = 1;

      // Store page 1 tweets immediately so they survive a 429 on the next call.
      if (checkpointOpts?.userId && page.tweets.length > 0) {
        storeTweets(checkpointOpts.userId, page.tweets, page.media);
      }

      // Save page checkpoint BEFORE making the next API call (if more pages remain).
      if (nextToken && checkpointOpts?.savePageCheckpoint) {
        const pageCollectedIds = [
          ...collected.keys(),
          ...windowTweets.map((t) => t.id),
        ];
        checkpointOpts.savePageCheckpoint(
          currentWindowStart,
          currentWindowEnd,
          nextToken,
          pagesInWindow,
          pageCollectedIds,
          currentSpanDays,
          { count: stagnationCount, lastWindowKey },
        );
        console.log(
          `[checkpoint] COLLECT page saved next_token=${nextToken} exhausted=false pages=${pagesInWindow}`,
        );
      }

      // Rate limiting: delay before the next API call when more pages remain.
      if (nextToken) {
        await sleep(EXPLORE_INTER_REQUEST_DELAY_MS);
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
      nextToken = nextPage.nextToken;
      pagesInWindow++;

      // Store this page's tweets immediately for the same reason.
      if (checkpointOpts?.userId && nextPage.tweets.length > 0) {
        storeTweets(checkpointOpts.userId, nextPage.tweets, nextPage.media);
      }

      // Save page checkpoint when more pages remain.
      if (nextToken && checkpointOpts?.savePageCheckpoint) {
        const pageCollectedIds = [
          ...collected.keys(),
          ...windowTweets.map((t) => t.id),
        ];
        checkpointOpts.savePageCheckpoint(
          currentWindowStart,
          currentWindowEnd,
          nextToken,
          pagesInWindow,
          pageCollectedIds,
          currentSpanDays,
          { count: stagnationCount, lastWindowKey },
        );
        console.log(
          `[checkpoint] COLLECT page saved next_token=${nextToken} exhausted=false pages=${pagesInWindow}`,
        );
      }

      // Rate limiting: delay before the next API call when more pages remain.
      if (nextToken) {
        await sleep(EXPLORE_INTER_REQUEST_DELAY_MS);
      }
    }

    // If 429 (or another XApiStop) fired inside the pagination loop, the inner
    // `break` only exited the pagination while — the outer window loop would
    // otherwise continue, print a misleading "exhausted" line, advance
    // collectStart past the unfinished window, and overwrite the page-level
    // checkpoint with a window-level one.  Instead, exit the outer loop NOW so
    // the page checkpoint (saved just before the failed next-page call) stays
    // intact.  On resume the job will retry exactly from that next_token.
    if (stopReason && stopReason !== "ACCOUNT_HAS_LESS_THAN_LIMIT") {
      break;
    }

    const exhausted = !nextToken;
    console.log(
      `[collect] window yielded ${windowTweets.length} tweets (${pagesInWindow} pages, ${exhausted ? "exhausted" : "page-limit hit"})`,
    );

    const sizeBeforeWindow = collected.size;
    onProgress?.(stats.totalCalls);
    
    // Sort all window tweets by created_at (earliest first) for consistent processing
    const sortedTweets = windowTweets.sort((a, b) => 
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
    
    // Apply pure ID-based dedupe against collected tweets only
    let dedupeFiltered = 0;
    for (const t of sortedTweets) {
      if (!collected.has(t.id)) {
        collected.set(t.id, t);
      } else {
        dedupeFiltered++;
      }
    }
    const uniqueNew = collected.size - sizeBeforeWindow;
    
    // Enhanced debug logging for boundary analysis
    if (windowTweets.length > 0) {
      const firstTweet = windowTweets[0];
      const lastTweet = windowTweets[windowTweets.length - 1];
      console.log(
        `[collect][boundary] window=[${currentWindowStart.toISOString().slice(0, 10)}, ${currentWindowEnd.toISOString().slice(0, 10)}] ` +
        `tweets=${windowTweets.length} uniqueNew=${uniqueNew} dedupeFiltered=${dedupeFiltered} ` +
        `first=${firstTweet.created_at.slice(0, 19)} last=${lastTweet.created_at.slice(0, 19)} ` +
        `splitChild=${isProcessingSplit}`
      );
    }

    // ── Incremental storage — persist this window's tweets to DB so they
    //    survive a 429 suspend and can be reloaded on resume.
    // Note: Individual pages already stored with media, this is a safety net.
    if (checkpointOpts?.userId && windowTweets.length > 0) {
      storeTweets(checkpointOpts.userId, windowTweets, []); // Media already stored per-page
    }

    // ── Adaptive window sizing ─────────────────────────────────────────────
    // Grow aggressively on empty windows (sparse/early account) to reduce
    // wasted API calls. Shrink when the page cap is hit (dense period) so we
    // don't skip tweets on the earliest side.
    const clogged = !exhausted && pagesInWindow >= MAX_COLLECT_PAGES_PER_WINDOW;
    let adaptAction: string;
    let nextSpanDays: number;

    if (uniqueNew === 0) {
      nextSpanDays = Math.min(currentSpanDays * GROW_FACTOR_ZERO, COLLECT_MAX_SPAN_DAYS);
      adaptAction = "grow_zero";
    } else if (uniqueNew < TARGET_MIN_HITS) {
      nextSpanDays = Math.min(currentSpanDays * GROW_FACTOR_LOW, COLLECT_MAX_SPAN_DAYS);
      adaptAction = "grow_low";
    } else if (clogged) {
      nextSpanDays = Math.max(Math.floor(currentSpanDays * SHRINK_FACTOR_FULL), MIN_COLLECT_SPAN_DAYS);
      adaptAction = "shrink_full";
    } else {
      nextSpanDays = currentSpanDays;
      adaptAction = "keep";
    }

    // ── Budget cap: if close to the limit, shrink the next window so we don't
    // over-fetch and hit unnecessary 429s. Estimate required days from the
    // observed density (tweets/day this window) with 2× headroom.
    if (uniqueNew > 0 && collected.size < collectLimit) {
      const remaining = collectLimit - collected.size;
      const densityPerDay = uniqueNew / currentSpanDays;
      const estimatedDays = Math.ceil((remaining / densityPerDay) * 2);
      if (estimatedDays < nextSpanDays) {
        nextSpanDays = Math.max(estimatedDays, MIN_COLLECT_SPAN_DAYS);
        adaptAction += "+budget_cap";
      }
    }

    console.log(
      `[collect][adaptive] spanDays=${currentSpanDays} uniqueNew=${uniqueNew} pages=${pagesInWindow} exhausted=${exhausted} action=${adaptAction} nextSpanDays=${nextSpanDays}`,
    );

    // ── Stagnation detection ─────────────────────────────────────────────────
    const windowKey = makeWindowKey(currentWindowStart, currentWindowEnd);
    
    // On resume: if we have the same window key from checkpoint and stored_new=0,
    // continue the stagnation count instead of resetting it.
    if (windowKey === lastWindowKey && uniqueNew === 0) {
      stagnationCount++;
    } else if (uniqueNew > 0) {
      // Progress made → reset stagnation
      stagnationCount = 0;
      lastWindowKey = windowKey;
    } else {
      // Different window, no progress → start fresh stagnation tracking
      stagnationCount = uniqueNew === 0 ? 1 : 0;
      lastWindowKey = windowKey;
    }
    console.log(
      `[collect][stagnation] window=[${currentWindowStart.toISOString().slice(0, 10)}, ${currentWindowEnd.toISOString().slice(0, 10)}] stored_new=${uniqueNew} already_have=${sizeBeforeWindow} stagnation_count=${stagnationCount} key_match=${windowKey === lastWindowKey}`,
    );
    if (stagnationCount >= STAGNATION_THRESHOLD) {
      console.log(
        `[collect][stagnation] detected → shift window (count=${stagnationCount} window=${currentWindowStart.toISOString().slice(0, 10)}..${currentWindowEnd.toISOString().slice(0, 10)})`,
      );
      normalWindowStart = addDays(normalWindowStart, -normalWindowSpan);
      stagnationCount = 0;
      lastWindowKey = null;
      // Pass split queue via temporary extension
      const saveCheckpointWithSplitQueue = checkpointOpts?.saveWindowCheckpoint as any;
      if (saveCheckpointWithSplitQueue) {
        saveCheckpointWithSplitQueue(
          normalWindowStart,
          normalWindowSpan,
          [...collected.keys()],
          { count: 0, lastWindowKey: null },
          splitQueue,
        );
      }
      continue;
    }

    // ── STOP CHECK AFTER EACH SPLIT CHILD WINDOW ───────────────────────────
    // Check after each split child completes to prevent unnecessary processing
    if (isProcessingSplit) {
      if (collected.size >= collectLimit) {
        stopReason = "OK_LIMIT_REACHED";
        console.log(
          `[collect][split] @${username} target reached after child window (${collected.size} >= ${collectLimit}) — stopping split processing`,
        );
        break;
      }
      if (stats.totalCalls >= callCeiling) {
        stopReason = "MAX_API_CALLS_REACHED";
        console.log(
          `[collect][split] @${username} API budget exhausted after child window (${stats.totalCalls} >= ${callCeiling}) — stopping split processing`,
        );
        break;
      }
    }

    // ── Persist window completion BEFORE stop checks ───────────────────────
    // Advancing collectStart + saving the checkpoint here (rather than after
    // the break conditions) ensures that an unexpected interruption between
    // windows — e.g. a Next.js HMR reload that re-initialises the job queue
    // while the process is still alive — never leaves the checkpoint pointing
    // at the already-finished window. Without this, the job would re-fetch the
    // same window on every resume and loop forever.
    //
    // Safe for all exit paths:
    //   OK_LIMIT_REACHED    — checkpoint marks next window; break is clean.
    //   MAX_API_CALLS_REACHED — budget exhausted; any further resume starts
    //                          from the next window (tweets already stored).
    //   Normal continue     — was already done here before; no behaviour change.
    if (uniqueNew === 0 && collected.size > 0) {
      console.log(
        `[collect] @${username} window=[${currentWindowStart.toISOString().slice(0, 10)}, ${currentWindowEnd.toISOString().slice(0, 10)}] already processed (uniqueNew=0 have=${collected.size}) — advancing`,
      );
    }
    
    // Advance state appropriately
    if (!isProcessingSplit) {
      // Normal window completed → advance normal window pointer
      normalWindowStart = currentWindowEnd;
      normalWindowSpan = nextSpanDays; // from adaptive logic
    }
    // Split windows don't advance normal pointer (already advanced during split)
    
    // Pass split queue via temporary extension
    const saveCheckpointWithSplitQueue = checkpointOpts?.saveWindowCheckpoint as any;
    if (saveCheckpointWithSplitQueue) {
      saveCheckpointWithSplitQueue(
        normalWindowStart,
        normalWindowSpan,
        [...collected.keys()],
        { count: stagnationCount, lastWindowKey },
        splitQueue,
      );
    }

    // ── STOP CHECK BEFORE ANY ADVANCEMENT ───────────────────────────────────
    if (collected.size >= collectLimit) {
      stopReason = "OK_LIMIT_REACHED";
      break;
    }

    if (stats.totalCalls >= callCeiling) {
      stopReason = "MAX_API_CALLS_REACHED";
      break;
    }
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

    // Store tweets with media immediately
    if (page.tweets.length > 0) {
      storeTweets(user.id, page.tweets, page.media);
    }

    // Sort tweets by created_at (earliest first) for consistent processing
    const sortedPageTweets = page.tweets.sort((a, b) => 
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
    for (const t of sortedPageTweets) {
      if (!collected.has(t.id)) {
        collected.set(t.id, t);
      }
    }

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
      
      // Store paginated tweets with media immediately  
      if (page.tweets.length > 0) {
        storeTweets(user.id, page.tweets, page.media);
      }
      
      // Sort paginated tweets by created_at (earliest first) for consistent processing
      const sortedPaginatedTweets = page.tweets.sort((a, b) => 
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );
      for (const t of sortedPaginatedTweets) {
        if (!collected.has(t.id)) {
          collected.set(t.id, t);
        }
      }
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

  const storedNewCount = storeTweets(user.id, sorted, []); // Media already stored during incremental saves

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

/**
 * Create media JSON for storage by matching tweet attachments with expanded media objects.
 * Returns simplified format for efficient UI rendering.
 */
function createMediaJson(tweet: XTweet, mediaObjects: XMedia[]): string | null {
  if (!tweet.attachments?.media_keys || !mediaObjects.length) {
    return null;
  }

  const tweetMedia: Array<{
    type: string;
    url?: string;
    preview_image_url?: string;
    media_url_https?: string; // backwards compatibility with existing parseMedia
    width?: number;
    height?: number;
  }> = [];

  for (const mediaKey of tweet.attachments.media_keys) {
    const mediaObj = mediaObjects.find(m => m.media_key === mediaKey);
    if (mediaObj) {
      tweetMedia.push({
        type: mediaObj.type,
        url: mediaObj.url,
        preview_image_url: mediaObj.preview_image_url,
        media_url_https: mediaObj.url || mediaObj.preview_image_url, // fallback for compatibility
        width: mediaObj.width,
        height: mediaObj.height,
      });
    }
  }

  return tweetMedia.length > 0 ? JSON.stringify(tweetMedia) : null;
}

function storeTweets(userId: string, tweets: XTweet[], mediaObjects: XMedia[] = []): number {
  if (!tweets.length) return 0;
  const db = getDb();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO tweets (post_id, account_id, created_at, full_text, media_json, like_count, retweet_count, reply_count, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let newCount = 0;
  const tx = db.transaction(() => {
    for (const t of tweets) {
      const mediaJson = createMediaJson(t, mediaObjects);
      const r = insert.run(
        t.id,
        userId,
        t.created_at,
        t.text,
        mediaJson,
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

// ─── Stage Expansion Implementation (Phase 4) ─────────────────────────────

async function excavateStageExpansionInternal(
  user: XUser,
  query: string,
  targetLimit: number,
  baselineCount: number,
  targetStage: number,
  stats: ApiCallStats,
  onProgress?: (apiCalls: number) => void,
): Promise<ExcavationResult> {
  const accountCreated = new Date(user.created_at);
  const now = new Date(Date.now() - END_TIME_SAFETY_MS);
  
  console.log(
    `[excavate-expansion] @${user.username} Stage ${targetStage}: baseline=${baselineCount}, target=${targetLimit}, expanding by ${targetLimit - baselineCount}`
  );

  // Load existing tweets to avoid duplicates and build expansion from baseline
  const collected = new Map<string, XTweet>();
  const existingTweets = loadTweetsFromDbByAccount(user.id);
  for (const tweet of existingTweets) {
    collected.set(tweet.id, tweet);
  }

  console.log(
    `[excavate-expansion] Loaded ${collected.size} existing tweets as baseline for Stage ${targetStage}`
  );

  // Calculate how many additional tweets we need
  const additionalNeeded = targetLimit - collected.size;
  if (additionalNeeded <= 0) {
    console.log(
      `[excavate-expansion] Stage ${targetStage} target already satisfied with existing tweets`
    );
    return createExpansionResult(user, collected, targetLimit, baselineCount, targetStage, stats);
  }

  console.log(
    `[excavate-expansion] Need ${additionalNeeded} additional tweets for Stage ${targetStage}`
  );

  // Run expansion collection to get more tweets
  // This uses a similar approach to the main excavation but focuses on extending the existing set
  const expansionStop = await collectExpansionTweets(
    query,
    accountCreated,
    now,
    stats,
    collected,
    MAX_API_CALLS,
    additionalNeeded,
    user.username,
    onProgress,
    { userId: user.id }
  );

  console.log(
    `[excavate-expansion] Stage ${targetStage} expansion complete: collected=${collected.size}, stop=${expansionStop}`
  );

  return createExpansionResult(user, collected, targetLimit, baselineCount, targetStage, stats, expansionStop);
}

async function excavateStageExpansionTimeline(
  user: XUser,
  targetLimit: number,
  baselineCount: number,
  targetStage: number,
  stats: ApiCallStats,
  onProgress?: (apiCalls: number) => void,
): Promise<ExcavationResult> {
  console.log(
    `[excavate-expansion] @${user.username} Stage ${targetStage} timeline fallback — limited scope expansion`
  );

  // For timeline fallback, load existing tweets and try to extend via timeline API
  const collected = new Map<string, XTweet>();
  const existingTweets = loadTweetsFromDbByAccount(user.id);
  for (const tweet of existingTweets) {
    collected.set(tweet.id, tweet);
  }

  const additionalNeeded = targetLimit - collected.size;
  if (additionalNeeded <= 0) {
    return createExpansionResult(user, collected, targetLimit, baselineCount, targetStage, stats);
  }

  // Use timeline API to try to get additional tweets
  // This is a simplified expansion that works within timeline constraints
  try {
    const timelinePage = await getUserTweetsInWindow(
      user.id,
      user.created_at,
      new Date().toISOString(),
      stats,
    );

    // Store timeline tweets (they may include new tweets not in our baseline)
    if (timelinePage.tweets.length > 0) {
      storeTweets(user.id, timelinePage.tweets, timelinePage.media);
    }

    for (const tweet of timelinePage.tweets) {
      collected.set(tweet.id, tweet);
    }
  } catch (e) {
    console.log(`[excavate-expansion] Timeline expansion failed: ${e instanceof Error ? e.message : e}`);
  }

  return createExpansionResult(user, collected, targetLimit, baselineCount, targetStage, stats, "ACCOUNT_HAS_LESS_THAN_LIMIT");
}

async function collectExpansionTweets(
  query: string,
  accountCreated: Date,
  now: Date,
  stats: ApiCallStats,
  collected: Map<string, XTweet>,
  callCeiling: number,
  additionalNeeded: number,
  username: string,
  onProgress?: (apiCalls: number) => void,
  checkpointOpts?: { userId: string }
): Promise<StopReason> {
  // Use a time-based expansion approach to find additional tweets
  // We'll scan from account creation forward, focusing on periods we may have missed
  
  let stopReason: StopReason = "ACCOUNT_HAS_LESS_THAN_LIMIT";
  const startTime = accountCreated;
  const endTime = now;
  
  // Try to find additional tweets by scanning in larger time windows
  // This is a simplified expansion that focuses on finding tweets we missed
  let windowStart = startTime;
  let spanDays = 365; // Start with yearly windows
  
  while (
    collected.size < (collected.size + additionalNeeded) && 
    stats.totalCalls < callCeiling &&
    windowStart < endTime
  ) {
    const windowEnd = minDate(addDays(windowStart, spanDays), endTime);
    
    try {
      const page = await searchAllTweets(
        query,
        windowStart.toISOString(),
        windowEnd.toISOString(),
        stats,
        100,
        undefined,
        "recency",
      );

      if (page.tweets.length > 0) {
        // Store tweets immediately for persistence
        if (checkpointOpts?.userId) {
          storeTweets(checkpointOpts.userId, page.tweets, page.media);
        }

        // Add new tweets to collection (Map handles duplicates)
        for (const tweet of page.tweets) {
          collected.set(tweet.id, tweet);
        }

        console.log(
          `[expansion] Window [${windowStart.toISOString().slice(0, 10)}, ${windowEnd.toISOString().slice(0, 10)}]: +${page.tweets.length} tweets, total=${collected.size}`
        );
      }

      onProgress?.(stats.totalCalls);
      
      // Move to next window
      windowStart = windowEnd;
      
      // Break if we found enough
      if (page.tweets.length >= additionalNeeded) {
        stopReason = "OK_LIMIT_REACHED";
        break;
      }
      
    } catch (e) {
      if (e instanceof XApiStop) {
        stopReason = e.reason as StopReason;
        break;
      }
      throw e;
    }
    
    // Prevent tight loops
    await sleep(EXPLORE_INTER_REQUEST_DELAY_MS);
  }

  if (stats.totalCalls >= callCeiling) {
    stopReason = "MAX_API_CALLS_REACHED";
  }

  return stopReason;
}

function createExpansionResult(
  user: XUser, 
  collected: Map<string, XTweet>, 
  targetLimit: number,
  baselineCount: number, 
  targetStage: number, 
  stats: ApiCallStats,
  stopReason: StopReason = "OK_LIMIT_REACHED"
): ExcavationResult {
  // Sort tweets chronologically and take the earliest ones up to target
  const sorted = [...collected.values()]
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .slice(0, targetLimit);

  // Store the final sorted set
  const storedNewCount = storeTweets(user.id, sorted, []); // Media already stored during collection

  const actualStopReason = sorted.length >= targetLimit ? "OK_LIMIT_REACHED" : stopReason;

  console.log(
    `[excavate-expansion] @${user.username} Stage ${targetStage} complete: fetched=${sorted.length} target=${targetLimit} baseline=${baselineCount} new_stored=${storedNewCount} stop=${actualStopReason}`
  );

  return {
    username: user.username,
    userId: user.id,
    createdAt: user.created_at,
    requestedLimit: targetLimit,
    fetchedCount: sorted.length,
    stopReason: actualStopReason,
    apiCalls: stats.totalCalls,
    storedNewCount,
    errors: stats.errors,
    acquisitionMode: "full_archive",
  };
}

/**
 * Load tweets for an account from the database.
 * Used as baseline for stage expansions.
 */
function loadTweetsFromDbByAccount(accountId: string): XTweet[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT post_id AS id, created_at, full_text AS text,
              like_count, retweet_count, reply_count, media_json
       FROM tweets
       WHERE account_id = ?
       ORDER BY created_at ASC`
    )
    .all(accountId) as Array<{
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
