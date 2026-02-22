"use client";

import { useState, useEffect, useCallback } from "react";
import { DEV_USERS, getDevUserId, setDevUserId } from "./state";
import { apiFetch } from "@/lib/apiFetch";

export default function DevPanel() {
  const [userId, setUserId] = useState("guest");
  const [credits, setCredits] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

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

  useEffect(() => {
    const id = getDevUserId();
    setUserId(id);
    fetchCredits();
  }, [fetchCredits]);

  // Refresh when main page triggers devUserChanged
  useEffect(() => {
    window.addEventListener("devUserChanged", fetchCredits);
    return () => window.removeEventListener("devUserChanged", fetchCredits);
  }, [fetchCredits]);

  const handleUserChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newId = e.target.value;
    setUserId(newId);
    setDevUserId(newId);
    setCredits(null);
    window.dispatchEvent(new Event("devUserChanged"));
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
        // Tell the main page to refresh its credit display too
        window.dispatchEvent(new Event("devUserChanged"));
      }
    } finally {
      setBusy(false);
    }
  };

  const adjustBalance = (delta: number) => {
    setBalance(Math.max(0, (credits ?? 0) + delta));
  };

  return (
    <div className="fixed top-4 right-4 z-50 bg-zinc-900 border border-zinc-700 rounded-lg p-3 shadow-lg min-w-[188px]">
      <p className="text-zinc-500 text-[10px] font-mono uppercase tracking-widest mb-2">
        Dev Panel
      </p>

      {/* Active User */}
      <label className="text-zinc-400 text-xs block mb-1">Active User</label>
      <select
        value={userId}
        onChange={handleUserChange}
        className="w-full bg-zinc-800 border border-zinc-600 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-zinc-500 mb-3"
      >
        {DEV_USERS.map((u) => (
          <option key={u} value={u}>
            {u}
          </option>
        ))}
      </select>

      {/* Credits */}
      <div className="flex items-center justify-between mb-1">
        <label className="text-zinc-400 text-xs">Credits</label>
        <span className="text-white text-xs font-mono">
          {credits === null ? "…" : credits}
        </span>
      </div>

      {/* +1 / -1 */}
      <div className="flex gap-1 mb-1">
        <button
          onClick={() => adjustBalance(1)}
          disabled={busy}
          className="flex-1 bg-zinc-700 hover:bg-zinc-600 disabled:opacity-40 text-white text-xs rounded py-1 transition-colors"
        >
          +1
        </button>
        <button
          onClick={() => adjustBalance(-1)}
          disabled={busy || (credits ?? 0) <= 0}
          className="flex-1 bg-zinc-700 hover:bg-zinc-600 disabled:opacity-40 text-white text-xs rounded py-1 transition-colors"
        >
          −1
        </button>
      </div>

      {/* Set presets */}
      <div className="flex gap-1">
        {[0, 3, 10].map((n) => (
          <button
            key={n}
            onClick={() => setBalance(n)}
            disabled={busy}
            className="flex-1 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-zinc-300 text-xs rounded py-1 transition-colors"
          >
            ={n}
          </button>
        ))}
      </div>
    </div>
  );
}
