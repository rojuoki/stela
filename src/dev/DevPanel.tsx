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

  const fetchCredits = useCallback(async () => {
    try {
      const res = await apiFetch("/api/credits");
      if (res.ok) {
        const data = await res.json();
        setCredits(data.balance);
      }
    } catch {
      // ignore
    }
  }, []);

  // Sync error injection state from localStorage (also refreshed by stelaDevChanged
  // so the "once" auto-clear in apiFetch is reflected in the UI).
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
      syncErrorState(); // picks up auto-clear from apiFetch "once" logic
    };
    window.addEventListener("stelaDevChanged", handler);
    return () => window.removeEventListener("stelaDevChanged", handler);
  }, [fetchCredits, syncErrorState]);

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
    } finally {
      setBusy(false);
    }
  };

  const adjustBalance = (delta: number) => {
    setBalance(Math.max(0, (credits ?? 0) + delta));
  };

  // ── Unlock tools ──────────────────────────────────────────────────────────

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
          "deleted" in data
            ? `deleted ${data.deleted}`
            : "cap" in data
              ? `cap=${data.cap}`
              : "ok";
        setUnlockStatus(`✓ ${detail}`);
        dispatchDevChanged();
      } else {
        setUnlockStatus(`✗ ${data.error ?? res.status}`);
      }
    } catch {
      setUnlockStatus("✗ network error");
    }
  };

  // ── Error injection ───────────────────────────────────────────────────────

  const handleErrorModeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const m = e.target.value as DevErrorMode;
    setErrorModeState(m);
    setDevErrorMode(m);
    // no dispatchDevChanged – changing mode alone doesn't affect credits/plan UI
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

  const handleClearErrorMode = () => {
    setErrorModeState("none");
    setDevErrorMode("none");
  };

  // ── Unlock tools ──────────────────────────────────────────────────────────

  const normalizedTarget = targetUsername.replace(/^@/, "").trim();

  const handleResetUser = () => {
    callDevApi("/api/dev/resetUser", { userId });
  };

  const handleResetAccount = () => {
    if (!normalizedTarget) return setUnlockStatus("✗ enter a username");
    callDevApi("/api/dev/resetAccount", { userId, username: normalizedTarget });
  };

  const handleForceUnlock = () => {
    if (!normalizedTarget) return setUnlockStatus("✗ enter a username");
    callDevApi("/api/dev/forceUnlock", { userId, username: normalizedTarget, cap });
  };

  return (
    <div className="fixed top-4 right-4 z-50 bg-zinc-900 border border-zinc-700 rounded-lg p-3 shadow-lg min-w-[200px]">
      <p className="text-zinc-500 text-[10px] font-mono uppercase tracking-widest mb-2">
        Dev Panel
      </p>

      {/* Active User */}
      <label className="text-zinc-400 text-xs block mb-1">Active User</label>
      <select
        value={userId}
        onChange={handleUserChange}
        className="w-full bg-zinc-800 border border-zinc-600 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-zinc-500 mb-2"
      >
        {DEV_USERS.map((u) => (
          <option key={u} value={u}>{u}</option>
        ))}
      </select>

      {/* Plan */}
      <label className="text-zinc-400 text-xs block mb-1">Plan</label>
      <select
        value={plan}
        onChange={handlePlanChange}
        className="w-full bg-zinc-800 border border-zinc-600 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-zinc-500 mb-3"
      >
        {DEV_PLANS.map((p) => (
          <option key={p} value={p}>{p}</option>
        ))}
      </select>

      {/* Credits */}
      <div className="flex items-center justify-between mb-1">
        <label className="text-zinc-400 text-xs">Credits</label>
        <span className="text-white text-xs font-mono">
          {credits === null ? "…" : credits}
        </span>
      </div>
      <div className="flex gap-1 mb-1">
        <button onClick={() => adjustBalance(1)} disabled={busy}
          className="flex-1 bg-zinc-700 hover:bg-zinc-600 disabled:opacity-40 text-white text-xs rounded py-1 transition-colors">
          +1
        </button>
        <button onClick={() => adjustBalance(-1)} disabled={busy || (credits ?? 0) <= 0}
          className="flex-1 bg-zinc-700 hover:bg-zinc-600 disabled:opacity-40 text-white text-xs rounded py-1 transition-colors">
          −1
        </button>
      </div>
      <div className="flex gap-1 mb-3">
        {[0, 3, 10].map((n) => (
          <button key={n} onClick={() => setBalance(n)} disabled={busy}
            className="flex-1 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-zinc-300 text-xs rounded py-1 transition-colors">
            ={n}
          </button>
        ))}
      </div>

      {/* Divider */}
      <div className="border-t border-zinc-700 mb-2" />

      {/* Unlock tools */}
      <p className="text-zinc-500 text-[10px] font-mono uppercase tracking-widest mb-2">
        Unlock tools
      </p>

      {/* Target username + cap */}
      <div className="flex gap-1 mb-1">
        <input
          type="text"
          value={targetUsername}
          onChange={(e) => setTargetUsername(e.target.value)}
          placeholder="@username"
          className="flex-1 min-w-0 bg-zinc-800 border border-zinc-600 rounded px-2 py-1 text-xs text-white placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
        />
        <select
          value={cap}
          onChange={(e) => setCap(Number(e.target.value) as 50 | 75 | 100)}
          className="bg-zinc-800 border border-zinc-600 rounded px-1 py-1 text-xs text-white focus:outline-none"
        >
          <option value={50}>50</option>
          <option value={75}>75</option>
          <option value={100}>100</option>
        </select>
      </div>

      {/* Buttons */}
      <button
        onClick={handleResetUser}
        className="w-full bg-zinc-800 hover:bg-red-900/50 text-zinc-400 hover:text-red-300 text-xs rounded py-1 mb-1 transition-colors text-left px-2"
      >
        Reset ALL unlocks (this user)
      </button>
      <div className="flex gap-1 mb-2">
        <button
          onClick={handleResetAccount}
          className="flex-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs rounded py-1 transition-colors"
        >
          Reset account
        </button>
        <button
          onClick={handleForceUnlock}
          className="flex-1 bg-zinc-800 hover:bg-green-900/50 text-zinc-300 hover:text-green-300 text-xs rounded py-1 transition-colors"
        >
          Force unlock
        </button>
      </div>

      {/* Status */}
      {unlockStatus && (
        <p className={`text-[10px] font-mono truncate ${unlockStatus.startsWith("✓") ? "text-green-500" : "text-red-400"}`}>
          {unlockStatus}
        </p>
      )}

      {/* Divider */}
      <div className="border-t border-zinc-700 mt-2 mb-2" />

      {/* Error injection */}
      <p className="text-zinc-500 text-[10px] font-mono uppercase tracking-widest mb-2">
        Error injection
      </p>

      {/* Mode dropdown + Clear */}
      <div className="flex gap-1 mb-1">
        <select
          value={errorMode}
          onChange={handleErrorModeChange}
          className={`flex-1 bg-zinc-800 border rounded px-2 py-1 text-xs focus:outline-none ${
            errorMode !== "none"
              ? "border-orange-500 text-orange-300"
              : "border-zinc-600 text-white"
          }`}
        >
          {DEV_ERROR_MODES.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
        {errorMode !== "none" && (
          <button
            onClick={handleClearErrorMode}
            className="bg-zinc-800 hover:bg-zinc-700 border border-zinc-600 text-zinc-400 hover:text-white text-xs rounded px-2 py-1 transition-colors"
          >
            ✕
          </button>
        )}
      </div>

      {/* Delay ms input — only when mode=delay */}
      {errorMode === "delay" && (
        <div className="flex items-center gap-1 mb-1">
          <label className="text-zinc-500 text-[10px] whitespace-nowrap">ms</label>
          <input
            type="number"
            min={100}
            max={30000}
            step={500}
            value={delayMs}
            onChange={handleDelayMsChange}
            className="flex-1 bg-zinc-800 border border-zinc-600 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-zinc-500"
          />
        </div>
      )}

      {/* Next request only toggle */}
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={errorOnce}
          onChange={handleErrorOnceChange}
          className="accent-orange-500"
        />
        <span className="text-zinc-400 text-[10px]">Next request only</span>
      </label>
    </div>
  );
}
