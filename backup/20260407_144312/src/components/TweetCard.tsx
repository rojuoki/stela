"use client";

import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import type { TweetData } from "./types";
import { fmt } from "./types";

interface ParsedMedia {
  urls: string[];
  hasMedia: boolean;
}

function parseMedia(mediaJson: string | null): ParsedMedia {
  if (!mediaJson) return { urls: [], hasMedia: false };
  try {
    const parsed = JSON.parse(mediaJson);

    if (Array.isArray(parsed)) {
      const urls = parsed
        .filter((m) => m.type === "photo" || !m.type)
        .map((m: Record<string, unknown>) => m.url || m.preview_image_url || m.media_url_https)
        .filter(Boolean) as string[];
      return { urls: urls.slice(0, 4), hasMedia: parsed.length > 0 };
    }

    if (parsed && parsed.media_keys && Array.isArray(parsed.media_keys)) {
      return { urls: [], hasMedia: parsed.media_keys.length > 0 };
    }

    return { urls: [], hasMedia: false };
  } catch {
    return { urls: [], hasMedia: false };
  }
}

function MediaLightbox({ url, onClose }: { url: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="cursor-pointer fixed inset-0 z-[100] flex items-center justify-center bg-black/90 p-4 sm:p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Enlarged image"
    >
      <button
        type="button"
        aria-label="Close"
        className="cursor-pointer absolute top-2 right-2 sm:top-4 sm:right-4 z-[101] rounded-lg p-2 text-zinc-300 hover:bg-white/10 hover:text-white transition-colors touch-manipulation"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {/* External tweet media URLs — same as inline grid */}
      <img
        src={url}
        alt=""
        className="max-h-[min(90vh,90dvh)] max-w-full w-auto h-auto object-contain select-none"
        onClick={(e) => e.stopPropagation()}
        draggable={false}
      />
    </div>,
    document.body,
  );
}

function MediaGrid({
  urls,
  onImageClick,
}: {
  urls: string[];
  onImageClick?: (url: string) => void;
}) {
  const [failed, setFailed] = useState<Set<string>>(new Set());

  const live = urls.filter((u) => !failed.has(u));
  if (live.length === 0) return null;

  const handleError = (url: string) => {
    setFailed((prev) => new Set(prev).add(url));
  };

  if (live.length === 1) {
    const url = live[0];
    const inner = (
      <img
        src={url}
        alt=""
        className="w-full h-48 object-cover bg-zinc-800"
        loading="lazy"
        onError={() => handleError(url)}
      />
    );
    return (
      <div className="mb-2 rounded-lg overflow-hidden border border-zinc-800">
        {onImageClick ? (
          <button
            type="button"
            className="cursor-pointer block w-full p-0 border-0 bg-transparent focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500 focus-visible:ring-offset-2 focus-visible:ring-offset-black rounded-lg touch-manipulation"
            onClick={() => onImageClick(url)}
          >
            {inner}
          </button>
        ) : (
          inner
        )}
      </div>
    );
  }

  return (
    <div className="mb-2 grid grid-cols-2 gap-0.5 rounded-lg overflow-hidden border border-zinc-800">
      {live.slice(0, 4).map((url, i) => (
        onImageClick ? (
          <button
            key={i}
            type="button"
            className="cursor-pointer relative w-full h-28 p-0 border-0 bg-zinc-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-zinc-500 touch-manipulation"
            onClick={() => onImageClick(url)}
          >
            <img
              src={url}
              alt=""
              className="absolute inset-0 w-full h-full object-cover"
              loading="lazy"
              onError={() => handleError(url)}
            />
          </button>
        ) : (
          <img
            key={i}
            src={url}
            alt=""
            className="w-full h-28 object-cover bg-zinc-800"
            loading="lazy"
            onError={() => handleError(url)}
          />
        )
      ))}
    </div>
  );
}

function HeartIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
    </svg>
  );
}

function RetweetIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="17 1 21 5 17 9" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <polyline points="7 23 3 19 7 15" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </svg>
  );
}

function ReplyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

/** DOM id for scroll targets from the engagement chart (`post_id` only). */
export function tweetElementId(postId: string): string {
  return `tweet-${postId}`;
}

export function TweetCard({
  tweet,
  mediaLightbox = true,
}: {
  tweet: TweetData;
  /** When true, tap/click opens enlarged image on a dark overlay. Default on for all tweet lists. */
  mediaLightbox?: boolean;
}) {
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const closeLightbox = useCallback(() => setLightboxUrl(null), []);

  const date = new Date(tweet.created_at);
  const dateStr = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  const media = parseMedia(tweet.media_json);

  return (
    <article
      id={tweetElementId(tweet.post_id)}
      className="scroll-mt-48 px-4 py-3 border-b border-zinc-800 last:border-b-0 hover:bg-zinc-900/50 transition-colors"
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-xs text-zinc-500">{dateStr}</span>
        {media.hasMedia && media.urls.length === 0 && (
          <span className="inline-flex items-center gap-1 text-[10px] text-zinc-500 bg-zinc-800 px-1.5 py-0.5 rounded">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
            media
          </span>
        )}
      </div>

      <p className="text-sm text-zinc-200 whitespace-pre-wrap break-words mb-2">
        {tweet.full_text}
      </p>

      {media.urls.length > 0 && (
        <MediaGrid
          urls={media.urls}
          onImageClick={mediaLightbox ? setLightboxUrl : undefined}
        />
      )}

      {mediaLightbox && lightboxUrl ? (
        <MediaLightbox url={lightboxUrl} onClose={closeLightbox} />
      ) : null}

      <div className="flex gap-4 text-xs text-zinc-500">
        <span className="flex items-center gap-1 hover:text-rose-400 transition-colors">
          <HeartIcon /> {fmt(tweet.like_count)}
        </span>
        <span className="flex items-center gap-1 hover:text-emerald-400 transition-colors">
          <RetweetIcon /> {fmt(tweet.retweet_count)}
        </span>
        <span className="flex items-center gap-1 hover:text-blue-400 transition-colors">
          <ReplyIcon /> {fmt(tweet.reply_count)}
        </span>
      </div>
    </article>
  );
}
