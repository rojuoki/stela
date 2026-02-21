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
      <div className="flex items-center gap-2 mb-6 text-xs">
        <span className="bg-zinc-800 text-zinc-400 px-2.5 py-1 rounded-md font-medium">
          Idle
        </span>
        <CreditBadge credits={credits} />
      </div>
    );
  }

  if (status === "done") {
    return (
      <div className="flex items-center gap-2 mb-6 text-xs flex-wrap">
        <span className="bg-emerald-900/50 text-emerald-400 px-2.5 py-1 rounded-md font-medium border border-emerald-800/50">
          Done
        </span>
        <CreditBadge credits={credits} />
        {cacheHit && (
          <span className="bg-zinc-800 text-zinc-400 px-2 py-1 rounded-md">from cache</span>
        )}
        {jobInfo && <span className="text-zinc-500">{jobInfo}</span>}
      </div>
    );
  }

  if (status === "failed") {
    return (
      <div className="flex items-center gap-2 mb-6 text-xs flex-wrap">
        <span className="bg-red-900/50 text-red-400 px-2.5 py-1 rounded-md font-medium border border-red-800/50">
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
      <div className="mb-6">
        <div className="flex items-center gap-3 p-3 bg-amber-950/20 border border-amber-900/40 rounded-xl text-xs">
          <PulsingDot color="#f59e0b" />
          <div className="flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-amber-400 font-semibold">Rate limited</span>
              <CreditBadge credits={credits} />
            </div>
            <p className="text-amber-300/70 mt-1">
              Waiting for API cooldown — your data is safe and the job will resume automatically.
              {countdown && (
                <span className="ml-2 font-mono text-amber-300 bg-amber-900/30 px-1.5 py-0.5 rounded">
                  {countdown}
                </span>
              )}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (jobPhase === "queued") {
    return (
      <div className="mb-6">
        <div className="flex items-center gap-3 p-3 bg-zinc-900/80 border border-zinc-800 rounded-xl text-xs">
          <PulsingDot color="#a1a1aa" />
          <div className="flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-zinc-300 font-semibold">Queued</span>
              <CreditBadge credits={credits} />
            </div>
            {jobInfo && <p className="text-zinc-500 mt-1">{jobInfo}</p>}
          </div>
        </div>
      </div>
    );
  }

  // Default running
  return (
    <div className="mb-6">
      <div className="flex items-center gap-3 p-3 bg-blue-950/20 border border-blue-900/40 rounded-xl text-xs">
        <PulsingDot color="#3b82f6" />
        <div className="flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-blue-400 font-semibold">Excavating</span>
            <CreditBadge credits={credits} />
          </div>
          {jobInfo && <p className="text-blue-300/70 mt-1">{jobInfo}</p>}
        </div>
      </div>
    </div>
  );
}

function CreditBadge({ credits }: { credits: number }) {
  return (
    <span className="bg-blue-900/30 text-blue-400 px-2 py-0.5 rounded border border-blue-800/50 font-medium">
      {credits} credit{credits !== 1 ? "s" : ""}
    </span>
  );
}
