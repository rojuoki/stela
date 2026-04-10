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

// PulsingDot component matching JobStatus
function PulsingDot({ color }: { color: string }) {
  return (
    <span className="relative flex h-2.5 w-2.5">
      <span
        className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"
        style={{ backgroundColor: color }}
      />
      <span
        className="relative inline-flex rounded-full h-2.5 w-2.5"
        style={{ backgroundColor: color }}
      />
    </span>
  );
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
  
  // Get status line text matching JobStatus format
  const getStatusLineText = () => {
    switch (status) {
      case "ready":
        return `Ready ${creditCount} credit${creditCount !== 1 ? "s" : ""}`;
      case "excavating":
        return `Excavating ${creditCount} credit${creditCount !== 1 ? "s" : ""}`;
      case "done":
        if (postCount !== undefined) {
          if (postRange) {
            return `Done ${postCount} posts`;
          } else {
            return `Done ${postCount} posts`;
          }
        }
        return `Done ${creditCount} credit${creditCount !== 1 ? "s" : ""}`;
    }
  };

  return (
    <div className="mb-4">
      {/* Line 1: Status with dot and info - matching JobStatus style */}
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 text-xs">
          <PulsingDot color="#3b82f6" />
          <span className="text-blue-400 font-medium">
            {getStatusLineText()}
          </span>
        </div>

        {/* Right side: Action button */}
        {actionButton && (
          <div className="flex-shrink-0">
            {actionButton}
          </div>
        )}
      </div>

      {/* Line 2: Sub message - matching JobStatus layout */}
      {subMessage && (
        <div className="text-blue-300/70 text-xs ml-5">
          {subMessage}
        </div>
      )}
    </div>
  );
}