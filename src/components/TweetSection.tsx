"use client";

import type { TweetData } from "./types";
import { TweetCard } from "./TweetCard";

interface TweetSectionProps {
  mode: 'seo' | 'preparing' | 'loading' | 'tweets';
  tweets?: TweetData[];
  jobInfo?: string;
  error?: string;
  displayName?: string; // For SEO mode discover overlay
}

const DUMMY_CHART_HEIGHTS = [35, 62, 48, 75, 30, 88, 55, 42, 70, 25, 60, 45, 82, 38, 67, 52, 90, 33, 58, 44];

const DUMMY_TWEET_STATS = [
  { likes: 47, retweets: 12, replies: 5 },
  { likes: 83, retweets: 7, replies: 2 },
  { likes: 21, retweets: 3, replies: 8 },
  { likes: 64, retweets: 18, replies: 4 },
  { likes: 9, retweets: 1, replies: 3 },
];

function SEOContent({ displayName }: { displayName?: string }) {
  return (
    <div className="relative p-4">
      {/* Blurred Engagement Chart */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">
            Engagement across earliest posts
          </h2>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm inline-block bg-blue-500" />
              <span className="text-[10px] text-zinc-500">Likes</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-0.5 inline-block rounded bg-emerald-500" />
              <span className="text-[10px] text-zinc-500">Retweets</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-0.5 inline-block rounded bg-amber-500" />
              <span className="text-[10px] text-zinc-500">Replies</span>
            </div>
          </div>
        </div>

        <div className="relative h-24 bg-zinc-900 rounded-lg border border-zinc-800 p-2 blur-sm">
          <div className="flex items-end gap-px h-full">
            {DUMMY_CHART_HEIGHTS.map((h, i) => (
              <div
                key={i}
                className="flex-1 bg-blue-500 rounded-t-sm"
                style={{ height: `${h}%` }}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Blurred Tweet List */}
      <div className="overflow-hidden blur-sm">
        {DUMMY_TWEET_STATS.map((stats, i) => (
          <div key={i} className="px-4 py-3 border-b border-zinc-800 last:border-b-0">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-xs text-zinc-500">Mar {i + 1}, 2009</span>
            </div>
            <p className="text-sm text-zinc-200 mb-2">
              {i === 0 && "This is where you'll see the earliest posts from this account's timeline..."}
              {i === 1 && "Discover authentic thoughts and interactions from the very beginning..."}
              {i === 2 && "Uncover the origins and evolution of their online presence..."}
              {i === 3 && "See how their voice and perspective developed over time..."}
              {i === 4 && "Experience the full journey from their first posts to today..."}
            </p>
            <div className="flex gap-4 text-xs text-zinc-500">
              <span className="flex items-center gap-1">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                </svg>
                {stats.likes}
              </span>
              <span className="flex items-center gap-1">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="17 1 21 5 17 9" />
                  <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                  <polyline points="7 23 3 19 7 15" />
                  <path d="M21 13v2a4 4 0 0 1-4 4H3" />
                </svg>
                {stats.retweets}
              </span>
              <span className="flex items-center gap-1">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
                {stats.replies}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Discover overlay - text only, centered over blurred zone */}
      <div className="absolute inset-4 flex items-center justify-center z-10 pointer-events-none">
        <div className="text-center max-w-sm px-6">
          <p className="text-base font-semibold text-white drop-shadow-lg mb-3">
            Discover earliest posts from {displayName || 'this account'}
          </p>
          <p className="text-sm text-zinc-300 drop-shadow mb-2 leading-relaxed">
            Explore the earliest posts from {displayName || 'this account'}'s timeline.
            Uncover their first thoughts, early interactions, and the origins
            of their presence on X.
          </p>
          <p className="text-sm text-zinc-400 drop-shadow leading-relaxed">
            Excavation reveals up to 100 of the earliest posts, providing
            unique insights into an account's history and evolution over time.
          </p>
        </div>
      </div>
    </div>
  );
}

function PreparingContent() {
  return (
    <div className="flex items-center justify-center min-h-[200px]">
      <div className="text-center">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-gray-500 mx-auto mb-3" />
        <p className="text-gray-500 text-sm">Preparing excavation...</p>
      </div>
    </div>
  );
}

function LoadingContent({ jobInfo, error }: { jobInfo?: string; error?: string }) {
  if (error) {
    return (
      <div className="flex items-center justify-center min-h-[200px]">
        <div className="text-center px-6 max-w-md">
        <svg
          className="w-12 h-12 mx-auto text-red-500 mb-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"
          />
        </svg>
        <p className="text-red-300 font-medium mb-2">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center min-h-[200px]">
      <div className="text-center">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white mx-auto mb-4" />
      <p className="text-zinc-400 text-sm">
        {jobInfo || "Excavating..."}
      </p>
      </div>
    </div>
  );
}

function TweetsContent({ tweets }: { tweets: TweetData[] }) {
  if (tweets.length === 0) {
    return (
      <div className="flex items-center justify-center min-h-[200px]">
        <p className="text-zinc-600 text-sm">No posts found.</p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden">
      {tweets.map((t) => (
        <TweetCard key={t.post_id} tweet={t} />
      ))}
    </div>
  );
}

export function TweetSection({ mode, tweets = [], jobInfo, error, displayName }: TweetSectionProps) {
  return (
    <div className="border border-zinc-800 rounded-xl min-h-[200px]">
      {mode === 'seo' && <SEOContent displayName={displayName} />}
      {mode === 'preparing' && <PreparingContent />}
      {mode === 'loading' && <LoadingContent jobInfo={jobInfo} error={error} />}
      {mode === 'tweets' && <TweetsContent tweets={tweets} />}
    </div>
  );
}