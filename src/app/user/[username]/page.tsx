"use client";

import { useState, useEffect, useRef } from "react";
import { useParams } from "next/navigation";
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
import { TweetCard } from "../../../components/TweetCard";
import { AccountHeader } from "../../../components/AccountHeader";
import { JobStatus } from "../../../components/JobStatus";
import { apiFetch } from "../../../lib/apiFetch";
import { useUser } from "../../../contexts/UserContext";

interface UnlockResponse {
  jobId: string | null;
  status: "queued" | "attached" | "cache-hit";
  accountId?: string;
  cachedCount?: number;
  freeReUnlock?: boolean;
}

interface JobResponse {
  jobId: string;
  status:
    | "queued"
    | "running"
    | "waiting_rate_limit"
    | "succeeded"
    | "failed"
    | "canceled";
  username: string;
  fetchedCount: number;
  apiCalls: number;
  resumeAt?: string | null;
  queuePosition?: number | null;
  runningJobId?: string | null;
  error?: { code: string; message: string };
  result?: { userId: string; fetchedCount: number; stopReason: string };
}

/** Artificial delay (0.5–1.0s) for UX consistency */
const ARTIFICIAL_DELAY_MS = 750;

/** Fixed polling interval — does NOT change based on job status. */
const POLL_INTERVAL_MS = 2500;

const DUMMY_CHART_HEIGHTS = [35, 62, 48, 75, 30, 88, 55, 42, 70, 25, 60, 45, 82, 38, 67, 52, 90, 33, 58, 44];

const DUMMY_TWEET_STATS = [
  { likes: 47, retweets: 12, replies: 5 },
  { likes: 83, retweets: 7, replies: 2 },
  { likes: 21, retweets: 3, replies: 8 },
  { likes: 64, retweets: 18, replies: 4 },
  { likes: 9, retweets: 1, replies: 3 },
];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Format the account creation date for display.
 */
function formatJoinDate(createdAt: string | null): string {
  if (!createdAt) return "Date unknown";
  
  try {
    const date = new Date(createdAt);
    return date.toLocaleDateString("en-US", { 
      year: "numeric", 
      month: "long" 
    });
  } catch {
    return "Date unknown";
  }
}

export default function UserPage() {
  const params = useParams();
  const username = Array.isArray(params.username) ? params.username[0] : params.username;

  // User context - MUST be called before any early returns
  const { user, credits, refreshCredits } = useUser();

  // UI State for different phases
  const [uiPhase, setUiPhase] = useState<"preview" | "excavating" | "results">("preview");
  
  // Account state
  const [accountStatus, setAccountStatus] = useState<AccountStatus>("loading");
  const [accountData, setAccountData] = useState<AccountData | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);

  // Excavation state
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [tweets, setTweets] = useState<TweetData[]>([]);
  const [jobInfo, setJobInfo] = useState<string>("");
  const [cacheHit, setCacheHit] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [jobPhase, setJobPhase] = useState<JobPhase>(null);
  const [resumeAt, setResumeAt] = useState<string | null>(null);
  const [isAlreadyUnlocked, setIsAlreadyUnlocked] = useState(false);
  const [checkingUnlockStatus, setCheckingUnlockStatus] = useState(false);

  // Basic validation
  if (!username || typeof username !== "string") {
    notFound();
  }

  const fetchCredits = async () => {
    try {
      // Use UserContext's refreshCredits instead of direct API call
      refreshCredits();
    } catch (e) {
      console.error("Failed to fetch credits:", e);
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
      const res = await fetch(
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

  const loadTweets = async (accountId: string): Promise<TweetData[]> => {
    const res = await fetch(`/api/tweets/${accountId}`);
    if (res.ok) {
      const data = await res.json();
      return data.tweets || [];
    }
    return [];
  };

  // Load account on mount
  useEffect(() => {
    if (username) {
      loadAccount();
      fetchCredits();
    }
  }, [username]);

  // Check unlock status and load existing tweets when user and account are available
  useEffect(() => {
    if (user && accountData && !checkingUnlockStatus) {
      setCheckingUnlockStatus(true);
      fetch(`/api/account/unlock-status?username=${encodeURIComponent(accountData.username)}`, {
        credentials: 'include'
      })
        .then(res => res.json())
        .then(data => {
          if (data.unlocked) {
            setIsAlreadyUnlocked(true);
            // Load existing tweets if available
            loadTweets(data.accountId).then(loadedTweets => {
              if (loadedTweets.length > 0) {
                setTweets(loadedTweets);
                setStatus("done");
                setUiPhase("results");
                setJobInfo(`${loadedTweets.length} posts • previously unlocked`);
              }
            });
          }
        })
        .catch(error => {
          console.error('Failed to check unlock status:', error);
        })
        .finally(() => {
          setCheckingUnlockStatus(false);
        });
    }
  }, [user, accountData, checkingUnlockStatus]);

  // Refresh credits after successful excavation
  useEffect(() => {
    if (status === "done" && user) {
      refreshCredits();
    }
  }, [status, user, refreshCredits]);

  // ── Polling driven by activeJobId ──────────────────────────────────────────
  useEffect(() => {
    if (!activeJobId) return;

    console.log(`[poll] start jobId=${activeJobId}`);

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      if (cancelled) return;

      try {
        const res = await fetch(`/api/jobs/${activeJobId}`);

        if (cancelled) return;

        if (res.status === 404) {
          console.log(
            `[poll] 404 jobId=${activeJobId} — resetting to idle`,
          );
          setStatus("idle");
          setJobInfo("Job not found — may have expired");
          setError(null);
          setJobPhase(null);
          setResumeAt(null);
          setActiveJobId(null);
          setUiPhase("preview");
          return;
        }

        if (!res.ok) {
          console.warn(
            `[poll] HTTP ${res.status} jobId=${activeJobId} — retrying`,
          );
          setJobInfo(`Polling error (HTTP ${res.status}) — retrying…`);
          timer = setTimeout(poll, POLL_INTERVAL_MS);
          return;
        }

        const job: JobResponse = await res.json();

        // ── Terminal states → stop polling ────────────────────────────────

        if (job.status === "succeeded") {
          console.log(
            `[poll] stop jobId=${activeJobId} reason=succeeded fetched=${job.fetchedCount}`,
          );
          const accountId = job.result?.userId;
          if (accountId) {
            const loaded = await loadTweets(accountId);
            if (!cancelled) setTweets(loaded);
          }
          if (!cancelled) {
            setJobInfo(
              `${job.fetchedCount} posts · ${job.apiCalls} API calls`,
            );
            setStatus("done");
            setCacheHit(false);
            setJobPhase(null);
            setResumeAt(null);
            fetchCredits();
            setActiveJobId(null);
            setUiPhase("results"); // Phase 5: Switch to results view
          }
          return;
        }

        if (job.status === "failed") {
          console.log(
            `[poll] stop jobId=${activeJobId} reason=failed error=${job.error?.code}`,
          );
          setStatus("failed");
          setError(job.error?.message || "Excavation failed");
          setJobPhase(null);
          setResumeAt(null);
          setActiveJobId(null);
          setUiPhase("preview"); // Phase 5: Return to preview on failure
          return;
        }

        if (job.status === "canceled") {
          console.log(
            `[poll] stop jobId=${activeJobId} reason=canceled`,
          );
          setStatus("failed");
          setError("Job was canceled");
          setJobPhase(null);
          setResumeAt(null);
          setActiveJobId(null);
          setUiPhase("preview"); // Phase 5: Return to preview on cancel
          return;
        }

        // ── Non-terminal → update UI and schedule next tick ──────────────

        if (job.status === "waiting_rate_limit") {
          setJobPhase("waiting_rate_limit");
          setResumeAt(job.resumeAt ?? null);
          setJobInfo(`API calls: ${job.apiCalls}`);
          setUiPhase("excavating"); // Phase 5: Stay in excavating view
        } else if (job.status === "queued") {
          setJobPhase("queued");
          setResumeAt(null);
          const pos = job.queuePosition;
          setJobInfo(
            pos != null
              ? `Position ${pos} in queue — waiting for slot…`
              : `Waiting for slot…`,
          );
          setUiPhase("excavating"); // Phase 5: Stay in excavating view
        } else {
          setJobPhase("running");
          setResumeAt(null);
          setJobInfo(`Excavating… (API calls: ${job.apiCalls})`);
          setUiPhase("excavating"); // Phase 5: Switch to excavating view
        }

        timer = setTimeout(poll, POLL_INTERVAL_MS);
      } catch {
        if (!cancelled) {
          console.warn(
            `[poll] network error jobId=${activeJobId} — retrying`,
          );
          setJobInfo("Network error — retrying…");
          timer = setTimeout(poll, POLL_INTERVAL_MS);
        }
      }
    };

    poll();

    return () => {
      console.log(`[poll] cleanup jobId=${activeJobId}`);
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeJobId]);

  const handleExcavate = async (force = false) => {
    if (!accountData || accountData.protected) return;

    const raw = username.trim().replace(/^@/, "");
    if (!raw) return;

    setActiveJobId(null);
    setStatus("running");
    setError(null);
    setTweets([]);
    setCacheHit(false);
    setJobInfo(force ? "Re-running excavation…" : "Starting…");
    setJobPhase("running");
    setResumeAt(null);
    setUiPhase("excavating"); // Phase 5: Switch to excavating view immediately

    try {
      const res = await apiFetch("/api/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: raw, force }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setStatus("failed");
        setError(data.error || `HTTP ${res.status}`);
        setJobPhase(null);
        setUiPhase("preview"); // Phase 5: Return to preview on failure
        return;
      }

      const unlock: UnlockResponse = await res.json();

      if (!force && unlock.status === "cache-hit" && unlock.accountId) {
        setJobInfo("Unlocking…");
        await sleep(ARTIFICIAL_DELAY_MS);
        const loaded = await loadTweets(unlock.accountId);
        setTweets(loaded);
        setJobInfo(`${loaded.length} posts · cached`);
        setStatus("done");
        setCacheHit(true);
        setJobPhase(null);
        fetchCredits();
        setUiPhase("results"); // Phase 5: Switch to results view
        return;
      }

      if (unlock.jobId) {
        setJobInfo("Excavating…");
        setActiveJobId(unlock.jobId);
        // uiPhase will be set to "excavating" by the polling logic
      }
    } catch {
      setStatus("failed");
      setError("Network error");
      setJobPhase(null);
      setUiPhase("preview"); // Phase 5: Return to preview on error
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
  const joinDate = formatJoinDate(accountData.created_at);
  const hasResults = tweets.length > 0;

  const isLoggedIn = !!user; // Check if user is authenticated

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

      {/* Account Header — always visible */}
      <div className={hasResults ? "sticky top-0 z-20 -mx-4 px-4 py-2 bg-black/80 backdrop-blur-sm mb-4" : "mb-4"}>
        <AccountHeader
          status={accountStatus}
          data={accountData}
          error={accountError}
        />
      </div>

      {/* Phase 5: Dynamic content based on UI phase */}

      {/* Preview Phase */}
      {uiPhase === "preview" && (
        <>
          {/* CTA row — centered, directly below account header */}
          <div className="flex flex-col items-center text-center mb-6 mt-2">
            {accountData.protected ? (
              <div className="flex items-center gap-2 text-orange-300 text-sm px-4 py-3 bg-orange-900/20 border border-orange-800/50 rounded-lg">
                <svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
                </svg>
                This account is protected and cannot be excavated.
              </div>
            ) : isLoggedIn ? (
              <>
                {isAlreadyUnlocked ? (
                  <>
                    <div className="mb-3 p-4 bg-emerald-900/20 border border-emerald-800/50 rounded-lg max-w-sm">
                      <div className="flex items-center gap-2 text-emerald-400 mb-2">
                        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                        </svg>
                        <span className="font-medium">Already Unlocked</span>
                      </div>
                      <p className="text-sm text-zinc-400">
                        You've already unlocked this account's earliest posts.
                      </p>
                    </div>
                    <button
                      onClick={() => handleExcavate(true)}
                      className="bg-zinc-800 text-white font-semibold px-6 py-3 rounded-lg hover:bg-zinc-700 transition-colors border border-zinc-600"
                    >
                      Re-run Excavation
                    </button>
                    <p className="text-xs text-zinc-500 mt-2">
                      Re-excavation uses 1 credit • You have {credits} credits
                    </p>
                  </>
                ) : credits > 0 ? (
                  <>
                    <button
                      onClick={() => handleExcavate(false)}
                      className="inline-flex items-center gap-2 bg-white text-black font-semibold px-6 py-3 rounded-lg hover:bg-zinc-200 transition-colors mb-2"
                    >
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                      </svg>
                      Excavate Earliest Posts
                    </button>
                    <p className="text-sm text-zinc-400">
                      Unlock up to 100 earliest posts • Uses 1 credit
                    </p>
                    <p className="text-xs text-zinc-500">
                      You have {credits} credits remaining
                    </p>
                  </>
                ) : (
                  <>
                    <div className="mb-3 p-4 bg-zinc-900 border border-zinc-800 rounded-lg max-w-sm">
                      <div className="flex items-center gap-2 text-orange-400 mb-2">
                        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                          <path d="M8.433 7.418c.155-.103.346-.196.567-.267v1.698a2.305 2.305 0 01-.567-.267C8.07 8.34 8.07 7.949 8.433 7.418zM11 12.849v-1.698c.22.071.412.164.567.267.364.532.364.923 0 1.464-.155.103-.346.196-.567.267z" />
                          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-13a1 1 0 10-2 0v.092a4.535 4.535 0 00-1.676.662C6.602 6.234 6.102 7.036 6.102 8c0 .964.5 1.766 1.222 2.246.135.09.288.171.448.245.02.009.039.018.059.027.951.409 1.969.909 1.969 2.482 0 .964-.5 1.766-1.222 2.246-.135.09-.288.171-.448.245-.02.009-.039.018-.059.027-.951.409-1.969.909-1.969 2.482a1 1 0 102 0v-.092a4.535 4.535 0 001.676-.662C13.398 13.766 13.898 12.964 13.898 12c0-.964-.5-1.766-1.222-2.246a4.025 4.025 0 00-.448-.245 1.015 1.015 0 01-.059-.027C11.218 9.073 10.2 8.573 10.2 7c0-.964.5-1.766 1.222-2.246.135-.09.288-.171.448-.245.02-.009.039-.018.059-.027.351-.151.724-.297 1.071-.462V5a1 1 0 102 0z" clipRule="evenodd" />
                        </svg>
                        <span className="font-medium">No Credits Available</span>
                      </div>
                      <p className="text-sm text-zinc-400">
                        You need 1 credit to unlock this account's earliest posts.
                      </p>
                    </div>
                    <Link 
                      href="/account/credits"
                      className="bg-white text-black font-semibold px-6 py-3 rounded-lg hover:bg-zinc-200 transition-colors"
                    >
                      Get More Credits
                    </Link>
                  </>
                )}
              </>
            ) : (
              <>
                <div className="mb-3 p-4 bg-zinc-900 border border-zinc-800 rounded-lg max-w-sm">
                  <h3 className="font-medium mb-2">Sign In Required</h3>
                  <p className="text-sm text-zinc-400">
                    Create an account or sign in to unlock earliest posts
                  </p>
                </div>
                <div className="flex items-center gap-3 mb-2">
                  <Link 
                    href="/signup"
                    className="inline-flex items-center justify-center gap-2 bg-white text-black font-semibold px-6 py-3 rounded-lg hover:bg-zinc-200 transition-colors"
                  >
                    Create Account
                  </Link>
                  <Link 
                    href="/login"
                    className="inline-flex items-center justify-center gap-2 bg-zinc-800 text-white font-semibold px-6 py-3 rounded-lg hover:bg-zinc-700 transition-colors border border-zinc-600"
                  >
                    Sign In
                  </Link>
                </div>
                <p className="text-xs text-zinc-500">New accounts get 3 free credits</p>
              </>
            )}

            {/* Error display */}
            {error && (
              <div className="mt-3 flex items-center gap-2 text-red-300 text-sm px-4 py-3 bg-red-900/20 border border-red-800/50 rounded-lg w-full max-w-sm">
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

            {/* Discover overlay — text only, centered over blurred zone */}
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

      {/* Excavating Phase */}
      {uiPhase === "excavating" && (
        <>
          <JobStatus
            status={status}
            jobPhase={jobPhase}
            jobInfo={jobInfo}
            error={error}
            credits={credits}
            cacheHit={cacheHit}
            resumeAt={resumeAt}
          />
          
          <div className="border border-zinc-800 rounded-xl min-h-[200px] flex items-center justify-center">
            <div className="text-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white mx-auto mb-4"></div>
              <p className="text-zinc-400 text-sm">
                {jobInfo || "Excavating earliest posts..."}
              </p>
            </div>
          </div>
        </>
      )}

      {/* Results Phase */}
      {uiPhase === "results" && (
        <>
          <JobStatus
            status={status}
            jobPhase={jobPhase}
            jobInfo={jobInfo}
            error={error}
            credits={credits}
            cacheHit={cacheHit}
            resumeAt={resumeAt}
          />

          {/* Engagement Chart */}
          {hasResults && <EngagementChart tweets={tweets} />}

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

          {/* Expansion options - placeholder for Phase 5 */}
          {hasResults && (
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
    </main>
  );
}