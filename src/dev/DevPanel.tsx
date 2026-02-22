"use client";

import { useState, useEffect, useCallback } from "react";
import {
  DEV_USERS,
  DEV_PLANS,
  type DevPlan,
  DEV_ERROR_MODES,
  type DevErrorMode,
  getDevUserId,
  setDevUserId,
  getDevPlan,
  setDevPlan,
  getDevErrorMode,
  setDevErrorMode,
  getDevDelayMs,
  setDevDelayMs,
  getDevErrorOnce,
  setDevErrorOnce,
  dispatchDevChanged,
} from "./state";
import { apiFetch } from "@/lib/apiFetch";

// ── Stats types (mirrors devStats.ts — client-side copy) ──────────────────────
type ScopeRow = {
  count: number; ok: number; err: number;
  p50ms: number; p95ms: number; maxms: number;
  lastStatus?: number; lastTs?: number;
};
type StatEntry = {
  ts: number; scope: string; route: string;
  userId?: string; username?: string;
  status: number; ms: number; note?: string;
};
type Stats = {
  entries: StatEntry[];
  byScope: Record<string, ScopeRow>;
  totals: { count: number; ok: number; err: number };
  xapi: { calls: number; http429: number; last429Ts?: number };
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function ago(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}
function statusCls(status: number): string {
  if (status < 300) return "text-green-400";
  if (status < 500) return "text-orange-400";
  return "text-red-400";
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function DevPanel() {
  const [userId, setUserId] = useState("guest");
  const [plan, setPlan] = useState<DevPlan>("basic");
  const [credits, setCredits] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  // Unlock tools state
  const [targetUsername, setTargetUsername] = useState("");
  const [cap, setCap] = useState<50 | 75 | 100>(100);
  const [unlockStatus, setUnlockStatus] = useState<string | null>(null);

  // Error injection state
  const [errorMode, setErrorModeState] = useState<DevErrorMode>("none");
  const [delayMs, setDelayMsState] = useState(2000);
  const [errorOnce, setErrorOnceState] = useState(true);

  // Stats state
  const [statsOpen, setStatsOpen] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);

  const fetchCredits = useCallback(async () => {
    try {
      const res = await apiFetch("/api/credits");
      if (res.ok) {
        const data = await res.json();
        setCredits(data.balance);
      }
    } catch { /* ignore */ }
  }, []);

  // Use raw fetch for stats — avoids recording stats calls in stats + avoids
  // error injection affecting the dev dashboard itself.
  const fetchStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      const res = await fetch("/api/dev/stats");
      if (res.ok) setStats(await res.json());
    } catch { /* ignore */ } finally {
      setStatsLoading(false);
    }
  }, []);

  const resetStats = async () => {
    await fetch("/api/dev/stats/reset", { method: "POST" });
    fetchStats();
  };

  const syncErrorState = useCallback(() => {
    setErrorModeState(getDevErrorMode());
    setDelayMsState(getDevDelayMs());
    setErrorOnceState(getDevErrorOnce());
  }, []);

  useEffect(() => {
    setUserId(getDevUserId());
    setPlan(getDevPlan());
    fetchCredits();
    syncErrorState();
  }, [fetchCredits, syncErrorState]);

  useEffect(() => {
    const handler = () => {
      setCredits(null);
      fetchCredits();
      syncErrorState();
    };
    window.addEventListener("stelaDevChanged", handler);
    return () => window.removeEventListener("stelaDevChanged", handler);
  }, [fetchCredits, syncErrorState]);

  // Auto-refresh stats whenever the section is open and something changes
  useEffect(() => {
    if (statsOpen) fetchStats();
  }, [statsOpen, fetchStats]);

  // ── Handlers ────────────────────────────────────────────────────────────────

  const handleUserChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newId = e.target.value;
    setUserId(newId);
    setDevUserId(newId);
    setCredits(null);
    setUnlockStatus(null);
    dispatchDevChanged();
  };

  const handlePlanChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newPlan = e.target.value as DevPlan;
    setPlan(newPlan);
    setDevPlan(newPlan);
    dispatchDevChanged();
  };

  const setBalance = async (target: number) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/dev/credits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, balance: target }),
      });
      if (res.ok) {
        const data = await res.json();
        setCredits(data.balance);
        dispatchDevChanged();
      }
    } finally { setBusy(false); }
  };

  const adjustBalance = (delta: number) => setBalance(Math.max(0, (credits ?? 0) + delta));

  const callDevApi = async (path: string, body: object) => {
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok) {
        const detail =
          "deleted" in data ? `deleted ${data.deleted}`
          : "cap" in data ? `cap=${data.cap}`
          : "ok";
        setUnlockStatus(`✓ ${detail}`);
        dispatchDevChanged();
      } else {
        setUnlockStatus(`✗ ${data.error ?? res.status}`);
      }
    } catch { setUnlockStatus("✗ network error"); }
  };

  const handleErrorModeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const m = e.target.value as DevErrorMode;
    setErrorModeState(m);
    setDevErrorMode(m);
  };

  const handleDelayMsChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseInt(e.target.value, 10);
    const clamped = isNaN(v) ? 2000 : Math.max(100, Math.min(30_000, v));
    setDelayMsState(clamped);
    setDevDelayMs(clamped);
  };

  const handleErrorOnceChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.checked;
    setErrorOnceState(v);
    setDevErrorOnce(v);
  };

  const handleClearErrorMode = () => { setErrorModeState("none"); setDevErrorMode("none"); };

  const normalizedTarget = targetUsername.replace(/^@/, "").trim();
  const handleResetUser = () => callDevApi("/api/dev/resetUser", { userId });
  const handleResetAccount = () => {
    if (!normalizedTarget) return setUnlockStatus("✗ enter a username");
    callDevApi("/api/dev/resetAccount", { userId, username: normalizedTarget });
  };
  const handleForceUnlock = () => {
    if (!normalizedTarget) return setUnlockStatus("✗ enter a username");
    callDevApi("/api/dev/forceUnlock", { userId, username: normalizedTarget, cap });
  };

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="fixed top-4 right-4 z-50 bg-zinc-900 border border-zinc-700 rounded-lg p-3 shadow-lg w-[240px]">
      <p className="text-zinc-500 text-[10px] font-mono uppercase tracking-widest mb-2">
        Dev Panel
      </p>

      {/* Active User */}
      <label className="text-zinc-400 text-xs block mb-1">Active User</label>
      <select value={userId} onChange={handleUserChange}
        className="w-full bg-zinc-800 border border-zinc-600 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-zinc-500 mb-2">
        {DEV_USERS.map((u) => <option key={u} value={u}>{u}</option>)}
      </select>

      {/* Plan */}
      <label className="text-zinc-400 text-xs block mb-1">Plan</label>
      <select value={plan} onChange={handlePlanChange}
        className="w-full bg-zinc-800 border border-zinc-600 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-zinc-500 mb-3">
        {DEV_PLANS.map((p) => <option key={p} value={p}>{p}</option>)}
      </select>

      {/* Credits */}
      <div className="flex items-center justify-between mb-1">
        <label className="text-zinc-400 text-xs">Credits</label>
        <span className="text-white text-xs font-mono">{credits === null ? "…" : credits}</span>
      </div>
      <div className="flex gap-1 mb-1">
        <button onClick={() => adjustBalance(1)} disabled={busy}
          className="flex-1 bg-zinc-700 hover:bg-zinc-600 disabled:opacity-40 text-white text-xs rounded py-1 transition-colors">+1</button>
        <button onClick={() => adjustBalance(-1)} disabled={busy || (credits ?? 0) <= 0}
          className="flex-1 bg-zinc-700 hover:bg-zinc-600 disabled:opacity-40 text-white text-xs rounded py-1 transition-colors">−1</button>
      </div>
      <div className="flex gap-1 mb-3">
        {[0, 3, 10].map((n) => (
          <button key={n} onClick={() => setBalance(n)} disabled={busy}
            className="flex-1 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-zinc-300 text-xs rounded py-1 transition-colors">={n}</button>
        ))}
      </div>

      {/* Divider */}
      <div className="border-t border-zinc-700 mb-2" />

      {/* Unlock tools */}
      <p className="text-zinc-500 text-[10px] font-mono uppercase tracking-widest mb-2">Unlock tools</p>
      <div className="flex gap-1 mb-1">
        <input type="text" value={targetUsername} onChange={(e) => setTargetUsername(e.target.value)}
          placeholder="@username"
          className="flex-1 min-w-0 bg-zinc-800 border border-zinc-600 rounded px-2 py-1 text-xs text-white placeholder-zinc-600 focus:outline-none focus:border-zinc-500" />
        <select value={cap} onChange={(e) => setCap(Number(e.target.value) as 50 | 75 | 100)}
          className="bg-zinc-800 border border-zinc-600 rounded px-1 py-1 text-xs text-white focus:outline-none">
          <option value={50}>50</option>
          <option value={75}>75</option>
          <option value={100}>100</option>
        </select>
      </div>
      <button onClick={handleResetUser}
        className="w-full bg-zinc-800 hover:bg-red-900/50 text-zinc-400 hover:text-red-300 text-xs rounded py-1 mb-1 transition-colors text-left px-2">
        Reset ALL unlocks (this user)
      </button>
      <div className="flex gap-1 mb-2">
        <button onClick={handleResetAccount}
          className="flex-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs rounded py-1 transition-colors">Reset account</button>
        <button onClick={handleForceUnlock}
          className="flex-1 bg-zinc-800 hover:bg-green-900/50 text-zinc-300 hover:text-green-300 text-xs rounded py-1 transition-colors">Force unlock</button>
      </div>
      {unlockStatus && (
        <p className={`text-[10px] font-mono truncate ${unlockStatus.startsWith("✓") ? "text-green-500" : "text-red-400"}`}>
          {unlockStatus}
        </p>
      )}

      {/* Divider */}
      <div className="border-t border-zinc-700 mt-2 mb-2" />

      {/* Error injection */}
      <p className="text-zinc-500 text-[10px] font-mono uppercase tracking-widest mb-2">Error injection</p>
      <div className="flex gap-1 mb-1">
        <select value={errorMode} onChange={handleErrorModeChange}
          className={`flex-1 bg-zinc-800 border rounded px-2 py-1 text-xs focus:outline-none ${
            errorMode !== "none" ? "border-orange-500 text-orange-300" : "border-zinc-600 text-white"}`}>
          {DEV_ERROR_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        {errorMode !== "none" && (
          <button onClick={handleClearErrorMode}
            className="bg-zinc-800 hover:bg-zinc-700 border border-zinc-600 text-zinc-400 hover:text-white text-xs rounded px-2 py-1 transition-colors">✕</button>
        )}
      </div>
      {errorMode === "delay" && (
        <div className="flex items-center gap-1 mb-1">
          <label className="text-zinc-500 text-[10px] whitespace-nowrap">ms</label>
          <input type="number" min={100} max={30000} step={500} value={delayMs}
            onChange={handleDelayMsChange}
            className="flex-1 bg-zinc-800 border border-zinc-600 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-zinc-500" />
        </div>
      )}
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input type="checkbox" checked={errorOnce} onChange={handleErrorOnceChange} className="accent-orange-500" />
        <span className="text-zinc-400 text-[10px]">Next request only</span>
      </label>

      {/* Divider */}
      <div className="border-t border-zinc-700 mt-2 mb-2" />

      {/* Stats — collapsible */}
      <div className="flex items-center justify-between mb-1">
        <button onClick={() => { setStatsOpen((o) => !o); }}
          className="text-zinc-500 text-[10px] font-mono uppercase tracking-widest hover:text-zinc-300 transition-colors flex items-center gap-1">
          <span>{statsOpen ? "▾" : "▸"}</span> Stats
          {stats && !statsOpen && (
            <span className="text-zinc-600 normal-case tracking-normal">
              {" "}({stats.totals.count})
            </span>
          )}
        </button>
        {statsOpen && (
          <div className="flex gap-1">
            <button onClick={fetchStats} disabled={statsLoading}
              className="text-zinc-500 hover:text-zinc-300 text-[10px] disabled:opacity-40 transition-colors px-1">
              {statsLoading ? "…" : "↺"}
            </button>
            <button onClick={resetStats}
              className="text-zinc-500 hover:text-red-400 text-[10px] transition-colors px-1">⌫</button>
          </div>
        )}
      </div>

      {statsOpen && (
        <div className="font-mono text-[10px] space-y-2">
          {/* byScope table */}
          {stats && Object.keys(stats.byScope).length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="text-zinc-600">
                    <th className="text-left pr-1">scope</th>
                    <th className="text-right pr-1">n</th>
                    <th className="text-right pr-1 text-green-700">ok</th>
                    <th className="text-right pr-1 text-red-700">err</th>
                    <th className="text-right pr-1">p50</th>
                    <th className="text-right pr-1">p95</th>
                    <th className="text-right">last</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(stats.byScope).map(([scope, row]) => (
                    <tr key={scope} className="text-zinc-300">
                      <td className="pr-1 text-zinc-400">{scope.slice(0, 7)}</td>
                      <td className="text-right pr-1">{row.count}</td>
                      <td className="text-right pr-1 text-green-500">{row.ok}</td>
                      <td className={`text-right pr-1 ${row.err > 0 ? "text-red-400" : "text-zinc-600"}`}>{row.err}</td>
                      <td className="text-right pr-1">{row.p50ms}</td>
                      <td className="text-right pr-1">{row.p95ms}</td>
                      <td className={`text-right ${statusCls(row.lastStatus ?? 0)}`}>
                        {row.lastStatus ?? "-"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-zinc-600">no data — make some requests first</p>
          )}

          {/* X API counters */}
          {stats && (
            <div className="text-zinc-400 leading-4">
              <span className="text-zinc-600">X API </span>
              calls:<span className="text-white">{stats.xapi.calls}</span>
              {"  "}
              429s:<span className={stats.xapi.http429 > 0 ? "text-orange-400" : "text-white"}>{stats.xapi.http429}</span>
              {stats.xapi.last429Ts && (
                <span className="text-zinc-600"> last:{ago(stats.xapi.last429Ts)}</span>
              )}
            </div>
          )}

          {/* Totals */}
          {stats && (
            <div className="text-zinc-600">
              total:{stats.totals.count}{" "}
              <span className="text-green-700">ok:{stats.totals.ok}</span>{" "}
              <span className={stats.totals.err > 0 ? "text-red-700" : ""}>err:{stats.totals.err}</span>
            </div>
          )}

          {/* Recent entries */}
          {stats && stats.entries.length > 0 && (
            <div>
              <p className="text-zinc-600 mb-0.5">recent:</p>
              <div className="space-y-0.5 max-h-40 overflow-y-auto">
                {stats.entries.map((e, i) => (
                  <div key={i} className="flex gap-1 leading-4 text-zinc-400 whitespace-nowrap">
                    <span className="text-zinc-600 w-5 shrink-0">{ago(e.ts)}</span>
                    <span className="text-zinc-500 w-6 shrink-0">{e.scope.slice(0, 5)}</span>
                    <span className={`w-6 shrink-0 ${statusCls(e.status)}`}>{e.status}</span>
                    <span className="w-8 shrink-0 text-right">{e.ms}ms</span>
                    <span className="text-zinc-500 shrink-0">{e.userId?.slice(0, 5) ?? "-"}</span>
                    {e.username && <span className="text-zinc-400">@{e.username.slice(0, 8)}</span>}
                    {e.note && <span className="text-orange-600">[{e.note}]</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {!stats && !statsLoading && (
            <button onClick={fetchStats}
              className="text-zinc-600 hover:text-zinc-400 transition-colors">
              click ↺ to load
            </button>
          )}
        </div>
      )}
    </div>
  );
}
