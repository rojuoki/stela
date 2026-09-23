"use client"

import { useMemo, useRef, useState } from "react"
import type { TweetData } from "@/components/types"
import { EngagementChart as LegacyEngagementChart } from "./engagement-chart"
import { EngagementChartV2 } from "./engagement-chart-v2"
import { Timeline, type TimelineHandle } from "./timeline"
import { Sidebar } from "./sidebar"
import type { MediaAttachment, MediaVariant } from "./media-types"

/** Adapts authorized posts already loaded by the account page; never fetches. */
export function SavedTimeline({ tweets, username }: { tweets: TweetData[]; username: string }) {
  const useNewChart = process.env.NEXT_PUBLIC_STELA_ENGAGEMENT_CHART === "v2"
  const timeline = useRef<TimelineHandle>(null)
  const [keyword, setKeyword] = useState("")
  const [selected, setSelected] = useState<{ start: string; end: string } | null>(null)
  const [highlight, setHighlight] = useState<string | null>(null)
  const [highlightedPost, setHighlightedPost] = useState<string | null>(null)
  const mediaForPost = (post: TweetData): MediaAttachment[] => {
    try {
      const parsed: unknown = JSON.parse(post.media_json || "[]")
      if (!Array.isArray(parsed)) return []
      return parsed.flatMap((value, index) => {
        if (!value || typeof value !== "object") return []
        const item = value as Record<string, unknown>
        const thumbnail = typeof item.url === "string" ? item.url : typeof item.media_url_https === "string" ? item.media_url_https : ""
        if (!thumbnail) return []
        const rawVariants = item.video_info && typeof item.video_info === "object" ? (item.video_info as Record<string, unknown>).variants : []
        const variants: MediaVariant[] = Array.isArray(rawVariants) ? rawVariants.flatMap((variant) => {
          if (!variant || typeof variant !== "object") return []
          const row = variant as Record<string, unknown>
          return typeof row.url === "string" ? [{ url: row.url, bitrate: typeof row.bitrate === "number" ? row.bitrate : undefined, contentType: typeof row.content_type === "string" ? row.content_type : undefined }] : []
        }) : []
        const type = item.type === "video" ? "video" as const : item.type === "animated_gif" ? "gif" as const : "image" as const
        return [{ id: `${post.post_id}-${index}`, type, thumbnail, url: type === "image" ? undefined : variants[0]?.url, variants, postDate: post.created_at, postId: post.post_id }]
      })
    } catch { return [] }
  }
  const posts = useMemo(() => [...tweets].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)).map(p => ({ id: p.post_id, date: p.created_at, text: p.full_text, likes: p.like_count, retweets: p.retweet_count, replies: p.reply_count, url: `https://x.com/${username}/status/${p.post_id}`, media: mediaForPost(p) })), [tweets, username])
  const engagementPosts = useMemo(() => tweets.map(post => ({ id: post.post_id, date: post.created_at, text: post.full_text, likes: post.like_count, retweets: post.retweet_count, replies: post.reply_count })), [tweets])
  const filtered = posts.filter(p => p.text.toLocaleLowerCase().includes(keyword.toLocaleLowerCase()) && (!selected || (p.date.slice(0, 10) >= selected.start.slice(0, 10) && p.date.slice(0, 10) <= selected.end.slice(0, 10))))
  const legacyChart = useMemo(() => {
    const groups = new Map<string, { date: string; posts: number; likes: number; retweets: number; replies: number; engagement: number }>()
    for (const post of tweets) {
      const date = post.created_at.slice(0, 10)
      const group = groups.get(date) || { date: `${date}T00:00:00Z`, posts: 0, likes: 0, retweets: 0, replies: 0, engagement: 0 }
      group.posts += 1
      group.likes += post.like_count
      group.retweets += post.retweet_count
      group.replies += post.reply_count
      group.engagement += post.like_count + post.retweet_count + post.reply_count
      groups.set(date, group)
    }
    return [...groups.values()]
  }, [tweets])
  const media = useMemo(() => tweets.flatMap(mediaForPost), [tweets])
  const totalLikes = posts.reduce((n, p) => n + p.likes, 0)
  const totalRetweets = posts.reduce((n, p) => n + p.retweets, 0)
  const totalReplies = posts.reduce((n, p) => n + p.replies, 0)
  const days = posts.length > 1 ? Math.max(1, (Date.parse(posts[posts.length - 1].date) - Date.parse(posts[0].date)) / 86400000) : 1
  const hours = Array<number>(24).fill(0)
  posts.forEach(p => { hours[new Date(p.date).getUTCHours()]++ })
  const jump = (id: string) => { setKeyword(""); setSelected(null); setHighlight(null); setHighlightedPost(id); requestAnimationFrame(() => timeline.current?.scrollToPost(id)) }
  const jumpWithinSelection = (id: string) => { setKeyword(""); setHighlight(null); setHighlightedPost(id); requestAnimationFrame(() => timeline.current?.scrollToPost(id)) }
  return <section className="border-t border-border">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
      <p className="text-xs text-muted-foreground">{filtered.length} / {posts.length} posts · 古い順{posts.length > 0 && ` · ${posts[0].date.slice(0, 10)} — ${posts[posts.length - 1].date.slice(0, 10)}`}</p>
      <div className="flex flex-wrap gap-3">{selected && <button className="text-xs text-muted-foreground" onClick={() => setSelected(null)}>期間をリセット</button>}<input aria-label="投稿内を検索" placeholder="投稿内を検索" value={keyword} onChange={e => setKeyword(e.target.value)} className="rounded-md border border-border bg-secondary px-3 py-2 text-sm" /></div>
    </div>
    <div className="flex flex-col lg:h-[720px] lg:flex-row">
      <div className="flex h-[650px] min-w-0 flex-1 flex-col overflow-hidden lg:h-auto">
        {useNewChart
          ? <EngagementChartV2 posts={engagementPosts} selectedRange={selected} onDateClick={date => { setSelected(null); setHighlightedPost(null); setHighlight(date); requestAnimationFrame(() => timeline.current?.scrollToDate(date)) }} onRangeSelect={(a, b) => { setSelected({ start: a < b ? a : b, end: a < b ? b : a }); setHighlight(null); setHighlightedPost(null) }} onPostClick={jump} />
          : <LegacyEngagementChart data={legacyChart} perPostData={engagementPosts} selectedRange={selected} onDateClick={date => { setSelected(null); setHighlightedPost(null); setHighlight(date); requestAnimationFrame(() => timeline.current?.scrollToDate(date)) }} onPostClick={jumpWithinSelection} onRangeSelect={(a, b) => { setSelected({ start: a < b ? a : b, end: a < b ? b : a }); setHighlight(null); setHighlightedPost(null) }} onRangeClear={() => { setSelected(null); setHighlight(null); setHighlightedPost(null) }} />}
        {filtered.length ? <Timeline ref={timeline} posts={filtered} highlightedDate={highlight} highlightedPostId={highlightedPost} /> : <p className="p-8 text-sm text-muted-foreground">条件に一致する投稿がありません。</p>}
      </div>
      <aside className="flex max-h-[720px] [&>div]:w-full lg:[&>div]:w-[300px]" aria-label="投稿の情報"><Sidebar hideAccount account={{ username, displayName: username, avatar: "", bio: "", followers: 0, following: 0, posts: posts.length, joinedDate: "" }} media={media} topPosts={[...posts].sort((a, b) => b.likes + b.retweets + b.replies - a.likes - a.retweets - a.replies).slice(0, 5)} stats={{ totalPosts: posts.length, totalLikes, totalRetweets, avgEngagement: posts.length ? (totalLikes + totalRetweets + totalReplies) / posts.length : 0, postsPerDay: posts.length / days, peakHour: `${hours.indexOf(Math.max(...hours))}:00 UTC` }} onJumpToPost={jump} /></aside>
    </div>
  </section>
}
