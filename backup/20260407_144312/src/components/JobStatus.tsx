"use client";

import { useState, useEffect } from "react";
import type { Status, JobPhase } from "./types";

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

export function JobStatus({
  status,
  jobPhase,
  jobInfo,
  error,
  credits,
  cacheHit,
  resumeAt,
}: {
  status: Status;
  jobPhase: JobPhase;
  jobInfo: string;
  error: string | null;
  credits: number;
  cacheHit: boolean;
  resumeAt: string | null;
}) {
  const countdown = useCountdown(status === "running" && jobPhase === "waiting_rate_limit" ? resumeAt : null);

  if (status === "idle") {
    return (
      <div className="flex items-center gap-2 mb-2 text-xs">
        <span className="text-zinc-500 font-medium">
          Idle
        </span>
        <CreditBadge credits={credits} />
      </div>
    );
  }

  if (status === "done") {
    return (
      <div className="flex items-center gap-2 mb-2 text-xs flex-wrap">
        <span className="text-emerald-400 font-medium">
          Done
        </span>
        <CreditBadge credits={credits} />
        {cacheHit && (
          <span className="text-zinc-500">from cache</span>
        )}
        {jobInfo && <span className="text-zinc-500">{jobInfo}</span>}
      </div>
    );
  }

  if (status === "failed") {
    return (
      <div className="flex items-center gap-2 mb-2 text-xs flex-wrap">
        <span className="text-red-400 font-medium">
          Failed
        </span>
        <CreditBadge credits={credits} />
        {error && <span className="text-red-400">{error}</span>}
      </div>
    );
  }

  // Running states
  if (jobPhase === "waiting_rate_limit") {
    return (
      <div className="mb-2">
        <div className="flex items-center gap-2 text-xs">
          <PulsingDot color="#f59e0b" />
          <span className="text-amber-400 font-medium">Rate limited</span>
          <CreditBadge credits={credits} />
          {countdown && (
            <span className="font-mono text-amber-300 bg-amber-900/30 px-1.5 py-0.5 rounded">
              {countdown}
            </span>
          )}
        </div>
        <p className="text-amber-300/70 text-xs mt-0.5 ml-5">
          Waiting for API cooldown — resuming automatically
        </p>
      </div>
    );
  }

  if (jobPhase === "queued") {
    return (
      <div className="mb-2">
        <div className="flex items-center gap-2 text-xs">
          <PulsingDot color="#a1a1aa" />
          <span className="text-zinc-300 font-medium">Queued</span>
          <CreditBadge credits={credits} />
        </div>
        {jobInfo && <p className="text-zinc-500 text-xs mt-0.5 ml-5">{jobInfo}</p>}
      </div>
    );
  }

  // Default running
  return (
    <div className="mb-2">
      <div className="flex items-center gap-2 text-xs">
        <PulsingDot color="#3b82f6" />
        <span className="text-blue-400 font-medium">Excavating</span>
        <CreditBadge credits={credits} />
      </div>
      {jobInfo && <p className="text-blue-300/70 text-xs mt-0.5 ml-5">{jobInfo}</p>}
    </div>
  );
}

function CreditBadge({ credits }: { credits: number }) {
  return (
    <span className="text-zinc-500">
      {credits} credit{credits !== 1 ? "s" : ""}
    </span>
  );
}
