"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useUser } from "@/contexts/UserContext";
import { useRouter } from "next/navigation";

interface UnlockedAccount {
  account_id: string;
  username: string | null;
  account_created_at: string | null;
  boundary_end: number;
  unlocked_at: string;
}

interface UnlocksResponse {
  userId: string;
  accounts: UnlockedAccount[];
  count: number;
}

export default function MyUnlocksPage() {
  const { user, loading: userLoading } = useUser();
  const router = useRouter();
  const [accounts, setAccounts] = useState<UnlockedAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<"date" | "username" | "posts">("date");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");

  useEffect(() => {
    if (!userLoading && !user) {
      router.push("/login");
    }
  }, [user, userLoading, router]);

  useEffect(() => {
    if (user) {
      fetchUnlocks();
    }
  }, [user]);

  const fetchUnlocks = async () => {
    if (!user) return;

    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/account/unlocks", {
        credentials: "include",
      });

      if (!response.ok) {
        if (response.status === 401) {
          router.push("/login");
          return;
        }
        throw new Error(`HTTP ${response.status}`);
      }

      const data: UnlocksResponse = await response.json();
      setAccounts(data.accounts);
    } catch {
      setError("Failed to load unlocked accounts");
    } finally {
      setLoading(false);
    }
  };

  const sortedAccounts = [...accounts].sort((a, b) => {
    let comparison = 0;

    switch (sortBy) {
      case "date":
        comparison = new Date(a.unlocked_at).getTime() - new Date(b.unlocked_at).getTime();
        break;
      case "username":
        comparison = (a.username || "").localeCompare(b.username || "");
        break;
      case "posts":
        comparison = a.boundary_end - b.boundary_end;
        break;
    }

    return sortOrder === "desc" ? -comparison : comparison;
  });

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const formatAccountCreated = (dateStr: string | null) => {
    if (!dateStr) return "Unknown";
    return new Date(dateStr).toLocaleDateString("en-US", {
      month: "short",
      year: "numeric",
    });
  };

  const totalPosts = accounts.reduce((sum, a) => sum + a.boundary_end, 0);

  if (userLoading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white"></div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold mb-2">My Unlocks</h1>
        <p className="text-zinc-400">
          Your unlocked accounts and excavated posts
        </p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white"></div>
        </div>
      ) : error ? (
        <div className="p-6 bg-red-900/20 border border-red-800/50 rounded-lg">
          <div className="flex items-center gap-2 text-red-400">
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
            {error}
          </div>
        </div>
      ) : accounts.length === 0 ? (
        <div className="text-center py-16">
          <div className="mb-6">
            <svg className="w-16 h-16 mx-auto text-zinc-600 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <h3 className="text-xl font-semibold text-zinc-300 mb-2">No Unlocks Yet</h3>
            <p className="text-zinc-500 mb-6 max-w-md mx-auto">
              You haven&apos;t unlocked any accounts yet. Start exploring to discover earliest posts from X accounts.
            </p>
          </div>
          <Link
            href="/"
            className="inline-flex items-center gap-2 bg-white text-black font-semibold px-6 py-3 rounded-lg hover:bg-zinc-200 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            Start Exploring
          </Link>
        </div>
      ) : (
        <>
          {/* Sorting */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 mb-6">
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium text-zinc-300">Sort by:</label>
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as "date" | "username" | "posts")}
                  className="bg-zinc-800 border border-zinc-700 rounded px-3 py-1 text-sm focus:outline-none focus:border-zinc-500"
                >
                  <option value="date">Date</option>
                  <option value="username">Username</option>
                  <option value="posts">Posts Unlocked</option>
                </select>
              </div>

              <div className="flex items-center gap-2">
                <label className="text-sm font-medium text-zinc-300">Order:</label>
                <select
                  value={sortOrder}
                  onChange={(e) => setSortOrder(e.target.value as "asc" | "desc")}
                  className="bg-zinc-800 border border-zinc-700 rounded px-3 py-1 text-sm focus:outline-none focus:border-zinc-500"
                >
                  <option value="desc">Newest First</option>
                  <option value="asc">Oldest First</option>
                </select>
              </div>

              <div className="ml-auto text-sm text-zinc-500">
                {accounts.length} account{accounts.length !== 1 ? "s" : ""} unlocked
              </div>
            </div>
          </div>

          {/* Account Cards Grid */}
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {sortedAccounts.map((account) => (
              <div
                key={account.account_id}
                className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 hover:border-zinc-700 transition-colors"
              >
                {/* Header */}
                <div className="flex items-start justify-between mb-3">
                  <div className="flex-1">
                    <Link
                      href={`/user/${account.username || account.account_id}`}
                      className="text-lg font-semibold text-zinc-200 hover:text-white transition-colors"
                    >
                      @{account.username || "unknown"}
                    </Link>
                    <div className="mt-1">
                      <span className="text-sm text-zinc-400">
                        {account.boundary_end} posts unlocked
                      </span>
                    </div>
                  </div>
                </div>

                {/* Metadata */}
                <div className="space-y-2 text-sm text-zinc-500">
                  <div className="flex justify-between">
                    <span>Last unlocked:</span>
                    <span>{formatDate(account.unlocked_at)}</span>
                  </div>
                  {account.account_created_at && (
                    <div className="flex justify-between">
                      <span>Account created:</span>
                      <span>{formatAccountCreated(account.account_created_at)}</span>
                    </div>
                  )}
                </div>

                {/* Action */}
                <div className="mt-4 pt-3 border-t border-zinc-800">
                  <Link
                    href={`/user/${account.username || account.account_id}`}
                    className="inline-flex items-center gap-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                    </svg>
                    View Results
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </Link>
                </div>
              </div>
            ))}
          </div>

          {/* Summary Stats */}
          <div className="mt-8 p-6 bg-zinc-900 border border-zinc-800 rounded-xl">
            <h3 className="text-lg font-semibold mb-4">Your Exploration Stats</h3>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-center">
              <div>
                <div className="text-2xl font-bold text-zinc-200">{accounts.length}</div>
                <div className="text-sm text-zinc-500">Accounts Unlocked</div>
              </div>
              <div>
                <div className="text-2xl font-bold text-zinc-200">
                  {totalPosts.toLocaleString()}
                </div>
                <div className="text-sm text-zinc-500">Posts Discovered</div>
              </div>
              <div>
                <div className="text-2xl font-bold text-zinc-200">
                  {(() => {
                    const oldest = accounts.reduce(
                      (min, a) => Math.min(min, new Date(a.unlocked_at).getTime()),
                      Date.now(),
                    );
                    return Math.max(1, Math.round((Date.now() - oldest) / (1000 * 60 * 60 * 24)));
                  })()}
                </div>
                <div className="text-sm text-zinc-500">Days Exploring</div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
