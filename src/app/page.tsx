"use client";

import { useState, useRef, useEffect } from "react";
import type {
  TweetData,
  AccountData,
  AccountStatus,
  Status,
  JobPhase,
} from "../components/types";
import { EngagementChart } from "../components/EngagementChart";
import { TweetCard } from "../components/TweetCard";
import { AccountHeader } from "../components/AccountHeader";
import { JobStatus } from "../components/JobStatus";
import { apiFetch } from "../lib/apiFetch";
import { getDevPlan, type DevPlan } from "../dev/state";
import { recordCacheEvent } from "../dev/cacheDebug";
import { DevPanel } from "../components/DevPanel";

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

/** True only when the dev panel is enabled at build time. */
const DEV_PANEL = process.env.NEXT_PUBLIC_DEV_PANEL === "1";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export default function Home() {
  const [username, setUsername] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [tweets, setTweets] = useState<TweetData[]>([]);
  const [jobInfo, setJobInfo] = useState<string>("");
  const [cacheHit, setCacheHit] = useState(false);
  const [credits, setCredits] = useState<number>(0);

  const [activeJobId, setActiveJobId] = useState<string | null>(null);

  const [accountStatus, setAccountStatus] = useState<AccountStatus>("idle");
  const [accountData, setAccountData] = useState<AccountData | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);

  const [jobPhase, setJobPhase] = useState<JobPhase>(null);
  const [resumeAt, setResumeAt] = useState<string | null>(null);

  // Dev-only plan gating. In prod (DEV_PANEL=false) this stays "basic" forever.
  const [devPlan, setDevPlanState] = useState<DevPlan>("basic");
  const isFree = DEV_PANEL && devPlan === "free";

  const [sessionCache, setSessionCache] = useState<
    Map<string, AccountData | { error: string }>
  >(new Map());

  const lookupTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cleanup = () => {
    if (lookupTimeoutRef.current) clearTimeout(lookupTimeoutRef.current);
  };

  const fetchCredits = async () => {
    try {
      const res = await apiFetch("/api/credits");
      if (res.ok) {
        const data = await res.json();
        setCredits(data.balance);
      }
    } catch (e) {
      console.error("Failed to fetch credits:", e);
    }
  };

  useEffect(() => {
    fetchCredits();

    if (DEV_PANEL) {
      setDevPlanState(getDevPlan());
      const handler = () => {
        fetchCredits();
        setDevPlanState(getDevPlan());
      };
      window.addEventListener("stelaDevChanged", handler);
      return () => window.removeEventListener("stelaDevChanged", handler);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const manualLookup = async (usernameToLookup: string) => {
    const cleanUsername = usernameToLookup.trim().toLowerCase();

    if (cleanUsername.length < 3) {
      setAccountStatus("error");
      setAccountError("Username must be at least 3 characters");
      return;
    }

    const cached = sessionCache.get(cleanUsername);
    if (cached) {
      if (DEV_PANEL) recordCacheEvent({ type: "lookup", hit: true, tier: "user", username: cleanUsername });
      if ("error" in cached) {
        setAccountStatus("error");
        setAccountError(cached.error);
        return;
      } else {
        setAccountStatus("found");
        setAccountData(cached);
        return;
      }
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
        const errorData = { error: data.error || `HTTP ${res.status}` };
        setSessionCache(
          (prev) => new Map(prev.set(cleanUsername, errorData)),
        );
        setAccountStatus("error");
        setAccountError(errorData.error);
        return;
      }

      setSessionCache((prev) => new Map(prev.set(cleanUsername, data)));
      if (DEV_PANEL) recordCacheEvent({
        type: "lookup",
        hit: data.source === "cache",
        tier: data.source === "cache" ? "shared" : "none",
        username: cleanUsername,
      });
      setAccountStatus("found");
      setAccountData(data);
    } catch {
      const errorData = { error: "Network error" };
      setSessionCache(
        (prev) => new Map(prev.set(cleanUsername, errorData)),
      );
      setAccountStatus("error");
      setAccountError("Network error");
    }
  };

  const handleLookupClick = () => {
    if (username.trim()) {
      manualLookup(username.trim());
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (accountData && !accountData.protected && username.trim() && !isFree) {
        handleUnlock();
      } else if (username.trim()) {
        manualLookup(username.trim());
      }
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
          return;
        }

        // ── Non-terminal → update UI and schedule next tick ──────────────

        if (job.status === "waiting_rate_limit") {
          setJobPhase("waiting_rate_limit");
          setResumeAt(job.resumeAt ?? null);
          setJobInfo(`API calls: ${job.apiCalls}`);
        } else if (job.status === "queued") {
          setJobPhase("queued");
          setResumeAt(null);
          const pos = job.queuePosition;
          setJobInfo(
            pos != null
              ? `Position ${pos} in queue — waiting for slot…`
              : `Waiting for slot…`,
          );
        } else {
          setJobPhase("running");
          setResumeAt(null);
          setJobInfo(`Excavating… (API calls: ${job.apiCalls})`);
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
  }, [activeJobId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleUnlock = async (force = false) => {
    // Blocked on free plan
    if (isFree) return;

    const raw = username.trim().replace(/^@/, "");
    if (!raw) return;

    console.log("[DEBUG] handleUnlock started:", { 
      username: raw, 
      currentAccountStatus: accountStatus,
      hasAccountData: !!accountData 
    });

    cleanup();
    setActiveJobId(null);
    setStatus("running");
    setError(null);
    setTweets([]);
    setCacheHit(false);
    setJobInfo(force ? "Re-running excavation…" : "Starting…");
    setJobPhase("running");
    setResumeAt(null);

    // Keep account status and data visible during excavation
    // setAccountStatus("idle");
    // setAccountData(null);
    // setAccountError(null);
    console.log("[DEBUG] handleUnlock: account state NOT reset");

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
        return;
      }

      const unlock: UnlockResponse = await res.json();

      if (DEV_PANEL) recordCacheEvent({
        type: "unlock",
        hit: unlock.status === "cache-hit",
        tier: unlock.status === "cache-hit"
          ? (unlock.freeReUnlock ? "user" : "shared")
          : "none",
        username: raw,
        cachedCount: unlock.cachedCount,
      });

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
        return;
      }

      if (unlock.jobId) {
        setJobInfo("Excavating…");
        setActiveJobId(unlock.jobId);
      }
    } catch {
      setStatus("failed");
      setError("Network error");
      setJobPhase(null);
    }
  };

  // ── DevPanel: load a username into the main UI ────────────────────────────
  const handleViewUsername = (usernameToView: string) => {
    const clean = usernameToView.replace(/^@/, "").trim().toLowerCase();
    setUsername(clean);
    manualLookup(clean);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const hasResults = tweets.length > 0;
  // Show locked placeholder when free plan + account found (no unlock allowed)
  const showLocked = isFree && accountStatus === "found";

  return (
    <main className="max-w-2xl mx-auto px-4 py-12">
      {/* Header */}
      <h1 className="text-2xl font-bold mb-1 tracking-tight">STELA</h1>
      <p className="text-zinc-500 text-sm mb-8">
        Unlock the earliest posts of any public X account.
      </p>

      {/* Input */}
      <div className="flex gap-2 mb-4">
        <div className="relative flex-1">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500">
            @
          </span>
          <input
            type="text"
            value={username}
            onChange={(e) => {
              const cleanValue = e.target.value.replace(/^@/, "");
              console.log("[DEBUG] onChange triggered:", { 
                cleanValue, 
                currentUsername: username, 
                different: cleanValue !== username,
                status,
                accountStatus 
              });
              setUsername(cleanValue);
              // Don't reset account state during excavation
              if (cleanValue !== username && status !== "running") {
                console.log("[DEBUG] Resetting account state due to username change");
                setAccountStatus("idle");
                setAccountData(null);
                setAccountError(null);
              }
            }}
            onKeyDown={handleKeyDown}
            placeholder="username (min 3 chars)"
            className="w-full bg-zinc-900 border border-zinc-700 rounded-lg pl-8 pr-3 py-2 text-sm focus:outline-none focus:border-zinc-500"
          />
        </div>
        <button
          onClick={handleLookupClick}
          disabled={
            !username.trim() ||
            username.length < 3 ||
            accountStatus === "loading"
          }
          className="bg-zinc-700 text-white font-semibold text-sm px-4 py-2 rounded-lg hover:bg-zinc-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {accountStatus === "loading" ? "Checking…" : "Lookup"}
        </button>
        <button
          onClick={() => handleUnlock(false)}
          disabled={
            isFree ||
            !accountData ||
            accountData.protected ||
            status === "running"
          }
          title={isFree ? "Upgrade to unlock earliest posts" : undefined}
          className="bg-white text-black font-semibold text-sm px-4 py-2 rounded-lg hover:bg-zinc-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {isFree ? "Upgrade to unlock" : "Excavate"}
        </button>
        <button
          onClick={() => handleUnlock(true)}
          disabled={isFree || !username.trim() || status === "running"}
          title="Bypass cache and re-run excavation"
          className="bg-zinc-700 text-zinc-200 font-semibold text-sm px-3 py-2 rounded-lg hover:bg-zinc-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Re-run
        </button>
      </div>

      {/* Account Header — sticky when results are visible */}
      {(accountStatus !== "idle" || accountData) && (
        <div
          className={
            hasResults
              ? "sticky top-0 z-20 -mx-4 px-4 py-2 bg-black/80 backdrop-blur-sm mb-4"
              : "mb-4"
          }
        >
          <AccountHeader
            status={accountStatus}
            data={accountData}
            error={accountError}
          />
        </div>
      )}

      {/* Job Status */}
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
      {showLocked ? (
        <div className="relative rounded-xl overflow-hidden border border-zinc-800 h-28 mb-4">
          <div className="flex items-end gap-1 h-full px-4 pb-4 pt-6 opacity-20">
            {[40, 65, 30, 80, 50, 70, 45, 90, 35, 60].map((h, i) => (
              <div
                key={i}
                className="flex-1 bg-zinc-500 rounded-t"
                style={{ height: `${h}%` }}
              />
            ))}
          </div>
          <div className="absolute inset-0 backdrop-blur-[3px] bg-black/60 flex items-center justify-center">
            <p className="text-zinc-400 text-xs">Chart locked — Free plan</p>
          </div>
        </div>
      ) : (
        hasResults && <EngagementChart tweets={tweets} />
      )}

      {/* Tweet list */}
      {showLocked ? (
        <div className="relative border border-zinc-800 rounded-xl overflow-hidden">
          {/* Skeleton rows */}
          <div className="divide-y divide-zinc-800">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="p-4 flex gap-3 opacity-30">
                <div className="w-10 h-10 rounded-full bg-zinc-700 shrink-0" />
                <div className="flex-1 space-y-2 pt-1">
                  <div className="h-3 bg-zinc-700 rounded w-1/4" />
                  <div className="h-3 bg-zinc-700 rounded w-full" />
                  <div className="h-3 bg-zinc-700 rounded w-3/5" />
                </div>
              </div>
            ))}
          </div>
          {/* Blur + label */}
          <div className="absolute inset-0 backdrop-blur-[3px] bg-black/55 flex items-center justify-center">
            <div className="text-center">
              <p className="text-zinc-200 text-sm font-semibold">
                Locked — Free plan
              </p>
              <p className="text-zinc-500 text-xs mt-1">
                Upgrade to unlock earliest posts
              </p>
            </div>
          </div>
        </div>
      ) : hasResults ? (
        <div className="border border-zinc-800 rounded-xl overflow-hidden">
          {tweets.map((t) => (
            <TweetCard key={t.post_id} tweet={t} />
          ))}
        </div>
      ) : (
        <div className="border border-zinc-800 rounded-xl min-h-[200px] flex items-center justify-center">
          <p className="text-zinc-600 text-sm">
            {status === "idle" &&
              "Enter a username to unlock their earliest posts."}
            {status === "running" && "Excavating…"}
            {status === "done" && "No posts found."}
            {status === "failed" && "Unlock failed."}
          </p>
        </div>
      )}
      {/* Dev Panel — only when NEXT_PUBLIC_DEV_PANEL=1 */}
      {DEV_PANEL && <DevPanel onView={handleViewUsername} />}
    </main>
  );
}
