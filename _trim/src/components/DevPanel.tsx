"use client";

/**
 * DevPanel — visible only when NEXT_PUBLIC_DEV_PANEL=1.
 * Feature #3: Unlock scope browser.
 * Feature #4: Cost / API usage rollups.
 * Feature #5: Queue viewer with per-job cancel.
 */

import { useState, useEffect, useCallback, useRef } from "react";

// ─── Types ─────────────────────────────────────────────

interface DevUnlockEntry {
  account_id: string;
  job_id: string;
  unlocked_at: string;
  username: string | null;
  account_created_at: string | null;
  cap: number | null;
  unlocked_count: number;
}

interface ApiCostStats {
  calls_total: number;
  calls_last_24h: number;
  calls_by_endpoint: Record<string, number>;
  cache_saved_calls: number;
  estimated_cost_usd: number;
  cache_saved_cost_usd: number;
  cost_per_call_usd: number;
}

interface DevPanelProps {
  /** Called when the user clicks "View" on an entry — load that username in the main UI. */
  onView: (username: string) => void;
}

// ─── Shared helpers ─────────────────────────────────────

function fmt(n: number) {
  return n.toLocaleString("en-US");
}

function fmtUsd(n: number) {
  return n < 0.01 && n > 0
    ? `<$0.01`
    : `$${n.toFixed(2)}`;
}

// ─── Sub-components ─────────────────────────────────────

function SectionHeader({
  label,
  count,
  children,
}: {
  label: string;
  count?: number;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between mb-3">
      <span className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest">
        {label}
        {count !== undefined && count > 0 && (
          <span className="ml-2 text-zinc-600">({count})</span>
        )}
      </span>
      {children}
    </div>
  );
}

interface DevJobEntry {
  id: string;
  username: string;
  status: "running" | "queued" | "waiting_rate_limit";
  queuePosition: number | null;
  apiCalls: number;
  fetchedCount: number;
  requestedLimit: number;
  createdAt: string | null;
  startedAt: string | null;
  resumeAt: string | null;
}

// ─── Queue section ──────────────────────────────────────

function QueueSection() {
  const [jobs, setJobs] = useState<DevJobEntry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch("/api/dev/jobs");
      if (!res.ok) return;
      const data = await res.json();
      setJobs(data.jobs ?? []);
    } catch {
      // silent — polling, don't flash errors
    }
  }, []);

  // Initial fetch on mount.
  useEffect(() => { fetchJobs(); }, [fetchJobs]);

  // 2 s while jobs are active; 30 s when idle (avoid spamming the server).
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(fetchJobs, jobs.length > 0 ? 2000 : 30_000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchJobs, jobs.length]);

  const handleCancel = async (jobId: string) => {
    setBusy(jobId);
    setError(null);
    try {
      const res = await fetch(`/api/dev/jobs?id=${encodeURIComponent(jobId)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      await fetchJobs();
    } catch {
      setError("Network error");
    } finally {
      setBusy(null);
    }
  };

  if (jobs.length === 0) return null;

  return (
    <div className="mt-6 pt-5 border-t border-zinc-800">
      <SectionHeader label="Dev · Queue" count={jobs.length} />

      {error && <p className="text-[11px] text-red-400 mb-2">{error}</p>}

      <div className="space-y-1">
        {jobs.map((job) => {
          const isBusy = busy === job.id;
          const statusColor =
            job.status === "running"
              ? "text-emerald-400"
              : job.status === "waiting_rate_limit"
                ? "text-yellow-500"
                : "text-zinc-500";
          const statusLabel =
            job.status === "running"
              ? "running"
              : job.status === "waiting_rate_limit"
                ? "rate-limit"
                : `queued #${job.queuePosition ?? "?"}`;

          return (
            <div
              key={job.id}
              className="grid grid-cols-[1fr_72px_64px_64px_auto] gap-x-3 items-center text-[12px] bg-zinc-900 rounded-lg px-3 py-1.5"
            >
              <span className="text-zinc-200 truncate">@{job.username}</span>

              <span className={`text-[11px] ${statusColor}`}>{statusLabel}</span>

              <span className="tabular-nums text-zinc-500 text-right text-[11px]">
                {job.apiCalls}
                <span className="text-zinc-700"> calls</span>
              </span>

              <span className="tabular-nums text-zinc-400 text-right">
                {job.fetchedCount}
                <span className="text-zinc-700">/{job.requestedLimit}</span>
              </span>

              <button
                onClick={() => handleCancel(job.id)}
                disabled={isBusy}
                className="text-red-700 hover:text-red-400 transition-colors disabled:opacity-40 text-[11px]"
              >
                {isBusy ? "…" : "Cancel"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Cost section ───────────────────────────────────────

function CostSection() {
  const [stats, setStats] = useState<ApiCostStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStats = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/dev/cost");
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setStats(await res.json());
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  return (
    <div className="mt-6 pt-5 border-t border-zinc-800">
      <SectionHeader label="Dev · Cost / API usage">
        <button
          onClick={fetchStats}
          disabled={loading}
          className="text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-40"
        >
          {loading ? "loading…" : "refresh"}
        </button>
      </SectionHeader>

      {error && <p className="text-[11px] text-red-400 mb-2">{error}</p>}

      {!stats && !loading && !error && (
        <p className="text-[11px] text-zinc-700">No data yet.</p>
      )}

      {stats && (
        <div className="space-y-3">
          {/* Summary row */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Metric
              label="calls total"
              value={fmt(stats.calls_total)}
              sub={`~${fmtUsd(stats.estimated_cost_usd)}`}
            />
            <Metric
              label="calls 24 h"
              value={fmt(stats.calls_last_24h)}
            />
            <Metric
              label="cache saves"
              value={fmt(stats.cache_saved_calls)}
              sub={`saved ~${fmtUsd(stats.cache_saved_cost_usd)}`}
              highlight
            />
            <Metric
              label="$/call"
              value={`$${stats.cost_per_call_usd.toFixed(2)}`}
              sub="configurable"
              dim
            />
          </div>

          {/* Endpoint breakdown */}
          {Object.keys(stats.calls_by_endpoint).length > 0 && (
            <div>
              <p className="text-[10px] text-zinc-600 uppercase tracking-wider mb-1 px-1">
                by endpoint
              </p>
              <div className="space-y-0.5">
                {Object.entries(stats.calls_by_endpoint).map(
                  ([endpoint, count]) => {
                    const pct =
                      stats.calls_total > 0
                        ? Math.round((count / stats.calls_total) * 100)
                        : 0;
                    return (
                      <div
                        key={endpoint}
                        className="flex items-center gap-2 text-[11px] bg-zinc-900 rounded px-3 py-1"
                      >
                        <span className="text-zinc-400 flex-1 truncate font-mono">
                          {endpoint}
                        </span>
                        <span className="tabular-nums text-zinc-300">
                          {fmt(count)}
                        </span>
                        <span className="tabular-nums text-zinc-600 w-8 text-right">
                          {pct}%
                        </span>
                      </div>
                    );
                  }
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  sub,
  highlight,
  dim,
}: {
  label: string;
  value: string;
  sub?: string;
  highlight?: boolean;
  dim?: boolean;
}) {
  return (
    <div className="bg-zinc-900 rounded-lg px-3 py-2">
      <p className="text-[10px] text-zinc-600 uppercase tracking-wider">{label}</p>
      <p
        className={`text-[15px] font-semibold tabular-nums mt-0.5 ${
          highlight
            ? "text-emerald-400"
            : dim
              ? "text-zinc-600"
              : "text-zinc-200"
        }`}
      >
        {value}
      </p>
      {sub && <p className="text-[10px] text-zinc-600 mt-0.5">{sub}</p>}
    </div>
  );
}

// ─── Main DevPanel ───────────────────────────────────────

export function DevPanel({ onView }: DevPanelProps) {
  const [unlocks, setUnlocks] = useState<DevUnlockEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const fetchUnlocks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/dev/unlocks");
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      const data = await res.json();
      setUnlocks(data.unlocks ?? []);
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUnlocks();
  }, [fetchUnlocks]);

  const handleReset = async (username: string | null) => {
    const key = username ?? "all";
    setBusy(key);
    setError(null);
    try {
      const url = username
        ? `/api/dev/unlocks?username=${encodeURIComponent(username)}`
        : "/api/dev/unlocks";
      const res = await fetch(url, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      await fetchUnlocks();
    } catch {
      setError("Network error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="mt-12 border border-zinc-800 rounded-xl p-4 font-mono">
      {/* ── Unlocks section ── */}
      <SectionHeader label="Dev · Unlocks" count={unlocks.length}>
        <div className="flex items-center gap-3">
          <button
            onClick={fetchUnlocks}
            disabled={loading}
            className="text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-40"
          >
            {loading ? "loading…" : "refresh"}
          </button>
          {unlocks.length > 0 && (
            <button
              onClick={() => handleReset(null)}
              disabled={busy === "all"}
              className="text-[11px] text-red-600 hover:text-red-400 transition-colors disabled:opacity-40"
            >
              {busy === "all" ? "resetting…" : "Reset ALL"}
            </button>
          )}
        </div>
      </SectionHeader>

      {error && <p className="text-[11px] text-red-400 mb-2">{error}</p>}

      {!loading && unlocks.length === 0 && (
        <p className="text-[11px] text-zinc-700">No unlocks yet.</p>
      )}

      {unlocks.length > 0 && (
        <>
          <div className="grid grid-cols-[1fr_80px_56px_80px_auto] gap-x-3 text-[10px] text-zinc-600 uppercase tracking-wider mb-1 px-1">
            <span>username</span>
            <span className="text-right">tweets</span>
            <span className="text-right">joined</span>
            <span>updated</span>
            <span />
          </div>

          <div className="space-y-1">
            {unlocks.map((u) => {
              const name = u.username ?? u.account_id;
              const year = u.account_created_at
                ? new Date(u.account_created_at).getFullYear()
                : null;
              const updatedDate = new Date(u.unlocked_at).toLocaleDateString(
                "en-US",
                { month: "short", day: "numeric", year: "2-digit" }
              );
              const cap = u.cap ?? 100;
              const isRowBusy = busy === name;

              return (
                <div
                  key={u.account_id}
                  className="grid grid-cols-[1fr_80px_56px_80px_auto] gap-x-3 items-center text-[12px] bg-zinc-900 rounded-lg px-3 py-1.5"
                >
                  <span className="text-zinc-200 truncate">@{name}</span>

                  <span className="text-right tabular-nums text-zinc-400">
                    {u.unlocked_count}
                    <span className="text-zinc-700">/{cap}</span>
                  </span>

                  <span className="text-right text-zinc-600">
                    {year ?? "—"}
                  </span>

                  <span className="text-zinc-600 text-[11px]">{updatedDate}</span>

                  <div className="flex items-center gap-3 justify-end">
                    <button
                      onClick={() => onView(name)}
                      className="text-zinc-400 hover:text-zinc-100 transition-colors"
                    >
                      View
                    </button>
                    <button
                      onClick={() => handleReset(name)}
                      disabled={isRowBusy}
                      className="text-red-700 hover:text-red-400 transition-colors disabled:opacity-40"
                    >
                      {isRowBusy ? "…" : "Reset"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* ── Queue section ── */}
      <QueueSection />

      {/* ── Cost section ── */}
      <CostSection />
    </section>
  );
}
