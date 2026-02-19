"use client";

import { useState, useRef, useCallback, useEffect } from "react";

type Status = "idle" | "running" | "done" | "failed";

interface TweetData {
  post_id: string;
  account_id: string;
  created_at: string;
  full_text: string;
  media_json: string | null;
  like_count: number;
  retweet_count: number;
  reply_count: number;
}

interface UnlockResponse {
  jobId: string | null;
  status: "queued" | "attached" | "cache-hit";
  accountId?: string;
  cachedCount?: number;
  freeReUnlock?: boolean;
}

interface AccountData {
  account_id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string | null;
  protected: boolean;
  source: "cache" | "api";
}

type AccountStatus = "idle" | "loading" | "found" | "error";

interface JobResponse {
  jobId: string;
  status: "queued" | "running" | "succeeded" | "failed";
  username: string;
  fetchedCount: number;
  apiCalls: number;
  error?: { code: string; message: string };
  result?: { userId: string; fetchedCount: number; stopReason: string };
}

/** Artificial delay (0.5–1.0s) for UX consistency */
const ARTIFICIAL_DELAY_MS = 750;

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
  
  // Account preview state
  const [accountStatus, setAccountStatus] = useState<AccountStatus>("idle");
  const [accountData, setAccountData] = useState<AccountData | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  
  // Frontend session cache to avoid repeated lookups
  const [sessionCache, setSessionCache] = useState<Map<string, AccountData | { error: string }>>(new Map());
  
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lookupTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cleanup = () => {
    if (pollRef.current) clearTimeout(pollRef.current);
    if (lookupTimeoutRef.current) clearTimeout(lookupTimeoutRef.current);
  };

  const manualLookup = async (usernameToLookup: string) => {
    const cleanUsername = usernameToLookup.trim().toLowerCase();
    
    // Minimum length check
    if (cleanUsername.length < 3) {
      setAccountStatus("error");
      setAccountError("Username must be at least 3 characters");
      return;
    }

    // Check frontend session cache first
    const cached = sessionCache.get(cleanUsername);
    if (cached) {
      if ('error' in cached) {
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
      const res = await fetch(`/api/account?username=${encodeURIComponent(cleanUsername)}`);
      const data = await res.json();

      if (!res.ok) {
        const errorData = { error: data.error || `HTTP ${res.status}` };
        setSessionCache(prev => new Map(prev.set(cleanUsername, errorData)));
        setAccountStatus("error");
        setAccountError(errorData.error);
        return;
      }

      // Cache successful result
      setSessionCache(prev => new Map(prev.set(cleanUsername, data)));
      setAccountStatus("found");
      setAccountData(data);
    } catch (err) {
      const errorData = { error: "Network error" };
      setSessionCache(prev => new Map(prev.set(cleanUsername, errorData)));
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
      if (accountData && !accountData.protected && username.trim()) {
        // If account is already looked up and not protected, proceed with unlock
        handleUnlock();
      } else if (username.trim()) {
        // Otherwise, do lookup first
        manualLookup(username.trim());
      }
    }
  };

  const fetchCredits = async () => {
    try {
      const res = await fetch("/api/credits");
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
  }, []);

  const loadTweets = async (accountId: string): Promise<TweetData[]> => {
    const res = await fetch(`/api/tweets/${accountId}`);
    if (res.ok) {
      const data = await res.json();
      return data.tweets || [];
    }
    return [];
  };

  const pollJob = useCallback(async (jobId: string) => {
    try {
      const res = await fetch(`/api/jobs/${jobId}`);
      if (!res.ok) {
        setStatus("failed");
        setError("Failed to poll job status");
        return;
      }
      const job: JobResponse = await res.json();

      if (job.status === "queued" || job.status === "running") {
        setJobInfo(`Status: ${job.status}… (API calls: ${job.apiCalls})`);
        pollRef.current = setTimeout(() => pollJob(jobId), 2500);
        return;
      }

      if (job.status === "failed") {
        setStatus("failed");
        setError(job.error?.message || "Excavation failed");
        return;
      }

      if (job.status === "succeeded") {
        const accountId = job.result?.userId;
        if (accountId) {
          const loaded = await loadTweets(accountId);
          setTweets(loaded);
        }
        setJobInfo(`${job.fetchedCount} posts · ${job.apiCalls} API calls`);
        setStatus("done");
        setCacheHit(false);
        fetchCredits(); // Refresh credit balance
      }
    } catch {
      setStatus("failed");
      setError("Network error while polling");
    }
  }, []);

  const handleUnlock = async () => {
    const raw = username.trim().replace(/^@/, "");
    if (!raw) return;

    cleanup();
    setStatus("running");
    setError(null);
    setTweets([]);
    setCacheHit(false);
    setJobInfo("Starting…");
    
    // Clear account state during unlock
    setAccountStatus("idle");
    setAccountData(null);
    setAccountError(null);

    try {
      const res = await fetch("/api/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: raw }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setStatus("failed");
        setError(data.error || `HTTP ${res.status}`);
        return;
      }

      const unlock: UnlockResponse = await res.json();

      // ── Cache hit: artificial delay then show from DB ──
      if (unlock.status === "cache-hit" && unlock.accountId) {
        setJobInfo("Unlocking…");
        await sleep(ARTIFICIAL_DELAY_MS);
        const loaded = await loadTweets(unlock.accountId);
        setTweets(loaded);
        setJobInfo(`${loaded.length} posts · cached`);
        setStatus("done");
        setCacheHit(true);
        fetchCredits(); // Refresh credit balance
        return;
      }

      // ── Active job (new or attached) → poll ──
      if (unlock.jobId) {
        setJobInfo("Excavating…");
        pollJob(unlock.jobId);
      }
    } catch {
      setStatus("failed");
      setError("Network error");
    }
  };

  return (
    <main className="max-w-2xl mx-auto px-4 py-12">
      {/* Header */}
      <h1 className="text-2xl font-bold mb-1">STELA</h1>
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
              setUsername(cleanValue);
              // Clear account data when typing (no API calls)
              if (cleanValue !== username) {
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
          disabled={!username.trim() || username.length < 3 || accountStatus === "loading"}
          className="bg-zinc-700 text-white font-semibold text-sm px-4 py-2 rounded-lg hover:bg-zinc-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {accountStatus === "loading" ? "Checking…" : "Lookup"}
        </button>
        <button
          onClick={handleUnlock}
          disabled={!accountData || accountData.protected || status === "running"}
          className="bg-white text-black font-semibold text-sm px-4 py-2 rounded-lg hover:bg-zinc-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Unlock earliest 100
        </button>
      </div>

      {/* Account Header Preview */}
      {(accountStatus !== "idle" || accountData) && (
        <div className="mb-4">
          <AccountHeader 
            status={accountStatus} 
            data={accountData} 
            error={accountError} 
          />
        </div>
      )}

      {/* Status bar */}
      <div className="flex items-center gap-2 mb-6">
        <StatusBadge status={status} />
        <span className="text-xs bg-blue-900/30 text-blue-400 px-2 py-0.5 rounded border border-blue-800">
          {credits} credits
        </span>
        {cacheHit && (
          <span className="text-xs bg-zinc-800 text-zinc-400 px-2 py-0.5 rounded">
            from cache
          </span>
        )}
        {jobInfo && <span className="text-xs text-zinc-500">{jobInfo}</span>}
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>

      {/* Likes graph */}
      {tweets.length > 0 && <LikesGraph tweets={tweets} />}

      {/* Tweet list */}
      {tweets.length > 0 ? (
        <div className="space-y-0 border border-zinc-800 rounded-lg overflow-hidden">
          {tweets.map((t) => (
            <TweetCard key={t.post_id} tweet={t} />
          ))}
        </div>
      ) : (
        <div className="border border-zinc-800 rounded-lg min-h-[200px] flex items-center justify-center">
          <p className="text-zinc-600 text-sm">
            {status === "idle" && "Enter a username to unlock their earliest posts."}
            {status === "running" && "Excavating…"}
            {status === "done" && "No posts found."}
            {status === "failed" && "Unlock failed."}
          </p>
        </div>
      )}
    </main>
  );
}

/* ─── Components ─────────────────────────────────────── */

function StatusBadge({ status }: { status: Status }) {
  const styles: Record<Status, string> = {
    idle: "bg-zinc-800 text-zinc-400",
    running: "bg-blue-900/50 text-blue-400",
    done: "bg-green-900/50 text-green-400",
    failed: "bg-red-900/50 text-red-400",
  };
  const labels: Record<Status, string> = {
    idle: "Idle",
    running: "Excavating…",
    done: "Done",
    failed: "Failed",
  };
  return (
    <span className={`inline-block text-xs px-2 py-0.5 rounded ${styles[status]}`}>
      {labels[status]}
    </span>
  );
}

function TweetCard({ tweet }: { tweet: TweetData }) {
  const date = new Date(tweet.created_at);
  const dateStr = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <article className="px-4 py-3 border-b border-zinc-800 last:border-b-0 hover:bg-zinc-900/50 transition-colors">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs text-zinc-500">{dateStr}</span>
      </div>
      <p className="text-sm text-zinc-200 whitespace-pre-wrap break-words mb-2">
        {tweet.full_text}
      </p>
      <div className="flex gap-4 text-xs text-zinc-500">
        <span>♥ {fmt(tweet.like_count)}</span>
        <span>⟲ {fmt(tweet.retweet_count)}</span>
        <span>💬 {fmt(tweet.reply_count)}</span>
      </div>
    </article>
  );
}

function LikesGraph({ tweets }: { tweets: TweetData[] }) {
  const maxLikes = Math.max(...tweets.map((t) => t.like_count), 1);

  return (
    <div className="mb-6">
      <h2 className="text-xs font-semibold text-zinc-400 mb-2 uppercase tracking-wide">
        Likes across earliest {tweets.length} posts
      </h2>
      <div className="flex items-end gap-px h-24 bg-zinc-900 rounded-lg p-2 border border-zinc-800">
        {tweets.map((t) => {
          const h = Math.max((t.like_count / maxLikes) * 100, 2);
          return (
            <div
              key={t.post_id}
              className="flex-1 bg-blue-500 rounded-t-sm hover:bg-blue-400 transition-colors"
              style={{ height: `${h}%` }}
              title={`${t.like_count} likes — ${new Date(t.created_at).toLocaleDateString()}`}
            />
          );
        })}
      </div>
    </div>
  );
}

function AccountHeader({ status, data, error }: { 
  status: AccountStatus; 
  data: AccountData | null; 
  error: string | null; 
}) {
  if (status === "loading") {
    return (
      <div className="flex items-center gap-3 p-3 bg-blue-900/20 border border-blue-800 rounded-lg">
        <div className="w-12 h-12 bg-blue-800/30 rounded-full animate-pulse" />
        <div className="flex-1">
          <div className="h-4 bg-blue-800/30 rounded animate-pulse mb-1" />
          <div className="h-3 bg-blue-800/30 rounded animate-pulse w-1/2" />
        </div>
        <div className="text-blue-400 text-sm">Checking account…</div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="p-3 bg-red-900/20 border border-red-800 rounded-lg">
        <div className="flex items-center gap-2">
          <span className="text-red-400 text-sm">⚠</span>
          <span className="text-red-400 text-sm">{error}</span>
        </div>
      </div>
    );
  }

  if (status === "found" && data) {
    const joinDate = data.created_at ? new Date(data.created_at).toLocaleDateString("en-US", {
      month: "short",
      year: "numeric"
    }) : null;

    return (
      <div className={`flex items-center gap-3 p-3 border rounded-lg ${
        data.protected 
          ? "bg-orange-900/20 border-orange-700" 
          : "bg-green-900/20 border-green-800"
      }`}>
        <div className="w-12 h-12 bg-zinc-700 rounded-full overflow-hidden flex-shrink-0">
          {data.avatar_url ? (
            <img 
              src={data.avatar_url} 
              alt={`@${data.username}`}
              className="w-full h-full object-cover"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-zinc-400 text-xs">
              @
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-zinc-200 truncate">
              {data.display_name || `@${data.username}`}
            </span>
            {data.protected && (
              <span className="text-xs bg-orange-800 text-orange-200 px-2 py-1 rounded">
                🔒 Protected
              </span>
            )}
            {!data.protected && (
              <span className="text-xs bg-green-800 text-green-200 px-2 py-1 rounded">
                ✓ Public
              </span>
            )}
            {data.source === "cache" && (
              <span className="text-xs bg-zinc-700 text-zinc-400 px-1.5 py-0.5 rounded">
                cached
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <span>@{data.username}</span>
            {joinDate && (
              <>
                <span>•</span>
                <span>Joined {joinDate}</span>
              </>
            )}
          </div>
          {data.protected && (
            <div className="text-xs text-orange-300 mt-1">
              🚫 Unlock disabled - This account is protected
            </div>
          )}
          {!data.protected && (
            <div className="text-xs text-green-400 mt-1">
              ✅ Ready to unlock earliest 100 posts
            </div>
          )}
        </div>
      </div>
    );
  }

  return null;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
