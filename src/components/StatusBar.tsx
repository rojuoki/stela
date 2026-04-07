"use client";

import { ReactNode } from "react";

interface StatusBarProps {
  status: "ready" | "done" | "excavating";
  postCount?: number;
  postRange?: string; // e.g. "1-100" or "101-200" 
  creditCount: number;
  actionButton?: ReactNode;
  subMessage?: ReactNode;
  subMessageStyle?: {
    color?: string;
    size?: string;
    weight?: string;
  };
}

export function StatusBar({
  status,
  postCount,
  postRange,
  creditCount,
  actionButton,
  subMessage,
  subMessageStyle = {}
}: StatusBarProps) {
  const getStatusDisplay = () => {
    switch (status) {
      case "ready":
        return {
          text: "Ready",
          color: "text-amber-500",
          icon: ""
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
  
  const getPostCountDisplay = () => {
    if (postCount === undefined) return null;
    
    if (postRange) {
      return (
        <>
          <span className="text-white">{postCount}</span>
          <span className="text-zinc-400"> posts • showing </span>
          <span className="text-white">{postRange}</span>
        </>
      );
    }
    
    return (
      <>
        <span className="text-white">{postCount}</span>
        <span className="text-zinc-400"> posts</span>
      </>
    );
  };

  const postCountDisplay = getPostCountDisplay();

  const defaultSubMessageStyle = {
    color: subMessageStyle.color || "text-zinc-400",
    size: subMessageStyle.size || "text-sm",
    weight: subMessageStyle.weight || "font-normal"
  };

  return (
    <div className="mb-4 p-3 bg-zinc-900/50 border border-zinc-800 rounded-lg">
      {/* First row: Status, post count, credit count, action button */}
      <div className="flex items-center justify-between gap-3">
        {/* Left side: Status, post count, credit count */}
        <div className="flex items-center gap-3 text-sm">
          {/* Status */}
          <div className="flex items-center gap-1.5">
            {statusDisplay.icon && (
              <span className="text-xs">{statusDisplay.icon}</span>
            )}
            <span className={`font-medium ${statusDisplay.color}`}>
              {statusDisplay.text}
            </span>
          </div>

          {/* Post count */}
          {postCountDisplay && (
            <>
              <span className="text-zinc-600">•</span>
              {postCountDisplay}
            </>
          )}

          {/* Credit count */}
          <span className="text-zinc-600">•</span>
          <span className="text-white">{creditCount}</span>
          <span className="text-zinc-500"> credit{creditCount !== 1 ? "s" : ""}</span>
        </div>

        {/* Right side: Action button */}
        {actionButton && (
          <div className="flex-shrink-0">
            {actionButton}
          </div>
        )}
      </div>

      {/* Second row: Sub message (optional) */}
      {subMessage && (
        <div className="mt-2 pt-2 border-t border-zinc-800/50">
          <div className={`${defaultSubMessageStyle.size} ${defaultSubMessageStyle.color} ${defaultSubMessageStyle.weight}`}>
            {subMessage}
          </div>
        </div>
      )}
    </div>
  );
}