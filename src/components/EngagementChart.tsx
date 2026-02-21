"use client";

import { useState, useRef, useMemo } from "react";
import type { TweetData } from "./types";

const LINES = [
  { key: "retweet_count" as const, color: "#10b981", label: "Retweets" },
  { key: "reply_count" as const, color: "#f59e0b", label: "Replies" },
];

export function EngagementChart({ tweets }: { tweets: TweetData[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const sorted = useMemo(
    () => [...tweets].sort((a, b) => a.created_at.localeCompare(b.created_at)),
    [tweets],
  );

  const maxLikes = useMemo(
    () => Math.max(...sorted.map((t) => t.like_count), 1),
    [sorted],
  );

  const maxLine = useMemo(
    () =>
      Math.max(
        ...sorted.flatMap((t) => [t.retweet_count, t.reply_count]),
        1,
      ),
    [sorted],
  );

  if (sorted.length === 0) return null;
  const n = sorted.length;

  const linePoints = (key: "retweet_count" | "reply_count") =>
    sorted
      .map(
        (t, i) =>
          `${((i + 0.5) / n) * 100},${(1 - t[key] / maxLine) * 100}`,
      )
      .join(" ");

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const idx = Math.min(Math.max(Math.floor((x / rect.width) * n), 0), n - 1);
    setHoverIdx(idx);
  };

  const hoverTweet = hoverIdx !== null ? sorted[hoverIdx] : null;

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">
          Engagement across earliest {n} posts
        </h2>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span
              className="w-2.5 h-2.5 rounded-sm inline-block"
              style={{ background: "#3b82f6" }}
            />
            <span className="text-[10px] text-zinc-500">Likes</span>
          </div>
          {LINES.map((l) => (
            <div key={l.key} className="flex items-center gap-1.5">
              <span
                className="w-3 h-0.5 inline-block rounded"
                style={{ background: l.color }}
              />
              <span className="text-[10px] text-zinc-500">{l.label}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="relative">
        {/* Bars — Likes */}
        <div
          ref={containerRef}
          className="flex items-end gap-px h-24 bg-zinc-900 rounded-lg p-2 border border-zinc-800 cursor-crosshair"
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHoverIdx(null)}
        >
          {sorted.map((t) => {
            const h = Math.max((t.like_count / maxLikes) * 100, 2);
            return (
              <div
                key={t.post_id}
                className="flex-1 bg-blue-500 rounded-t-sm hover:bg-blue-400 transition-colors"
                style={{ height: `${h}%` }}
              />
            );
          })}
        </div>

        {/* Lines — Retweets & Replies */}
        <div className="absolute inset-px p-2 pointer-events-none">
          <svg
            className="w-full h-full overflow-visible"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
          >
            {LINES.map((l) => (
              <polyline
                key={l.key}
                points={linePoints(l.key)}
                fill="none"
                stroke={l.color}
                strokeWidth="1.5"
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </svg>
        </div>

        {/* Tooltip */}
        {hoverTweet && hoverIdx !== null && (
          <div
            className="absolute pointer-events-none bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 shadow-xl text-xs z-10"
            style={{
              left: `${((hoverIdx + 0.5) / n) * 100}%`,
              bottom: "calc(100% + 8px)",
              transform:
                hoverIdx > n * 0.65
                  ? "translateX(-90%)"
                  : hoverIdx < n * 0.35
                    ? "translateX(-10%)"
                    : "translateX(-50%)",
            }}
          >
            <div className="font-medium text-zinc-200">
              Post #{hoverIdx + 1}
            </div>
            <div className="text-zinc-500 mb-1.5">
              {new Date(hoverTweet.created_at).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </div>
            <div className="flex items-center gap-2">
              <span
                className="w-2 h-2 rounded-sm inline-block"
                style={{ background: "#3b82f6" }}
              />
              <span className="text-zinc-400 w-16">Likes</span>
              <span className="text-zinc-200 font-medium">
                {hoverTweet.like_count.toLocaleString()}
              </span>
            </div>
            {LINES.map((l) => (
              <div key={l.key} className="flex items-center gap-2">
                <span
                  className="w-2 h-2 rounded-full inline-block"
                  style={{ background: l.color }}
                />
                <span className="text-zinc-400 w-16">{l.label}</span>
                <span className="text-zinc-200 font-medium">
                  {hoverTweet[l.key].toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
