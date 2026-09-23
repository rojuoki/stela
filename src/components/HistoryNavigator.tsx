"use client";

import { ChevronLeft, ChevronRight, Search, SlidersHorizontal } from "lucide-react";
import { useMemo, useState } from "react";
import type { TweetData } from "./types";

interface HistoryNavigatorProps {
  tweets: TweetData[];
  totalUnlocked?: number;
  onSearch: (query: string) => void;
  onStep: (direction: "previous" | "next") => void;
}

function formatDate(value: string | undefined, long = false) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-US", long
    ? { month: "short", day: "numeric", year: "numeric" }
    : { month: "short", year: "numeric" });
}

export function HistoryNavigator({ tweets, totalUnlocked, onSearch, onStep }: HistoryNavigatorProps) {
  const [query, setQuery] = useState("");
  const sortedTweets = useMemo(
    () => [...tweets].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()),
    [tweets],
  );
  const start = sortedTweets[0]?.created_at;
  const end = sortedTweets[sortedTweets.length - 1]?.created_at;
  const current = sortedTweets[Math.min(3, Math.max(0, sortedTweets.length - 1))]?.created_at ?? start;
  const position = sortedTweets.length > 1 ? (Math.min(3, sortedTweets.length - 1) / (sortedTweets.length - 1)) * 100 : 0;
  const countLabel = totalUnlocked ? `${tweets.length} / ${totalUnlocked}` : `${tweets.length}`;

  return (
    <section aria-labelledby="history-navigation-title" className="mt-5 border-y border-zinc-800/90 py-5">
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-zinc-500">Historical position</p>
            <h2 id="history-navigation-title" className="mt-1 text-xl font-medium tracking-tight text-zinc-100">Locate yourself in the timeline</h2>
          </div>
          <label className="flex h-9 w-full items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-400 lg:max-w-xs">
            <Search className="size-4" aria-hidden="true" />
            <span className="sr-only">Search within posts</span>
            <input
              value={query}
              onChange={(event) => { setQuery(event.target.value); onSearch(event.target.value); }}
              placeholder="Search posts"
              className="min-w-0 flex-1 bg-transparent text-zinc-200 outline-none placeholder:text-zinc-600"
            />
          </label>
        </div>

        <div className="grid grid-cols-2 gap-x-6 gap-y-3 border-y border-zinc-900 py-3 text-sm sm:grid-cols-4">
          <div><p className="text-[10px] uppercase tracking-wider text-zinc-600">Unlocked range</p><p className="mt-1 text-zinc-300">{formatDate(start, true)} <span className="text-zinc-600">→</span> {formatDate(end, true)}</p></div>
          <div><p className="text-[10px] uppercase tracking-wider text-zinc-600">Current view</p><p className="mt-1 text-zinc-100">{formatDate(current, true)}</p></div>
          <div><p className="text-[10px] uppercase tracking-wider text-zinc-600">Posts</p><p className="mt-1 text-zinc-300">{countLabel}</p></div>
          <div><p className="text-[10px] uppercase tracking-wider text-zinc-600">Order</p><p className="mt-1 flex items-center gap-1.5 text-zinc-300"><SlidersHorizontal className="size-3.5 text-zinc-500" aria-hidden="true" /> Oldest first</p></div>
        </div>

        <div className="flex items-center gap-3">
          <button type="button" onClick={() => onStep("previous")} className="rounded-md border border-zinc-800 p-2 text-zinc-500 transition-colors hover:border-zinc-600 hover:text-zinc-200" aria-label="Previous time segment"><ChevronLeft className="size-4" /></button>
          <div className="relative flex-1 py-2" aria-label="Timeline position">
            <div className="h-px bg-zinc-700" />
            <div className="absolute left-0 top-[5px] h-[3px] rounded-full bg-zinc-300" style={{ width: `${Math.max(position, 3)}%` }} />
            <div className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-zinc-950 bg-zinc-100 shadow-[0_0_0_3px_rgba(161,161,170,0.18)]" style={{ left: `${position}%` }} />
            <div className="mt-3 flex justify-between text-[10px] text-zinc-600"><span>{formatDate(start)}</span><span>{formatDate(end)}</span></div>
          </div>
          <button type="button" onClick={() => onStep("next")} className="rounded-md border border-zinc-800 p-2 text-zinc-500 transition-colors hover:border-zinc-600 hover:text-zinc-200" aria-label="Next time segment"><ChevronRight className="size-4" /></button>
        </div>
      </div>
    </section>
  );
}
