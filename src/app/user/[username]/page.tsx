"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { notFound } from "next/navigation";
import type {
  TweetData,
  AccountData,
  AccountStatus,
} from "../../../components/types";
import { EngagementChart } from "../../../components/EngagementChart";
import { TweetCard, tweetElementId } from "../../../components/TweetCard";
import { AccountHeader } from "../../../components/AccountHeader";
import { JobStatus } from "../../../components/JobStatus";
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

export default function UserPage() {
  const params = useParams();
  const router = useRouter();
  const username = Array.isArray(params.username) ? params.username[0] : params.username;

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
  const [showBackToTop, setShowBackToTop] = useState(false);

  const scrollToTweetByPostId = useCallback((postId: string) => {
    const el = document.getElementById(tweetElementId(postId));
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
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

      if (extendResponse.executionMode === "grant_only") {
        sessionStorage.setItem("stela-extend-result", JSON.stringify({
          boundary: extendResponse.boundary,
          range: extendResponse.range,
        }));
        router.push(`/excavating?flow=extend-granted&username=${encodeURIComponent(accountData.username)}`);
      } else if (extendResponse.executionMode === "excavate_more") {
        sessionStorage.setItem("stela-extend-result", JSON.stringify({
          previousBoundary: extendResponse.planning.currentVisibleBoundary,
        }));
        router.push(`/excavating?flow=extend&username=${encodeURIComponent(accountData.username)}&jobId=${extendResponse.jobId}`);
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
    if (rangeStart && rangeEnd) {
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

    const urlParams = new URLSearchParams(window.location.search);
    const rangeStartParam = urlParams.get("rangeStart");
    const rangeEndParam = urlParams.get("rangeEnd");
    const hasRangeParams = Boolean(rangeStartParam && rangeEndParam);
    const rangeStart = hasRangeParams ? parseInt(rangeStartParam!, 10) : undefined;
    const rangeEnd = hasRangeParams ? parseInt(rangeEndParam!, 10) : undefined;
    const rangeValid =
      hasRangeParams &&
      rangeStart !== undefined &&
      rangeEnd !== undefined &&
      !Number.isNaN(rangeStart) &&
      !Number.isNaN(rangeEnd) &&
      rangeStart > 0 &&
      rangeEnd >= rangeStart;

    const tweetFetchKey = (accountId: string, rs?: number, re?: number) =>
      rs != null && re != null ? `${accountId}:${rs}:${re}` : `${accountId}:full`;

    const applyTweetResult = (
      loadedTweets: TweetData[],
      jobInfoFor: (n: number) => string,
      boundary?: number,
    ) => {
      if (cancelled || loadedTweets.length === 0) return;
      setTweets(loadedTweets);
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
      if (tweetsFetchedKeyRef.current === key) return;
      tweetsFetchedKeyRef.current = key;
      const loaded = await loadTweets(accountId, rs, re);
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
      return () => {
        cancelled = true;
      };
    }
    unlockCheckKeyRef.current = unlockKey;

    void (async () => {
      try {
        const res = await apiFetch(
          `/api/account/unlock-status?username=${encodeURIComponent(accountData.username)}`,
        );
        if (cancelled) return;
        const data = await res.json();
        if (cancelled) return;
        if (!data.unlocked) return;

        setIsAlreadyUnlocked(true);
        setCurrentBoundary(data.boundaryEnd || data.count || 100);

        const rs = rangeValid ? rangeStart : undefined;
        const re = rangeValid ? rangeEnd : undefined;

        await fetchTweetsOnce(
          data.accountId,
          rs,
          re,
          (n) =>
            rangeValid
              ? `${n} posts · showing ${rangeStart}-${rangeEnd}`
              : `${n} posts • previously unlocked`,
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
  }, [authLoading, user?.id, accountData?.account_id, accountData?.username]);

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
      const encodedUsername = encodeURIComponent(raw);

      if (!force && unlock.status === "cache-hit" && unlock.accountId) {
        router.push(`/excavating?flow=initial-cached&username=${encodedUsername}`);
      } else if (unlock.jobId) {
        router.push(`/excavating?flow=initial&username=${encodedUsername}&jobId=${unlock.jobId}`);
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
            className="text-zinc-400 hover:text-white transition-colors text-sm inline-flex items-center gap-2"
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
            className="text-zinc-400 hover:text-white transition-colors text-sm inline-flex items-center gap-2"
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
              className="inline-flex items-center gap-2 bg-white text-black font-semibold px-6 py-3 rounded-lg hover:bg-zinc-200 transition-colors"
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

  // Determine if user can unlock (has credits OR basic subscription)
  const canUnlock = isLoggedIn && (credits > 0 || subscription.plan === 'basic');

  // Check if we're in range mode
  const searchParams = new URLSearchParams(window.location.search);
  const isRangeMode = !!(searchParams.get('rangeStart') && searchParams.get('rangeEnd'));

  // Function to show full range (clear range params)
  const showFullRange = () => {
    if (accountData) {
      router.replace(`/user/${username}`, { scroll: false });
      // Reload full tweet set
      loadTweets(accountData.account_id).then(loadedTweets => {
        setTweets(loadedTweets);
        const boundary = currentBoundary || loadedTweets.length;
        setJobInfo(`${loadedTweets.length} posts • showing 1-${boundary}`);
      });
    }
  };

  return (
    <main className="max-w-2xl mx-auto px-4 py-12">
      {/* Navigation */}
      <div className="mb-8">
        <Link
          href="/"
          className="text-zinc-400 hover:text-white transition-colors text-sm inline-flex items-center gap-2"
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
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              Excavate more · +100 posts for 1 credit
            </button>
          </div>
        )}

        {/* Back to Top Control - appears after scrolling */}
        {showBackToTop && hasResults && (
          <div className="text-center mt-0.5">
            <button
              onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
              className="text-xs text-zinc-500 opacity-60 hover:opacity-100 transition-opacity inline-flex items-center gap-1"
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
          {/* Simple CTA buttons directly under account header */}
          <div className="flex flex-col items-center mb-6">
            {accountData.protected ? (
              <div className="flex items-center gap-2 text-orange-300 text-sm px-4 py-3 bg-orange-900/20 border border-orange-800/50 rounded-lg">
                <svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
                </svg>
                This account is protected and cannot be excavated.
              </div>
            ) : canUnlock ? (
              <>
                {isAlreadyUnlocked ? (
                  <div className="text-center">
                    {DEV_PANEL && (
                      <button
                        onClick={() => handleExcavate(true)}
                        className="bg-zinc-800 text-white font-semibold px-6 py-3 rounded-lg hover:bg-zinc-700 transition-colors border border-zinc-600 mb-2"
                      >
                        Re-run Excavation
                      </button>
                    )}
                    <p className="text-xs text-zinc-500">
                      {DEV_PANEL ?
                        `Re-excavation uses 1 credit • You have ${credits} credits${subscription.plan === 'basic' ? ' • Basic subscriber' : ''}` :
                        `Account previously unlocked • ${credits} credits available${subscription.plan === 'basic' ? ' • Basic subscriber' : ''}`
                      }
                    </p>
                  </div>
                ) : (
                  <div className="text-center">
                    <button
                      onClick={() => handleExcavate(false)}
                      className="bg-white text-black font-semibold px-6 py-3 rounded-lg hover:bg-zinc-200 transition-colors mb-2"
                    >
                      Excavate Earliest Posts
                    </button>
                    <p className="text-xs text-zinc-500">
                      {subscription.plan === 'basic' ? `Basic subscriber • ${credits} credits available` : `You have ${credits} credits remaining`}
                    </p>
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="text-center">
                  <button
                    onClick={handleUnlockForPrice}
                    className="bg-white text-black font-semibold px-6 py-3 rounded-lg hover:bg-zinc-200 transition-colors mb-3"
                  >
                    Unlock for $4
                  </button>
                  {!isLoggedIn && (
                    <div className="text-sm text-zinc-400">
                      Have an account?{" "}
                      <Link
                        href="/login"
                        className="text-white hover:text-zinc-300 underline"
                      >
                        Sign in
                      </Link>
                    </div>
                  )}
                </div>
              </>
            )}

            {/* Error display */}
            {error && (
              <div className="mt-3 flex items-center gap-2 text-red-300 text-sm px-4 py-3 bg-red-900/20 border border-red-800/50 rounded-lg">
                <svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
                {error}
              </div>
            )}
          </div>

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
          <JobStatus
            status="done"
            jobPhase={null}
            jobInfo={jobInfo}
            error={null}
            credits={credits}
            cacheHit={false}
            resumeAt={null}
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
                  className="ml-3 text-blue-300 hover:text-blue-200 underline text-xs"
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
                    className="bg-gradient-to-r from-blue-600 to-purple-600 text-white font-semibold px-6 py-3 rounded-lg hover:from-blue-700 hover:to-purple-700 transition-all"
                  >
                    Create Account
                  </Link>
                  <Link
                    href={`/login?returnTo=${encodeURIComponent(`/user/${username}`)}`}
                    className="bg-zinc-800 text-white font-semibold px-6 py-3 rounded-lg hover:bg-zinc-700 transition-colors border border-zinc-600"
                  >
                    Sign In
                  </Link>
                </div>
              </div>
            </div>
          )}

          {/* Engagement Chart */}
          {hasResults && (
            <EngagementChart tweets={tweets} onBarSelect={scrollToTweetByPostId} />
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
                className="inline-flex items-center gap-2 bg-zinc-800 text-zinc-200 font-semibold px-4 py-2 rounded-lg hover:bg-zinc-700 transition-colors"
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
                className="flex-1 bg-blue-600 text-white font-medium px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors"
              >
                Confirm
              </button>
              <button
                onClick={() => setShowExtendModal(false)}
                className="flex-1 bg-zinc-800 text-zinc-300 font-medium px-4 py-2 rounded-lg hover:bg-zinc-700 transition-colors"
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