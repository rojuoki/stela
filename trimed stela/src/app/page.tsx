"use client";

import { useState } from "react";
import { DevPanel } from "../components/DevPanel";

/** True only when the dev panel is enabled at build time. */
const DEV_PANEL = process.env.NEXT_PUBLIC_DEV_PANEL === "1";

export default function Home() {
  const [username, setUsername] = useState("");

  // Phase 5: DevPanel functionality will be added after the main logic

  const handleLookupClick = () => {
    if (username.trim()) {
      // Phase 5: Redirect to preview page instead of inline lookup
      const cleanUsername = username.trim().replace(/^@/, "");
      window.location.href = `/user/${encodeURIComponent(cleanUsername)}`;
    }
  };

  // Phase 5: No longer need URL parameter handling on main page

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      // Phase 5: Always redirect to preview page on Enter
      if (username.trim()) {
        const cleanUsername = username.trim().replace(/^@/, "");
        window.location.href = `/user/${encodeURIComponent(cleanUsername)}`;
      }
    }
  };

  // Phase 5: DevPanel helper - redirect to preview page
  const handleViewUsername = (usernameToView: string) => {
    const clean = usernameToView.replace(/^@/, "").trim().toLowerCase();
    setUsername(clean);
    window.location.href = `/user/${encodeURIComponent(clean)}`;
  };

  // Phase 5: DEV_PANEL constant already defined at top of file

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
              setUsername(cleanValue);
            }}
            onKeyDown={handleKeyDown}
            placeholder="username (min 3 chars)"
            className="w-full bg-zinc-900 border border-zinc-700 rounded-lg pl-8 pr-3 py-2 text-sm focus:outline-none focus:border-zinc-500"
          />
        </div>
        <button
          onClick={handleLookupClick}
          disabled={!username.trim() || username.length < 3}
          className="bg-zinc-700 text-white font-semibold text-sm px-4 py-2 rounded-lg hover:bg-zinc-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Lookup
        </button>
        {/* Phase 5: Excavation now happens on preview page */}
      </div>

      {/* Phase 5: Simplified lookup-only interface */}
      <div className="border border-zinc-800 rounded-xl min-h-[200px] flex items-center justify-center">
        <p className="text-zinc-600 text-sm">
          Enter a username above and press Lookup to discover their earliest posts.
        </p>
      </div>
      {/* Dev Panel — only when NEXT_PUBLIC_DEV_PANEL=1 */}
      {DEV_PANEL && <DevPanel onView={handleViewUsername} />}
    </main>
  );
}
