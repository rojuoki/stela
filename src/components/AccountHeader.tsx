"use client";

import type { AccountData, AccountStatus } from "./types";

export function AccountHeader({
  status,
  data,
  error,
  onExcavateMore,
  excavateMoreDisabled,
}: {
  status: AccountStatus;
  data: AccountData | null;
  error: string | null;
  onExcavateMore?: () => void;
  excavateMoreDisabled?: boolean;
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

    const fetchedDate = data.fetched_at
      ? new Date(data.fetched_at).toLocaleDateString("en-US", {
          month: "2-digit",
          day: "2-digit",
          year: "2-digit",
        })
      : null;

    // Limit description to ~280 characters with ellipsis
    const truncatedDescription = data.description && data.description.length > 280
      ? data.description.slice(0, 280).trim() + "…"
      : data.description;

    return (
      <div
        className={`relative flex items-start gap-4 p-4 border rounded-xl ${
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
          {truncatedDescription && (
            <p className="text-sm text-zinc-300 mt-2 leading-relaxed">
              {truncatedDescription}
            </p>
          )}
          {data.protected && (
            <p className="text-xs text-orange-400/80 mt-1.5">
              This account is protected — unlock is not available.
            </p>
          )}
        </div>

        {onExcavateMore && (
          <div className="flex-shrink-0">
            <button
              onClick={onExcavateMore}
              disabled={excavateMoreDisabled}
              className={`inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors ${
                excavateMoreDisabled
                  ? "bg-zinc-700 text-zinc-500 cursor-not-allowed"
                  : "bg-white text-black hover:bg-zinc-200"
              }`}
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Excavate 100 more
            </button>
          </div>
        )}

        {fetchedDate && (
          <div className="absolute bottom-2 right-2">
            <span className="text-[10px] text-zinc-600">
              Profile snapshot at {fetchedDate}
            </span>
          </div>
        )}
      </div>
    );
  }

  return null;
}
