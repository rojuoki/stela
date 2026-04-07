"use client";

import { useState } from "react";
import { DevPanel } from "../components/DevPanel";
import { useUser } from "@/contexts/UserContext";

/** True only when the dev panel is enabled at build time. */
const DEV_PANEL = process.env.NEXT_PUBLIC_DEV_PANEL === "1";

export default function Home() {
  const [username, setUsername] = useState("");
  const { user, credits } = useUser();

  const handleLookupClick = () => {
    if (username.trim()) {
      const cleanUsername = username.trim().replace(/^@/, "");
      window.location.href = `/user/${encodeURIComponent(cleanUsername)}`;
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (username.trim()) {
        const cleanUsername = username.trim().replace(/^@/, "");
        window.location.href = `/user/${encodeURIComponent(cleanUsername)}`;
      }
    }
  };

  // DevPanel helper - redirect to preview page
  const handleViewUsername = (usernameToView: string) => {
    const clean = usernameToView.replace(/^@/, "").trim().toLowerCase();
    setUsername(clean);
    window.location.href = `/user/${encodeURIComponent(clean)}`;
  };

  return (
    <div className="max-w-2xl mx-auto px-4 py-12">
      {/* Welcome Message for Authenticated Users */}
      {user && (
        <div className="mb-8 p-4 bg-zinc-900 border border-zinc-800 rounded-xl">
          <h2 className="text-lg font-semibold mb-2">Welcome back, {user.name}!</h2>
          <div className="flex items-center gap-4 text-sm text-zinc-400">
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                <path d="M8.433 7.418c.155-.103.346-.196.567-.267v1.698a2.305 2.305 0 01-.567-.267C8.07 8.34 8.07 7.949 8.433 7.418zM11 12.849v-1.698c.22.071.412.164.567.267.364.532.364.923 0 1.464-.155.103-.346.196-.567.267z" />
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-13a1 1 0 10-2 0v.092a4.535 4.535 0 00-1.676.662C6.602 6.234 6.102 7.036 6.102 8c0 .964.5 1.766 1.222 2.246.135.09.288.171.448.245.02.009.039.018.059.027.951.409 1.969.909 1.969 2.482 0 .964-.5 1.766-1.222 2.246-.135.09-.288.171-.448.245-.02.009-.039.018-.059.027-.951.409-1.969.909-1.969 2.482a1 1 0 102 0v-.092a4.535 4.535 0 001.676-.662C13.398 13.766 13.898 12.964 13.898 12c0-.964-.5-1.766-1.222-2.246a4.025 4.025 0 00-.448-.245 1.015 1.015 0 01-.059-.027C11.218 9.073 10.2 8.573 10.2 7c0-.964.5-1.766 1.222-2.246.135-.09.288-.171.448-.245.02-.009.039-.018.059-.027.351-.151.724-.297 1.071-.462V5a1 1 0 102 0z" clipRule="evenodd" />
              </svg>
              <span className="font-medium text-zinc-200">{credits}</span>
              <span>credits available</span>
            </div>
            {credits === 0 && (
              <span className="text-orange-400 text-sm">
                • Get more credits to unlock accounts
              </span>
            )}
          </div>
        </div>
      )}

      {/* Main Header */}
      <main>
        <div className="mb-8">
          <h1 className="text-4xl font-bold mb-2 tracking-tight">
            STELA
          </h1>
          <p className="text-zinc-400 text-lg">
            Unlock the earliest posts of any public X account.
          </p>
        </div>

        {/* Search Input */}
        <div className="flex gap-2 mb-6">
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
              className="w-full bg-zinc-900 border border-zinc-700 rounded-lg pl-8 pr-3 py-3 text-sm focus:outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500"
            />
          </div>
          <button
            onClick={handleLookupClick}
            disabled={!username.trim() || username.length < 3}
            className="bg-white text-black font-semibold text-sm px-6 py-3 rounded-lg hover:bg-zinc-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Search
          </button>
        </div>

        {/* NEW: How STELA Works + Sample Results Section */}
        <div className="border border-zinc-800 rounded-xl overflow-hidden">
          {/* 使い方セクション */}
          <div className="p-6 border-b border-zinc-800">
            <div className="flex items-start gap-4">
              <div className="bg-blue-500/10 p-3 rounded-lg flex-shrink-0">
                <svg className="w-6 h-6 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
              <div>
                <h3 className="text-lg font-semibold mb-3">How STELA Works</h3>
                <div className="space-y-3 text-sm text-zinc-400">
                  <div className="flex items-center gap-3">
                    <span className="flex items-center justify-center w-6 h-6 bg-blue-500 text-white text-xs font-bold rounded-full flex-shrink-0">1</span>
                    <span>Enter any public X username above</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="flex items-center justify-center w-6 h-6 bg-blue-500 text-white text-xs font-bold rounded-full flex-shrink-0">2</span>
                    <span>We excavate their earliest 100 posts from X's archives</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="flex items-center justify-center w-6 h-6 bg-blue-500 text-white text-xs font-bold rounded-full flex-shrink-0">3</span>
                    <span>Discover how their voice evolved over time</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* サンプル結果 */}
          <div className="p-6">
            <h4 className="text-sm font-semibold text-zinc-300 mb-4 flex items-center gap-2">
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M3 4a1 1 0 011-1h12a1 1 0 011 1v2a1 1 0 01-1 1H4a1 1 0 01-1-1V4zm0 4a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H4a1 1 0 01-1-1V8zm8 0a1 1 0 011-1h4a1 1 0 011 1v2a1 1 0 01-1 1h-4a1 1 0 01-1-1V8zm0 4a1 1 0 011-1h4a1 1 0 011 1v2a1 1 0 01-1 1h-4a1 1 0 01-1-1v-2z" clipRule="evenodd" />
              </svg>
              Sample Result Preview
            </h4>
            
            <div className="bg-zinc-900/50 rounded-lg p-4 space-y-4">
              {/* Sample tweet 1 */}
              <div className="border-l-2 border-blue-500/30 pl-4">
                <div className="flex justify-between items-center text-xs text-zinc-500 mb-2">
                  <span className="font-medium">@elonmusk</span>
                  <span>2009-06-04 • Post #1</span>
                </div>
                <p className="text-zinc-300 text-sm mb-2">
                  "Please ignore prior tweets, as that was someone else playing on my account"
                </p>
                <div className="flex gap-4 text-xs text-zinc-500">
                  <span className="flex items-center gap-1">
                    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M3.172 5.172a4 4 0 015.656 0L10 6.343l1.172-1.171a4 4 0 115.656 5.656L10 17.657l-6.828-6.829a4 4 0 010-5.656z" clipRule="evenodd" />
                    </svg>
                    12,543
                  </span>
                  <span className="flex items-center gap-1">
                    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                      <path d="M15 8a3 3 0 10-2.977-2.63l-4.94 2.47a3 3 0 100 4.319l4.94 2.47a3 3 0 10.895-1.789l-4.94-2.47a3.027 3.027 0 000-.74l4.94-2.47C13.456 7.68 14.19 8 15 8z" />
                    </svg>
                    8,231
                  </span>
                  <span className="flex items-center gap-1">
                    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="18 13V5a2 2 0 00-2-2H4a2 2 0 00-2 2v8a2 2 0 002 2h3l3 3 3-3h3a2 2 0 002-2zM5 7a1 1 0 011-1h8a1 1 0 110 2H6a1 1 0 01-1-1zm1 3a1 1 0 100 2h3a1 1 0 100-2H6z" clipRule="evenodd" />
                    </svg>
                    2,156
                  </span>
                </div>
              </div>

              {/* Sample tweet 2 */}
              <div className="border-l-2 border-green-500/30 pl-4">
                <div className="flex justify-between items-center text-xs text-zinc-500 mb-2">
                  <span className="font-medium">@oprah</span>
                  <span>2009-04-17 • Post #3</span>
                </div>
                <p className="text-zinc-300 text-sm mb-2">
                  "HI TWITTERS. THANK YOU FOR A WARM WELCOME. FEELING REALLY 21st CENTURY."
                </p>
                <div className="flex gap-4 text-xs text-zinc-500">
                  <span className="flex items-center gap-1">
                    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M3.172 5.172a4 4 0 015.656 0L10 6.343l1.172-1.171a4 4 0 115.656 5.656L10 17.657l-6.828-6.829a4 4 0 010-5.656z" clipRule="evenodd" />
                    </svg>
                    1,892
                  </span>
                  <span className="flex items-center gap-1">
                    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                      <path d="M15 8a3 3 0 10-2.977-2.63l-4.94 2.47a3 3 0 100 4.319l4.94 2.47a3 3 0 10.895-1.789l-4.94-2.47a3.027 3.027 0 000-.74l4.94-2.47C13.456 7.68 14.19 8 15 8z" />
                    </svg>
                    543
                  </span>
                  <span className="flex items-center gap-1">
                    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="18 13V5a2 2 0 00-2-2H4a2 2 0 00-2 2v8a2 2 0 002 2h3l3 3 3-3h3a2 2 0 002-2zM5 7a1 1 0 011-1h8a1 1 0 110 2H6a1 1 0 01-1-1zm1 3a1 1 0 100 2h3a1 1 0 100-2H6z" clipRule="evenodd" />
                    </svg>
                    89
                  </span>
                </div>
              </div>
            </div>

            <div className="mt-4 text-center">
              <p className="text-xs text-zinc-500">
                And 98 more posts, complete with engagement data and timestamps
              </p>
            </div>
          </div>

          {/* 既存のSign up部分を保持（未ログインユーザーのみ） */}
          {!user && (
            <div className="border-t border-zinc-800 p-6 bg-zinc-950/50">
              <div className="text-center">
                <p className="text-sm text-zinc-400 mb-4">
                  Sign up for an account to unlock more features and get credits
                </p>
                <div className="flex justify-center gap-3">
                  <a 
                    href="/signup" 
                    className="bg-white text-black font-semibold px-4 py-2 rounded-lg hover:bg-zinc-200 transition-colors text-sm"
                  >
                    Create Account
                  </a>
                  <a 
                    href="/login" 
                    className="border border-zinc-700 text-zinc-300 font-semibold px-4 py-2 rounded-lg hover:bg-zinc-900 transition-colors text-sm"
                  >
                    Sign In
                  </a>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Dev Panel — only when NEXT_PUBLIC_DEV_PANEL=1 */}
      {DEV_PANEL && <DevPanel onView={handleViewUsername} />}
    </div>
  );
}