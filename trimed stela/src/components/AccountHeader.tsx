"use client";

import Link from "next/link";
import type { AccountData, AccountStatus } from "./types";

export function AccountHeader({
  status,
  data,
  error,
}: {
  status: AccountStatus;
  data: AccountData | null;
  error: string | null;
}) {
  if (status === "loading") {
    return (
      <div className="flex items-center gap-4 p-4 bg-zinc-900/80 border border-zinc-800 rounded-xl">
        <div className="w-14 h-14 bg-zinc-800 rounded-full animate-pulse flex-shrink-0" />
        <div className="flex-1 space-y-2">
          <div className="h-4 bg-zinc-800 rounded animate-pulse w-40" />
          <div className="h-3 bg-zinc-800 rounded animate-pulse w-24" />
        </div>
        <span className="text-sm text-zinc-500 animate-pulse">Checking…</span>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="flex items-center gap-3 p-4 bg-red-950/30 border border-red-900/50 rounded-xl">
        <div className="w-8 h-8 rounded-full bg-red-900/40 flex items-center justify-center flex-shrink-0">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="15" y1="9" x2="9" y2="15" />
            <line x1="9" y1="9" x2="15" y2="15" />
          </svg>
        </div>
        <span className="text-sm text-red-400">{error}</span>
      </div>
    );
  }

  if (status === "found" && data) {
    const joinDate = data.created_at
      ? new Date(data.created_at).toLocaleDateString("en-US", {
          month: "short",
          year: "numeric",
        })
      : null;

    return (
      <div
        className={`flex items-center gap-4 p-4 border rounded-xl ${
          data.protected
            ? "bg-orange-950/20 border-orange-900/40"
            : "bg-zinc-900/80 border-zinc-800"
        }`}
      >
        <div className="w-14 h-14 bg-zinc-700 rounded-full overflow-hidden flex-shrink-0 ring-2 ring-zinc-700/50">
          {data.avatar_url ? (
            <img
              src={data.avatar_url}
              alt={`@${data.username}`}
              className="w-full h-full object-cover"
              onError={(e) => {
                e.currentTarget.style.display = "none";
              }}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-zinc-400 text-lg font-bold">
              @
            </div>
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-zinc-100 text-lg truncate">
              {data.display_name || `@${data.username}`}
            </span>
            {data.protected ? (
              <span className="text-[11px] bg-orange-900/50 text-orange-300 px-2 py-0.5 rounded-full border border-orange-800/50 font-medium">
                Protected
              </span>
            ) : (
              <span className="text-[11px] bg-emerald-900/50 text-emerald-300 px-2 py-0.5 rounded-full border border-emerald-800/50 font-medium">
                Public
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 text-sm text-zinc-400 mt-0.5">
            <span>@{data.username}</span>
            {joinDate && (
              <>
                <span className="text-zinc-600">·</span>
                <span>Joined {joinDate}</span>
              </>
            )}
          </div>
          {data.protected && (
            <p className="text-xs text-orange-400/80 mt-1.5">
              This account is protected — unlock is not available.
            </p>
          )}
        </div>

        <div className="flex-shrink-0">
          <Link
            href={`/user/${data.username}`}
            className="inline-flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors px-2 py-1 rounded border border-zinc-700 hover:border-zinc-600"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
            Preview
          </Link>
        </div>
      </div>
    );
  }

  return null;
}
