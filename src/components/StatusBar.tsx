"use client";

import { ReactNode, useState, useEffect } from "react";

function useCountdown(targetIso: string | null): string | null {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    if (!targetIso) {
      setText(null);
      return;
    }

    const update = () => {
      const diff = new Date(targetIso).getTime() - Date.now();
      if (diff <= 0) {
        setText("resuming…");
        return;
      }
      const s = Math.ceil(diff / 1000);
      const m = Math.floor(s / 60);
      const sec = s % 60;
      setText(`${m}:${String(sec).padStart(2, "0")}`);
    };

    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [targetIso]);

  return text;
}

interface StatusBarProps {
  status: "ready" | "starting" | "excavating" | "done";
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
  jobPhase?: "waiting_rate_limit" | "queued" | "running" | null; // For excavating state
  resumeAt?: string | null; // For rate limit countdown
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
  subMessageStyle = {},
  jobPhase,
  resumeAt
}: StatusBarProps) {
  
  const countdown = useCountdown(
    status === "excavating" && jobPhase === "waiting_rate_limit" ? resumeAt ?? null : null
  );

  // Get status line text and colors
  const getStatusInfo = () => {
    switch (status) {
      case "ready":
        return {
          text: `Ready ${creditCount} credit${creditCount !== 1 ? "s" : ""}`,
          dotColor: "#3b82f6",
          textColor: "text-blue-400"
        };
      case "starting":
        return {
          text: `Starting ${creditCount} credit${creditCount !== 1 ? "s" : ""}`,
          dotColor: "#6b7280",
          textColor: "text-gray-400"
        };
      case "excavating":
        if (jobPhase === "waiting_rate_limit") {
          return {
            text: `Rate limited ${creditCount} credit${creditCount !== 1 ? "s" : ""}`,
            dotColor: "#f59e0b",
            textColor: "text-amber-400"
          };
        }
        return {
          text: `Excavating ${creditCount} credit${creditCount !== 1 ? "s" : ""}`,
          dotColor: "#3b82f6", 
          textColor: "text-blue-400"
        };
      case "done":
        if (postCount !== undefined) {
          return {
            text: `Done ${postCount} posts`,
            dotColor: "#3b82f6",
            textColor: "text-blue-400"
          };
        }
        return {
          text: `Done ${creditCount} credit${creditCount !== 1 ? "s" : ""}`,
          dotColor: "#3b82f6",
          textColor: "text-blue-400"
        };
    }
  };

  const statusInfo = getStatusInfo();

  // Filter out API calls information from subMessage
  const getCleanSubMessage = () => {
    if (!subMessage || typeof subMessage !== 'string') return subMessage;
    
    // Remove API calls information
    const cleanMessage = subMessage
      .replace(/\s*\(API calls: \d+\)/g, '')
      .replace(/API calls: \d+/g, '')
      .trim();
    
    return cleanMessage || subMessage;
  };

  const cleanSubMessage = getCleanSubMessage();

  return (
    <div className="mb-4">
      {/* Line 1: Status with dot and info */}
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 text-xs">
          <PulsingDot color={statusInfo.dotColor} />
          <span className={`${statusInfo.textColor} font-medium`}>
            {statusInfo.text}
          </span>
          {/* Rate limit countdown */}
          {countdown && jobPhase === "waiting_rate_limit" && (
            <span className="font-mono text-amber-300 bg-amber-900/30 px-1.5 py-0.5 rounded">
              {countdown}
            </span>
          )}
        </div>

        {/* Right side: Action button */}
        {actionButton && (
          <div className="flex-shrink-0">
            {actionButton}
          </div>
        )}
      </div>

      {/* Line 2: Sub message */}
      {cleanSubMessage && (
        <div className={`text-xs ml-5 ${
          jobPhase === "waiting_rate_limit" ? "text-amber-300/70" : 
          status === "starting" ? "text-gray-400/70" :
          "text-blue-300/70"
        }`}>
          {jobPhase === "waiting_rate_limit" 
            ? "Waiting for API cooldown — resuming automatically"
            : cleanSubMessage
          }
        </div>
      )}
    </div>
  );
}