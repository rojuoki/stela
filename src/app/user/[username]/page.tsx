"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { notFound } from "next/navigation";
import type {
  TweetData,
  AccountData,
  AccountStatus,
  Status,
  JobPhase,
} from "../../../components/types";
import { EngagementChart } from "../../../components/EngagementChart";
import { TweetCard, tweetElementId } from "../../../components/TweetCard";
import { AccountHeader } from "../../../components/AccountHeader";
import { JobStatus } from "../../../components/JobStatus";
import { StatusBar } from "../../../components/StatusBar";
import { apiFetch } from "../../../lib/apiFetch";
import { useUser } from "../../../contexts/UserContext";

/** True only when the dev panel is enabled at build time. */
const DEV_PANEL = process.env.NEXT_PUBLIC_DEV_PANEL === "1";

const DUMMY_CHART_HEIGHTS = [35, 62, 48, 75, 30, 88, 55, 42, 70, 25, 60, 45, 82, 38, 67, 52, 90, 33, 58, 44];

const DUMMY_TWEET_STATS = [
  { likes: 47, retweets: 12, replies: 5 },
  { likes: 83, retweets: 7, replies: 2 },
  { likes: 21, retweets: 3, replies: 8 },
  { likes: 64, retweets: 18, replies: 4 },
  { likes: 9, retweets: 1, replies: 3 },
];

const POLL_INTERVAL_MS = 2500;
const MIN_EXCAVATING_MS = 3000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export default function UserPage() {
  const params = useParams();
  const router = useRouter();
  const searchParamsFromRouter = useSearchParams();
  const username = Array.isArray(params.username) ? params.username[0] : params.username;

  const rangeStartParam = searchParamsFromRouter.get("rangeStart");
  const rangeEndParam = searchParamsFromRouter.get("rangeEnd");
  const hasRangeParams = Boolean(rangeStartParam && rangeEndParam);
  const parsedRangeStart = hasRangeParams ? parseInt(rangeStartParam!, 10) : NaN;
  const parsedRangeEnd = hasRangeParams ? parseInt(rangeEndParam!, 10) : NaN;
  const rangeValid =
    hasRangeParams &&
    !Number.isNaN(parsedRangeStart) &&
    !Number.isNaN(parsedRangeEnd) &&
    parsedRangeStart > 0 &&
    parsedRangeEnd >= parsedRangeStart;
  /** Stable dependency so query-only navigations re-run the data effect (same page instance). */
  const rangeQueryKey = rangeValid ? `${parsedRangeStart}-${parsedRangeEnd}` : "full";

  // User context - MUST be called before any early returns
  const { user, credits, subscription, refreshCredits, loading: authLoading } = useUser();

  // Account state
  const [accountStatus, setAccountStatus] = useState<AccountStatus>("loading");
  const [accountData, setAccountData] = useState<AccountData | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [tweets, setTweets] = useState<TweetData[]>([]);
  const [jobInfo, setJobInfo] = useState<string>("");
  const [isAlreadyUnlocked, setIsAlreadyUnlocked] = useState(false);

  /** Prevents re-running unlock-status fetch for the same (user, account) pair (not in effect deps). */
  const unlockCheckKeyRef = useRef<string | null>(null);
  /** Prevents duplicate tweet fetches for the same account + range/full slice. */
  const tweetsFetchedKeyRef = useRef<string | null>(null);

  const [showExtendModal, setShowExtendModal] = useState(false);
  const [currentBoundary, setCurrentBoundary] = useState<number | null>(null);
  const [diamondActive, setDiamondActive] = useState<boolean>(false);
  const [showBackToTop, setShowBackToTop] = useState(false);

  // Excavation state management - replaces /excavating page functionality
  const [excavationState, setExcavationState] = useState<{
    active: boolean;
    flow: 'initial-cached' | 'initial' | 'extend-granted' | 'extend' | null;
    jobId: string | null;
    status: Status;
    jobPhase: JobPhase;
    jobInfo: string;
    error: string | null;
    resumeAt: string | null;
    startedAt: number;
    sessionData: any;
    resyncPhase: boolean; // New: track resync phase
  }>({
    active: false,
    flow: null,
    jobId: null,
    status: 'idle',
    jobPhase: null,
    jobInfo: '',
    error: null,
    resumeAt: null,
    startedAt: 0,
    sessionData: null,
    resyncPhase: false,
  });

  const scrollToTweetByPostId = useCallback((postId: string) => {
    const el = document.getElementById(tweetElementId(postId));
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  // Excavation helper functions - migrated from /excavating page
  const ensureMinTime = async (startTime: number) => {
    const elapsed = Date.now() - startTime;
    if (elapsed < MIN_EXCAVATING_MS) {
      await sleep(MIN_EXCAVATING_MS - elapsed);
    }
  };

  const navigateToResults = (
    targetUsername: string,
    rangeStart: number,
    rangeEnd: number,
  ) => {
    router.replace(
      `/user/${encodeURIComponent(targetUsername)}?rangeStart=${rangeStart}&rangeEnd=${rangeEnd}`,
    );
  };

  const exitExcavationMode = useCallback(() => {
    setExcavationState({
      active: false,
      flow: null,
      jobId: null,
      status: 'idle',
      jobPhase: null,
      jobInfo: '',
      error: null,
      resumeAt: null,
      startedAt: 0,
      sessionData: null,
      resyncPhase: false,
    });
  }, []);

  // Start resync phase after job completion - keeps excavation UI active
  const startResyncPhase = useCallback(() => {
    console.log('[excavation] Starting resync phase');
    setExcavationState(prev => ({
      ...prev,
      resyncPhase: true,
      status: 'running' as Status,
      jobPhase: null,
      jobInfo: 'Preparing results...',
    }));
    
    // Invalidate fetch guards to force data reload
    console.log('[excavation] Invalidating fetch guards');
    unlockCheckKeyRef.current = null;
    tweetsFetchedKeyRef.current = null;
    
    // The main data loading useEffect will handle the reload automatically
    // when the keys are invalidated and resyncPhase is added to dependencies
  }, []);

  // Job polling logic - migrated from /excavating page
  const pollJob = useCallback(async (jobId: string, onSuccess: (job: any) => void, signal?: AbortSignal) => {
    const tick = async (): Promise<void> => {
      if (signal?.aborted) return;
      
      try {
        const res = await apiFetch(`/api/jobs/${jobId}`);

        if (res.status === 404) {
          setExcavationState(prev => ({
            ...prev,
            status: "failed",
            error: "Job not found — may have expired",
            jobPhase: null,
          }));
          return;
        }

        if (!res.ok) {
          setExcavationState(prev => ({
            ...prev,
            jobInfo: `Polling error (HTTP ${res.status}) — retrying…`,
          }));
          await sleep(POLL_INTERVAL_MS);
          if (!signal?.aborted) return tick();
          return;
        }

        const job = await res.json();

        if (job.status === "succeeded") {
          setExcavationState(prev => ({
            ...prev,
            jobInfo: "Finishing up...",
          }));
          await ensureMinTime(excavationState.startedAt);
          refreshCredits();
          onSuccess(job);
          return;
        }

        if (job.status === "failed") {
          setExcavationState(prev => ({
            ...prev,
            status: "failed",
            error: job.error?.message || "Excavation failed",
            jobPhase: null,
            resumeAt: null,
          }));
          return;
        }

        if (job.status === "canceled") {
          setExcavationState(prev => ({
            ...prev,
            status: "failed",
            error: "Job was canceled",
            jobPhase: null,
          }));
          return;
        }

        if (job.status === "waiting_rate_limit") {
          setExcavationState(prev => ({
            ...prev,
            jobPhase: "waiting_rate_limit",
            resumeAt: job.resumeAt ?? null,
            jobInfo: `API calls: ${job.apiCalls}`,
          }));
        } else if (job.status === "queued") {
          setExcavationState(prev => ({
            ...prev,
            jobPhase: "queued",
            resumeAt: null,
            jobInfo: job.queuePosition != null
              ? `Position ${job.queuePosition} in queue — waiting for slot…`
              : `Waiting for slot…`,
          }));
        } else {
          setExcavationState(prev => ({
            ...prev,
            jobPhase: "running",
            resumeAt: null,
            jobInfo: `Excavating… (API calls: ${job.apiCalls})`,
          }));
        }

        await sleep(POLL_INTERVAL_MS);
        if (!signal?.aborted) return tick();
      } catch {
        setExcavationState(prev => ({
          ...prev,
          jobInfo: "Network error — retrying…",
        }));
        await sleep(POLL_INTERVAL_MS);
        if (!signal?.aborted) return tick();
      }
    };

    await tick();
  }, [excavationState.startedAt, refreshCredits]);

  // Flow handling logic - migrated from /excavating page
  const handleExtendGranted = useCallback(async () => {
    const raw = sessionStorage.getItem("stela-extend-result");
    sessionStorage.removeItem("stela-extend-result");

    if (!raw || !username) {
      setExcavationState(prev => ({
        ...prev,
        status: "failed",
        error: "Session expired. Please try again.",
        jobPhase: null,
      }));
      return;
    }

    let result: {
      boundary: { previous: number; new: number };
      range: { start: number; end: number; count: number; rangeString: string };
    };
    try {
      result = JSON.parse(raw);
    } catch {
      setExcavationState(prev => ({
        ...prev,
        status: "failed",
        error: "Invalid session data. Please try again.",
        jobPhase: null,
      }));
      return;
    }

    setExcavationState(prev => ({
      ...prev,
      jobInfo: `Processing ${result.range.count} posts...`,
    }));
    await ensureMinTime(excavationState.startedAt);
    refreshCredits();
    
    // For extend flows, navigate to range view and exit immediately
    // Range navigation will handle data loading
    navigateToResults(username, result.range.start, result.range.end);
    exitExcavationMode();
  }, [username, excavationState.startedAt, refreshCredits, exitExcavationMode]);

  const handleExtendJob = useCallback(async (jobId: string) => {
    setExcavationState(prev => ({
      ...prev,
      jobInfo: "Excavating additional posts...",
      jobPhase: "running",
    }));

    const raw = sessionStorage.getItem("stela-extend-result");
    let previousBoundary = 0;
    if (raw) {
      try {
        const data = JSON.parse(raw);
        previousBoundary = data.previousBoundary ?? 0;
      } catch { /* ignore */ }
      sessionStorage.removeItem("stela-extend-result");
    }

    await pollJob(jobId, (job) => {
      const prevBound = job.result?.previousBoundary ?? previousBoundary;
      const finalBound = job.result?.finalBoundary ?? prevBound;
      
      // Navigate to range view and exit excavation mode
      navigateToResults(username!, prevBound + 1, finalBound);
      exitExcavationMode();
    });
  }, [username, pollJob, exitExcavationMode]);

  const handleInitialCached = useCallback(async () => {
    setExcavationState(prev => ({
      ...prev,
      jobInfo: "Unlocking...",
    }));
    await ensureMinTime(excavationState.startedAt);
    refreshCredits();
    
    // Start resync phase instead of exiting immediately
    startResyncPhase();
  }, [excavationState.startedAt, refreshCredits, startResyncPhase]);

  const handleInitialJob = useCallback(async (jobId: string) => {
    setExcavationState(prev => ({
      ...prev,
      jobInfo: "Excavating earliest posts...",
      jobPhase: "running",
    }));

    await pollJob(jobId, () => {
      // Start resync phase instead of exiting immediately
      startResyncPhase();
    });
  }, [pollJob, startResyncPhase]);

  // Main excavation flow orchestration - migrated from /excavating page useEffect
  useEffect(() => {
    if (!excavationState.active || !username) return;

    const { flow, jobId } = excavationState;

    if (flow === "extend-granted") {
      handleExtendGranted();
    } else if (flow === "extend" && jobId) {
      handleExtendJob(jobId);
    } else if (flow === "initial-cached") {
      handleInitialCached();
    } else if (flow === "initial" && jobId) {
      handleInitialJob(jobId);
    } else if (!jobId && (flow === "initial" || flow === "extend")) {
      // Missing jobId for flows that require it
      setExcavationState(prev => ({
        ...prev,
        status: "failed",
        error: "Missing job ID",
        jobPhase: null,
      }));
    }
  }, [excavationState.active, excavationState.flow, excavationState.jobId, username, 
      handleExtendGranted, handleExtendJob, handleInitialCached, handleInitialJob]);

  // Detect resync completion and exit excavation mode
  useEffect(() => {
    if (!excavationState.resyncPhase) return;
    
    console.log('[excavation] Checking resync completion:', {
      isAlreadyUnlocked,
      tweetsLength: tweets.length,
      hasResults: tweets.length > 0,
    });
    
    // Define conditions for resync completion
    const resyncComplete = (
      isAlreadyUnlocked &&   // Unlock status loaded and account is unlocked
      tweets.length > 0      // Tweets loaded and available
    );
    
    if (resyncComplete) {
      console.log('[excavation] Resync complete, exiting excavation mode');
      exitExcavationMode();
      return;
    }
    
    // Fallback timeout to prevent getting stuck in resync
    const fallbackTimeout = setTimeout(() => {
      console.log('[excavation] Resync timeout, forcing exit');
      exitExcavationMode();
    }, 5000); // 5 second fallback
    
    return () => clearTimeout(fallbackTimeout);
  }, [excavationState.resyncPhase, isAlreadyUnlocked, tweets.length, exitExcavationMode]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (excavationState.active) {
        sessionStorage.removeItem("stela-extend-result");
      }
    };
  }, [excavationState.active]);

  // Function to start excavation - replaces router.push('/excavating?...')
  const startExcavation = useCallback((
    flow: 'initial-cached' | 'initial' | 'extend-granted' | 'extend',
    jobId?: string,
    sessionData?: any
  ) => {
    setExcavationState({
      active: true,
      flow,
      jobId: jobId || null,
      status: 'running',
      jobPhase: jobId ? 'running' : null,
      jobInfo: 'Starting...',
      error: null,
      resumeAt: null,
      startedAt: Date.now(),
      sessionData: sessionData || null,
      resyncPhase: false,
    });
  }, []);

  if (!username || typeof username !== "string") {
    notFound();
  }

  const handleExcavateMore = async () => {
    if (!accountData || !user || credits <= 0) return;

    setShowExtendModal(false);
    setError(null);

    try {
      const res = await apiFetch("/api/unlock/extend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: accountData.username }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || `HTTP ${res.status}`);
        return;
      }

      const extendResponse = await res.json();

      // Start in-page excavation instead of redirecting
      if (extendResponse.executionMode === "grant_only") {
        sessionStorage.setItem("stela-extend-result", JSON.stringify({
          boundary: extendResponse.boundary,
          range: extendResponse.range,
        }));
        startExcavation('extend-granted', undefined, {
          boundary: extendResponse.boundary,
          range: extendResponse.range,
        });
      } else if (extendResponse.executionMode === "excavate_more") {
        sessionStorage.setItem("stela-extend-result", JSON.stringify({
          previousBoundary: extendResponse.planning.currentVisibleBoundary,
        }));
        startExcavation('extend', extendResponse.jobId, {
          previousBoundary: extendResponse.planning.currentVisibleBoundary,
        });
      }
    } catch {
      setError("Network error");
    }
  };

  const loadAccount = async () => {
    const cleanUsername = username.trim().replace(/^@/, "").toLowerCase();

    if (cleanUsername.length < 3) {
      setAccountStatus("error");
      setAccountError("Username must be at least 3 characters");
      return;
    }

    setAccountStatus("loading");
    setAccountData(null);
    setAccountError(null);

    try {
      const res = await apiFetch(
        `/api/account?username=${encodeURIComponent(cleanUsername)}`,
      );
      const data = await res.json();

      if (!res.ok) {
        if (res.status === 404) {
          notFound();
        }
        setAccountStatus("error");
        setAccountError(data.error || `HTTP ${res.status}`);
        return;
      }

      setAccountStatus("found");
      setAccountData(data);
    } catch {
      setAccountStatus("error");
      setAccountError("Network error");
    }
  };

  const loadTweets = async (accountId: string, rangeStart?: number, rangeEnd?: number): Promise<TweetData[]> => {
    let url = `/api/tweets/${accountId}`;
    if (rangeStart !== undefined && rangeEnd !== undefined) {
      url += `?rangeStart=${rangeStart}&rangeEnd=${rangeEnd}`;
    }
    const res = await apiFetch(url);
    if (res.ok) {
      const data = await res.json();
      return data.tweets || [];
    }
    return [];
  };

  // Load account on mount and check for range mode
  useEffect(() => {
    if (username) {
      loadAccount();
      refreshCredits();
    }
  }, [username]);

  // Guest range deep-links + logged-in unlock check + one tweet load (no polling; refs dedupe).
  useEffect(() => {
    if (!accountData) return;
    if (authLoading) return;

    let cancelled = false;

    const rangeStart = rangeValid ? parsedRangeStart : undefined;
    const rangeEnd = rangeValid ? parsedRangeEnd : undefined;

    const tweetFetchKey = (accountId: string, rs?: number, re?: number) =>
      rs != null && re != null ? `${accountId}:${rs}:${re}` : `${accountId}:full`;

    const applyTweetResult = (
      loadedTweets: TweetData[],
      jobInfoFor: (n: number) => string,
      boundary?: number,
    ) => {
      if (cancelled) return;
      setTweets(loadedTweets);
      if (loadedTweets.length === 0) return;
      setJobInfo(jobInfoFor(loadedTweets.length));
      if (boundary !== undefined) setCurrentBoundary(boundary);
    };

    const fetchTweetsOnce = async (
      accountId: string,
      rs: number | undefined,
      re: number | undefined,
      jobInfoFor: (n: number) => string,
      boundary?: number,
    ) => {
      const key = tweetFetchKey(accountId, rs, re);
      if (tweetsFetchedKeyRef.current === key) {
        console.log('[excavation] Skipping tweet fetch - already fetched');
        return;
      }
      tweetsFetchedKeyRef.current = key;
      console.log('[excavation] Fetching tweets, resyncPhase:', excavationState.resyncPhase);
      const loaded = await loadTweets(accountId, rs, re);
      console.log('[excavation] Loaded tweets:', loaded.length);
      applyTweetResult(loaded, jobInfoFor, boundary);
    };

    // Guest: load range from URL only (no unlock API).
    if (!user) {
      if (rangeValid) {
        void fetchTweetsOnce(
          accountData.account_id,
          rangeStart,
          rangeEnd,
          (n) => `${n} posts · showing ${rangeStart}-${rangeEnd}`,
          rangeEnd,
        );
      }
      return () => {
        cancelled = true;
      };
    }

    const unlockKey = `${user.id}:${accountData.account_id}`;
    if (unlockCheckKeyRef.current === unlockKey) {
      console.log('[excavation] Skipping unlock check - already checked');
      return () => {
        cancelled = true;
      };
    }
    unlockCheckKeyRef.current = unlockKey;
    console.log('[excavation] Starting unlock status check, resyncPhase:', excavationState.resyncPhase);

    void (async () => {
      try {
        const res = await apiFetch(
          `/api/account/unlock-status?username=${encodeURIComponent(accountData.username)}`,
        );
        if (cancelled) return;
        const data = await res.json();
        console.log('[unlock-status response]', JSON.stringify(data, null, 2));
        if (cancelled) return;
        if (!data.unlocked) return;

        setIsAlreadyUnlocked(true);
        setCurrentBoundary(data.boundaryEnd || data.count || 100);
        setDiamondActive(data.diamondActive || false);

        const rs = rangeValid ? rangeStart : undefined;
        const re = rangeValid ? rangeEnd : undefined;

        await fetchTweetsOnce(
          data.accountId,
          rs,
          re,
          (n) =>
            rangeValid
              ? `${n} posts · showing ${rangeStart}-${rangeEnd}`
              : `${n} posts`,
          rangeValid ? rangeEnd : undefined,
        );
      } catch (error) {
        if (!cancelled) console.error("Failed to check unlock status:", error);
      }
    })();

    return () => {
      cancelled = true;
      unlockCheckKeyRef.current = null;
    };
  }, [
    authLoading,
    user?.id,
    accountData?.account_id,
    accountData?.username,
    excavationState.active,
    excavationState.resyncPhase,
    rangeQueryKey,
  ]);

  // Handle scroll for back to top visibility
  useEffect(() => {
    const handleScroll = () => {
      setShowBackToTop(window.scrollY > 300);
    };

    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const handleExcavate = async (force = false) => {
    if (!accountData || accountData.protected) return;

    const raw = username.trim().replace(/^@/, "");
    if (!raw) return;

    setError(null);

    try {
      const res = await apiFetch("/api/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: raw, force }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || `HTTP ${res.status}`);
        return;
      }

      const unlock = await res.json();

      // Start in-page excavation instead of redirecting
      if (!force && unlock.status === "cache-hit" && unlock.accountId) {
        startExcavation('initial-cached');
      } else if (unlock.jobId) {
        startExcavation('initial', unlock.jobId);
      }
    } catch {
      setError("Network error");
    }
  };

  // Handle "Unlock for $4" button - guest purchase via Stripe
  const handleUnlockForPrice = async () => {
    if (!accountData || accountData.protected) return;

    setError(null);

    try {
      // Dev/prod分岐
      const isDev = process.env.NODE_ENV === 'development';

      if (isDev) {
        // 開発環境: 既存プレースホルダー維持
        const res = await apiFetch("/api/purchase/guest-unlock", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: accountData.username,
            returnUrl: window.location.href
          }),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setError(data.error || `Failed to unlock: HTTP ${res.status}`);
          return;
        }

        const unlockData = await res.json();

        if (unlockData.redirectUrl) {
          window.location.href = unlockData.redirectUrl;
        } else if (unlockData.resultToken) {
          router.push(`/results/${unlockData.resultToken}`);
        } else {
          setError("Unexpected response from server");
        }
      } else {
        // 本番環境: Stripe Checkout (guest unlock)
        const response = await fetch("/api/checkout/unlock", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: accountData.username }),
        });

        if (response.ok) {
          const { checkoutUrl } = await response.json();
          window.location.href = checkoutUrl;
        } else {
          const data = await response.json();
          setError(data.error || "Checkout failed");
        }
      }
    } catch (err) {
      setError('Network error. Please try again.');
    }
  };

  if (!accountData && accountStatus === "loading") {
    return (
      <main className="max-w-2xl mx-auto px-4 py-12">
        <div className="mb-8">
          <Link
            href="/"
            className="cursor-pointer text-zinc-400 hover:text-white transition-colors text-sm inline-flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            Back to Stela
          </Link>
        </div>
        <div className="text-center py-16">
          <p className="text-zinc-400">Loading account information...</p>
        </div>
      </main>
    );
  }

  if (accountStatus === "error" || !accountData) {
    return (
      <main className="max-w-2xl mx-auto px-4 py-12">
        <div className="mb-8">
          <Link
            href="/"
            className="cursor-pointer text-zinc-400 hover:text-white transition-colors text-sm inline-flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            Back to Stela
          </Link>
        </div>
        <div className="text-center py-16">
          <div className="mb-6">
            <svg
              className="w-16 h-16 mx-auto text-zinc-600 mb-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M9.172 16.172a4 4 0 015.656 0M9 12h6m-6 0a9 9 0 1118 0 9 9 0 01-18 0z"
              />
            </svg>
            <h1 className="text-2xl font-bold text-zinc-300 mb-2">Account Not Found</h1>
            <p className="text-zinc-500 mb-6">
              {accountError || "This account could not be found, may be protected, or has been suspended."}
            </p>
          </div>

          <div className="space-y-4">
            <Link
              href="/"
              className="cursor-pointer inline-flex items-center gap-2 bg-white text-black font-semibold px-6 py-3 rounded-lg hover:bg-zinc-200 transition-colors"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              Search for Another Account
            </Link>
          </div>
        </div>
      </main>
    );
  }

  const displayName = accountData.display_name || `@${accountData.username}`;
  const hasResults = tweets.length > 0;

  const isLoggedIn = !!user; // Check if user is authenticated

  // Excavation UI component - replaces /excavating page
  const ExcavationUI = () => {
    if (!excavationState.active) return null;

    const isError = excavationState.status === "failed";

    return (
      <div className="min-h-screen bg-black">
        <div className="max-w-2xl mx-auto px-4 py-12">
          <div className="mb-8">
            <Link
              href={username ? `/user/${encodeURIComponent(username)}` : "/"}
              onClick={(e) => {
                e.preventDefault();
                exitExcavationMode();
              }}
              className="text-zinc-400 hover:text-white transition-colors text-sm inline-flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
              </svg>
              Back to @{username || "Stela"}
            </Link>
          </div>

          {username && (
            <div className="mb-6 text-center">
              <h1 className="text-xl font-bold text-white">@{username}</h1>
              <p className="text-sm text-zinc-500 mt-1">
                {excavationState.flow?.startsWith("extend") ? "Additional excavation" : "Excavating earliest posts"}
              </p>
            </div>
          )}

          {!isError && (
            <JobStatus
              status={excavationState.status}
              jobPhase={excavationState.resyncPhase ? null : excavationState.jobPhase}
              jobInfo={excavationState.jobInfo}
              error={null}
              credits={credits}
              cacheHit={false}
              resumeAt={excavationState.resumeAt}
            />
          )}

          <div className="border border-zinc-800 rounded-xl min-h-[200px] flex items-center justify-center">
            {isError ? (
              <div className="text-center px-6 max-w-md">
                <svg
                  className="w-12 h-12 mx-auto text-red-500 mb-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"
                  />
                </svg>
                <p className="text-red-300 font-medium mb-2">{excavationState.error}</p>
                <button
                  onClick={exitExcavationMode}
                  className="mt-4 bg-zinc-800 text-zinc-300 font-medium px-4 py-2 rounded-lg hover:bg-zinc-700 transition-colors"
                >
                  Go back
                </button>
              </div>
            ) : (
              <div className="text-center">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white mx-auto mb-4" />
                <p className="text-zinc-400 text-sm">
                  {excavationState.resyncPhase ? "Preparing results..." : (excavationState.jobInfo || "Excavating...")}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  // Determine if user can unlock (has credits OR basic subscription)
  const canUnlock = isLoggedIn && (credits > 0 || subscription.plan === 'basic');

  const isRangeMode = rangeValid;

  // Function to show full range (clear range params)
  const showFullRange = () => {
    if (accountData) {
      router.replace(`/user/${username}`, { scroll: false });
      tweetsFetchedKeyRef.current = `${accountData.account_id}:full`;
      loadTweets(accountData.account_id).then((loadedTweets) => {
        setTweets(loadedTweets);
        const boundary = currentBoundary || loadedTweets.length;
        setJobInfo(`${loadedTweets.length} posts • showing 1-${boundary}`);
      });
    }
  };

  // Show excavation UI when in excavation mode
  if (excavationState.active) {
    return <ExcavationUI />;
  }

  return (
    <main className="max-w-2xl mx-auto px-4 py-12">
      {/* Navigation */}
      <div className="mb-8">
        <Link
          href="/"
          className="cursor-pointer text-zinc-400 hover:text-white transition-colors text-sm inline-flex items-center gap-2"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          Back to Stela
        </Link>
      </div>

      {/* Account Header & Excavation CTA - always visible */}
      <div className={hasResults ? "sticky top-0 z-20 -mx-4 px-4 py-2 bg-black/80 backdrop-blur-sm mb-0" : "mb-4"}>
        <AccountHeader
          status={accountStatus}
          data={accountData}
          error={accountError}
        />

        {/* Excavate More CTA - part of sticky header group */}
        {isLoggedIn && hasResults && (
          <div className="text-center mt-0.5">
            <button
              onClick={() => setShowExtendModal(true)}
              disabled={credits <= 0}
              className={`text-xs underline transition-colors ${
                credits <= 0
                  ? "text-zinc-500 cursor-not-allowed"
                  : "cursor-pointer text-zinc-400 hover:text-zinc-200"
              }`}
            >
              ⛏️ Excavate more 🧨   +100 posts for 1 credit
            </button>
          </div>
        )}

        {/* Back to Top Control - appears after scrolling */}
        {showBackToTop && hasResults && (
          <div className="text-center mt-0.5">
            <button
              onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
              className="cursor-pointer text-xs text-zinc-500 opacity-60 hover:opacity-100 transition-opacity inline-flex items-center gap-1"
              aria-label="Back to top"
            >
              <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 12 12">
                <path d="M6 2L2 6h2.5v4h3V6H10L6 2z"/>
              </svg>
              Back to top
            </button>
          </div>
        )}
      </div>

      {/* Preview Phase */}
      {!hasResults && (
        <>
          {/* StatusBar for preview state */}
          {accountData.protected ? (
            <div className="flex items-center gap-2 text-orange-300 text-sm px-4 py-3 bg-orange-900/20 border border-orange-800/50 rounded-lg mb-6">
              <svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 616 0z" clipRule="evenodd" />
              </svg>
              This account is protected and cannot be excavated.
            </div>
          ) : canUnlock ? (
            <>
              {isAlreadyUnlocked ? (
                <StatusBar
                  status="done"
                  creditCount={credits}
                  subMessage="Account previously unlocked and ready for viewing"
                  actionButton={
                    DEV_PANEL ? (
                      <button
                        onClick={() => handleExcavate(true)}
                        className="cursor-pointer bg-zinc-800 text-white font-medium px-4 py-2 rounded-lg hover:bg-zinc-700 transition-colors border border-zinc-600"
                      >
                        Re-run Excavation
                      </button>
                    ) : undefined
                  }
                />
              ) : (
                <StatusBar
                  status="ready"
                  creditCount={credits}
                  subMessage="Ready to discover the earliest posts from this timeline"
                  actionButton={
                    <button
                      onClick={() => handleExcavate(false)}
                      className="cursor-pointer bg-white text-black font-medium px-6 py-1.5 rounded-full hover:bg-gray-100 transition-all text-sm"
                    >
                      Excavate Earliest Posts
                    </button>
                  }
                />
              )}
            </>
          ) : (
            <StatusBar
              status="ready"
              creditCount={0}
              subMessage="One-time unlock to access the earliest posts from this account"
              actionButton={
                <div className="flex items-center gap-3">
                  <button
                    onClick={handleUnlockForPrice}
                    className="cursor-pointer bg-white text-black font-medium px-6 py-1.5 rounded-full hover:bg-gray-100 transition-all text-sm"
                  >
                    Unlock for $4
                  </button>
                  {!isLoggedIn && (
                    <Link
                      href="/login"
                      className="cursor-pointer text-zinc-300 hover:text-white text-sm underline"
                    >
                      Sign in
                    </Link>
                  )}
                </div>
              }
            />
          )}

          {/* Error display */}
          {error && (
            <div className="mb-6 flex items-center gap-2 text-red-300 text-sm px-4 py-3 bg-red-900/20 border border-red-800/50 rounded-lg">
              <svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
              {error}
            </div>
          )}

          {/* Blurred result zone */}
          <div className="relative mb-8">
            {/* Blurred Engagement Chart */}
            <div className="mb-6">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">
                  Engagement across earliest posts
                </h2>
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-sm inline-block bg-blue-500" />
                    <span className="text-[10px] text-zinc-500">Likes</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="w-3 h-0.5 inline-block rounded bg-emerald-500" />
                    <span className="text-[10px] text-zinc-500">Retweets</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="w-3 h-0.5 inline-block rounded bg-amber-500" />
                    <span className="text-[10px] text-zinc-500">Replies</span>
                  </div>
                </div>
              </div>

              <div className="relative h-24 bg-zinc-900 rounded-lg border border-zinc-800 p-2 blur-sm">
                <div className="flex items-end gap-px h-full">
                  {DUMMY_CHART_HEIGHTS.map((h, i) => (
                    <div
                      key={i}
                      className="flex-1 bg-blue-500 rounded-t-sm"
                      style={{ height: `${h}%` }}
                    />
                  ))}
                </div>
              </div>
            </div>

            {/* Blurred Tweet List */}
            <div className="border border-zinc-800 rounded-xl overflow-hidden blur-sm">
              {DUMMY_TWEET_STATS.map((stats, i) => (
                <div key={i} className="px-4 py-3 border-b border-zinc-800 last:border-b-0">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-xs text-zinc-500">Mar {i + 1}, 2009</span>
                  </div>
                  <p className="text-sm text-zinc-200 mb-2">
                    {i === 0 && "This is where you'll see the earliest posts from this account's timeline..."}
                    {i === 1 && "Discover authentic thoughts and interactions from the very beginning..."}
                    {i === 2 && "Uncover the origins and evolution of their online presence..."}
                    {i === 3 && "See how their voice and perspective developed over time..."}
                    {i === 4 && "Experience the full journey from their first posts to today..."}
                  </p>
                  <div className="flex gap-4 text-xs text-zinc-500">
                    <span className="flex items-center gap-1">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                      </svg>
                      {stats.likes}
                    </span>
                    <span className="flex items-center gap-1">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="17 1 21 5 17 9" />
                        <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                        <polyline points="7 23 3 19 7 15" />
                        <path d="M21 13v2a4 4 0 0 1-4 4H3" />
                      </svg>
                      {stats.retweets}
                    </span>
                    <span className="flex items-center gap-1">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                      </svg>
                      {stats.replies}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            {/* Discover overlay - text only, centered over blurred zone */}
            <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
              <div className="text-center max-w-sm px-6">
                <p className="text-base font-semibold text-white drop-shadow-lg mb-3">
                  Discover earliest posts from {displayName}
                </p>
                <p className="text-sm text-zinc-300 drop-shadow mb-2 leading-relaxed">
                  Explore the earliest posts from {displayName}'s timeline.
                  Uncover their first thoughts, early interactions, and the origins
                  of their presence on X.
                </p>
                <p className="text-sm text-zinc-400 drop-shadow leading-relaxed">
                  Excavation reveals up to 100 of the earliest posts, providing
                  unique insights into an account's history and evolution over time.
                </p>
              </div>
            </div>
          </div>

          {/* SEO Content - About Timeline Excavation */}
          <div className="pt-8 border-t border-zinc-800">
            <h3 className="text-lg font-semibold mb-4">About Timeline Excavation</h3>
            <div className="space-y-4 text-sm text-zinc-400">
              <p>
                <strong className="text-zinc-300">What is excavation?</strong><br />
                Timeline excavation uses advanced techniques to discover and retrieve
                the earliest posts from an account's history, even when they're buried
                deep in the timeline.
              </p>
              <p>
                <strong className="text-zinc-300">Why earliest posts?</strong><br />
                Early posts often reveal authentic thoughts, genuine interactions, and
                the evolution of ideas before accounts became widely followed.
              </p>
              <p>
                <strong className="text-zinc-300">How it works:</strong><br />
                Our system searches through years of posts to find and present
                the chronologically oldest content, providing a unique window into
                an account's origins.
              </p>
            </div>
          </div>
        </>
      )}

      {/* Results Phase */}
      {hasResults && (
        <>
          <StatusBar
            status="done"
            postCount={tweets.length}
            postRange={isRangeMode ? `${parsedRangeStart}-${parsedRangeEnd}` : undefined}
            creditCount={credits}
            subMessage={
              diamondActive ? (
                <>💎 Congratulations! You've excavated all available posts.</>
              ) : (
                "Timeline successfully excavated and ready for exploration"
              )
            }
            subMessageStyle={
              diamondActive ? {
                color: "text-amber-600/95",
                weight: "font-bold"
              } : undefined
            }
          />

          {error && (
            <div className="mb-4 flex items-center gap-2 text-red-300 text-sm px-4 py-3 bg-red-900/20 border border-red-800/50 rounded-lg">
              <svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
              {error}
            </div>
          )}

          {/* Range Mode Indicator */}
          {isRangeMode && (
            <div className="mb-4 flex items-center justify-center">
              <div className="bg-blue-950/30 border border-blue-800/50 rounded-lg px-4 py-2 text-sm">
                <span className="text-blue-400">Showing newly unlocked range</span>
                <button
                  onClick={showFullRange}
                  className="cursor-pointer ml-3 text-blue-300 hover:text-blue-200 underline text-xs"
                >
                  Show all posts
                </button>
              </div>
            </div>
          )}

          {/* Guest Account Creation Prompt - only for guest users with results */}
          {!user && hasResults && (
            <div className="mb-6 bg-gradient-to-r from-blue-900/20 to-purple-900/20 border border-blue-800/50 rounded-xl p-6">
              <div className="text-center">
                <div className="w-12 h-12 bg-gradient-to-r from-blue-500 to-purple-500 rounded-full flex items-center justify-center mx-auto mb-4">
                  <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
                  </svg>
                </div>
                <h3 className="text-lg font-semibold mb-2 text-white">Create a free account to save your unlock</h3>
                <p className="text-sm text-zinc-400 mb-4 max-w-md mx-auto">
                  This unlock will be saved to your account so you can access it anytime.
                  Plus you'll get 4 free credits to unlock more accounts.
                </p>
                <div className="flex items-center justify-center gap-3">
                  <Link
                    href={`/signup?returnTo=${encodeURIComponent(`/user/${username}`)}`}
                    className="cursor-pointer bg-gradient-to-r from-blue-600 to-purple-600 text-white font-semibold px-6 py-3 rounded-lg hover:from-blue-700 hover:to-purple-700 transition-all"
                  >
                    Create Account
                  </Link>
                  <Link
                    href={`/login?returnTo=${encodeURIComponent(`/user/${username}`)}`}
                    className="cursor-pointer bg-zinc-800 text-white font-semibold px-6 py-3 rounded-lg hover:bg-zinc-700 transition-colors border border-zinc-600"
                  >
                    Sign In
                  </Link>
                </div>
              </div>
            </div>
          )}

          {/* Engagement Chart */}
          {hasResults && (
            <EngagementChart
              tweets={tweets}
              onBarSelect={scrollToTweetByPostId}
              heading={
                isRangeMode
                  ? `Engagement for posts ${parsedRangeStart}–${parsedRangeEnd}`
                  : undefined
              }
            />
          )}

          {/* Tweet list */}
          {hasResults ? (
            <div className="border border-zinc-800 rounded-xl overflow-hidden">
              {tweets.map((t) => (
                <TweetCard key={t.post_id} tweet={t} />
              ))}
            </div>
          ) : (
            <div className="border border-zinc-800 rounded-xl min-h-[200px] flex items-center justify-center">
              <p className="text-zinc-600 text-sm">No posts found.</p>
            </div>
          )}

          {/* Dev-only: Re-run excavation */}
          {hasResults && DEV_PANEL && (
            <div className="mt-8 text-center">
              <button
                onClick={() => handleExcavate(true)}
                className="cursor-pointer inline-flex items-center gap-2 bg-zinc-800 text-zinc-200 font-semibold px-4 py-2 rounded-lg hover:bg-zinc-700 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Re-run Excavation
              </button>
            </div>
          )}
        </>
      )}

      {/* Excavate More Confirmation Modal */}
      {showExtendModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 px-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 max-w-md w-full">
            <h3 className="text-lg font-semibold mb-4">Excavate 100 more posts?</h3>
            <p className="text-sm text-zinc-400 mb-6">
              Use 1 credit to excavate up to 100 more posts from @{accountData?.username}'s timeline.
            </p>

            <div className="flex gap-3">
              <button
                onClick={handleExcavateMore}
                className="cursor-pointer flex-1 bg-blue-600 text-white font-medium px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors"
              >
                Confirm
              </button>
              <button
                onClick={() => setShowExtendModal(false)}
                className="cursor-pointer flex-1 bg-zinc-800 text-zinc-300 font-medium px-4 py-2 rounded-lg hover:bg-zinc-700 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}