"use client";

import { ReactNode } from "react";

interface StatusBarProps {
  status: "ready" | "done" | "excavating";
  postCount?: number;
  postRange?: string; // e.g. "1-100" or "101-200" 
  creditCount: number;
  actionButton?: ReactNode;
}

export function StatusBar({
  status,
  postCount,
  postRange,
  creditCount,
  actionButton
}: StatusBarProps) {
  const getStatusDisplay = () => {
    switch (status) {
      case "ready":
        return {
          text: "Ready",
          color: "text-zinc-400",
          icon: "🔓"
        };
      case "done":
        return {
          text: "Unlocked",
          color: "text-emerald-400", 
          icon: "✓"
        };
      case "excavating":
        return {
          text: "Excavating",
          color: "text-amber-400",
          icon: "⛏️"
        };
    }
  };

  const statusDisplay = getStatusDisplay();
  
  const getPostCountText = () => {
    if (postCount === undefined) return null;
    
    if (postRange) {
      return `${postCount} posts • showing ${postRange}`;
    }
    
    return `${postCount} posts`;
  };

  const postCountText = getPostCountText();

  return (
    <div className="flex items-center justify-between gap-3 mb-4 p-3 bg-zinc-900/50 border border-zinc-800 rounded-lg">
      {/* Left side: Status, post count, credit count */}
      <div className="flex items-center gap-3 text-sm">
        {/* Status */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs">{statusDisplay.icon}</span>
          <span className={`font-medium ${statusDisplay.color}`}>
            {statusDisplay.text}
          </span>
        </div>

        {/* Post count */}
        {postCountText && (
          <>
            <span className="text-zinc-600">•</span>
            <span className="text-zinc-400">{postCountText}</span>
          </>
        )}

        {/* Credit count */}
        <span className="text-zinc-600">•</span>
        <span className="text-zinc-500">
          {creditCount} credit{creditCount !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Right side: Action button */}
      {actionButton && (
        <div className="flex-shrink-0">
          {actionButton}
        </div>
      )}
    </div>
  );
}