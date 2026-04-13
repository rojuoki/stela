"use client";

import { useState, useEffect } from "react";
import { DevPanel } from "../components/DevPanel";
import { useUser } from "@/contexts/UserContext";

/** True only when the dev panel is enabled at build time. */
const DEV_PANEL = process.env.NEXT_PUBLIC_DEV_PANEL === "1";

export default function Home() {
  const [username, setUsername] = useState("");
  const { user, credits, refreshCredits, refreshSubscription } = useUser();

  // Handle Stripe Checkout success redirect
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    
    if (urlParams.get('subscription') === 'success') {
      console.log('[page] Stripe subscription success detected, refreshing state...');
      
      // Add delay to allow webhook processing to complete
      setTimeout(async () => {
        if (user) {
          try {
            await Promise.all([refreshCredits(), refreshSubscription()]);
            console.log('[page] State refresh completed after subscription success');
          } catch (error) {
            console.error('[page] Failed to refresh state after subscription success:', error);
          }
        }
      }, 1500); // 1.5 second delay
      
      // Clean up URL
      window.history.replaceState({}, '', '/');
    }
    
    if (urlParams.get('credit') === 'success') {
      const creditAmount = urlParams.get('amount');
      console.log(`[page] Stripe credit purchase success detected, amount: ${creditAmount}`);
      
      // Add delay to allow webhook processing to complete
      setTimeout(async () => {
        if (user) {
          try {
            await refreshCredits();
            console.log(`[page] Credits refresh completed after ${creditAmount} credit purchase`);
          } catch (error) {
            console.error('[page] Failed to refresh credits after purchase:', error);
          }
        }
      }, 1500); // 1.5 second delay
      
      // Clean up URL
      window.history.replaceState({}, '', '/');
    }
    
    if (urlParams.get('temp-unlock') === 'success') {
      const sessionId = urlParams.get('session_id');
      console.log(`[page] Stripe guest unlock success detected, session_id: ${sessionId}`);
      
      // Add delay to allow webhook processing to complete
      setTimeout(async () => {
        if (sessionId) {
          try {
            console.log(`[page] Fetching token for session: ${sessionId}`);
            const response = await fetch(`/api/guest-unlock/session?session_id=${encodeURIComponent(sessionId)}`);
            
            if (response.ok) {
              const { token, username } = await response.json();
              console.log(`[page] Token retrieved: ${token} for @${username}`);
              window.location.href = `/results/${token}`;
            } else {
              console.error(`[page] Failed to retrieve token: ${response.status}`);
              const errorData = await response.json().catch(() => ({}));
              console.error('[page] Error details:', errorData);
              // Fallback: redirect to home page with error indication
              window.location.href = '/?error=unlock-failed';
            }
          } catch (error) {
            console.error('[page] Failed to retrieve unlock token:', error);
            // Fallback: redirect to home page with error indication
            window.location.href = '/?error=unlock-failed';
          }
        } else {
          console.error('[page] Missing session_id for guest unlock');
          window.location.href = '/?error=missing-session';
        }
      }, 1500); // 1.5 second delay
      
      // Clean up URL
      window.history.replaceState({}, '', '/');
    }
  }, [user, refreshCredits, refreshSubscription]);

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
            Discover the earliest posts of any public X account
          </p>
        </div>

        {/* Search Input */}
        <div className="flex gap-2 mb-10 max-w-lg mx-auto px-2">
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
              className="w-full bg-zinc-900 border border-zinc-700 rounded-lg pl-8 pr-3 py-2 text-sm focus:outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500"
            />
          </div>
          <button
            onClick={handleLookupClick}
            disabled={!username.trim() || username.length < 3}
            className="bg-white text-black font-semibold text-sm px-5 py-2 rounded-lg hover:bg-zinc-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Search
          </button>
        </div>

        {/* Mock Status Bar (visual only) */}
        <div className="mb-8 px-8">
          <div className="mb-4">
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="flex items-center gap-2 text-xs">
                <span className="relative flex h-2.5 w-2.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 bg-amber-400" />
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-400" />
                </span>
                <span className="text-amber-400 font-medium">Standby</span>
              </div>
            </div>
            <div className="text-xs text-amber-300/70">
              Awaiting excavation input
            </div>
          </div>
        </div>

        {/* Info Section */}
        <div className="border border-zinc-800 rounded-xl p-8 bg-blue-950/30">
          {!user && (
            <div className="mb-8 rounded-xl p-6 text-center">
              <div className="text-zinc-500 mb-3">
                <svg
                  className="w-10 h-10 mx-auto"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M21 21l-4.35-4.35m1.85-5.15a7 7 0 11-14 0 7 7 0 0114 0z"
                  />
                </svg>
              </div>
              <h3 className="text-white text-2xl font-semibold mb-3">Ready to Explore</h3>
              <p className="text-zinc-400 text-base leading-relaxed mb-5 max-w-md mx-auto">
                Enter any public X username above to discover their earliest posts and see how
                their voice evolved over time.
              </p>
              <div className="border-t border-zinc-800 pt-4">
                <p className="text-sm text-zinc-500 mb-3">
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

          <div className="max-w-xl text-left">
            <p className="mb-8 text-zinc-400 text-sm leading-relaxed">
              <span className="text-white font-semibold">
                🪦 See How They Started{" "}
              </span>
              — what they were, before they had followers, before the image they have today,
              and trace how that early voice took shape over time, post by post. Uncover what&apos;s been buried,
              keep excavating deeper into their past, and collect what you find along the way, building your own
              archive you can revisit, compare, and use as your understanding grows.
            </p>

            <div className="space-y-6">
            <div className="flex items-start gap-4">
              <div className="flex-shrink-0 w-8 h-8 bg-zinc-700 rounded-full flex items-center justify-center text-sm font-semibold">
                1
              </div>
              <div>
                <h4 className="font-semibold text-zinc-200 mb-1">Set up your account 📝</h4>
                <p className="text-zinc-400 text-sm">Create an account to start excavating and get credits. Credits are required for excavation.</p>
              </div>
            </div>

            <div className="flex items-start gap-4">
              <div className="flex-shrink-0 w-8 h-8 bg-zinc-700 rounded-full flex items-center justify-center text-sm font-semibold">
                2
              </div>
              <div>
                <h4 className="font-semibold text-zinc-200 mb-1">Enter a username 🔍</h4>
                <p className="text-zinc-400 text-sm">Load any X account.</p>
              </div>
            </div>

            <div className="flex items-start gap-4">
              <div className="flex-shrink-0 w-8 h-8 bg-zinc-700 rounded-full flex items-center justify-center text-sm font-semibold">
                3
              </div>
              <div>
                <h4 className="font-semibold text-zinc-200 mb-1">Start excavation ⛏️</h4>
                <p className="text-zinc-400 text-sm">Stela digs into the account and shows you the earliest posts, along with engagement data and context from when they were originally posted.</p>
              </div>
            </div>

            <div className="flex items-start gap-4">
              <div className="flex-shrink-0 w-8 h-8 bg-zinc-700 rounded-full flex items-center justify-center text-sm font-semibold">
                4
              </div>
              <div>
                <h4 className="font-semibold text-zinc-200 mb-1">Keep excavating 🐪</h4>
                <p className="text-zinc-400 text-sm">Continue in +100 post blocks whenever you want to go deeper.</p>
              </div>
            </div>
            </div>
          </div>

        </div>
      </main>

      {/* Dev Panel — only when NEXT_PUBLIC_DEV_PANEL=1 */}
      {DEV_PANEL && <DevPanel onView={handleViewUsername} />}
    </div>
  );
}
