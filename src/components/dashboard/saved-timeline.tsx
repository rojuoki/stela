"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ChevronDown, ChevronUp, Maximize2, Minimize2, Search, SlidersHorizontal } from "lucide-react"
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
  const [displayCount, setDisplayCount] = useState("all")
  const [chartOpen, setChartOpen] = useState(false)
  const [chartExpanded, setChartExpanded] = useState(false)
  const [position, setPosition] = useState(0)
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
  const visiblePosts = displayCount === "all" ? filtered : filtered.slice(0, Number(displayCount))
  const currentPost = posts[Math.min(position, Math.max(0, posts.length - 1))]
  const dateLabel = (value?: string) => value ? new Date(value).toLocaleDateString("ja-JP", { year: "numeric", month: "short", day: "numeric" }) : "—"
  const moveToPosition = (value: number) => {
    setPosition(value)
    const target = posts[value]
    if (!target) return
    setKeyword("")
    setSelected(null)
    setDisplayCount("all")
    setHighlight(null)
    setHighlightedPost(target.id)
    requestAnimationFrame(() => timeline.current?.scrollToPost(target.id))
  }
  const trackVisiblePost = useCallback((postId: string) => {
    const index = posts.findIndex(post => post.id === postId)
    if (index >= 0) setPosition(index)
  }, [posts])
  useEffect(() => {
    if (!chartExpanded) return
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setChartExpanded(false)
    }
    document.addEventListener("keydown", close)
    return () => document.removeEventListener("keydown", close)
  }, [chartExpanded])
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
  const jump = (id: string) => { setKeyword(""); setSelected(null); setDisplayCount("all"); setHighlight(null); setHighlightedPost(id); requestAnimationFrame(() => timeline.current?.scrollToPost(id)) }
  const jumpWithinSelection = (id: string) => { setKeyword(""); setDisplayCount("all"); setHighlight(null); setHighlightedPost(id); requestAnimationFrame(() => timeline.current?.scrollToPost(id)) }
  const chart = useNewChart
    ? <EngagementChartV2 posts={engagementPosts} selectedRange={selected} onDateClick={date => { setSelected(null); setHighlightedPost(null); setHighlight(date); requestAnimationFrame(() => timeline.current?.scrollToDate(date)) }} onRangeSelect={(a, b) => { setSelected({ start: a < b ? a : b, end: a < b ? b : a }); setHighlight(null); setHighlightedPost(null) }} onPostClick={jump} />
    : <LegacyEngagementChart data={legacyChart} perPostData={engagementPosts} selectedRange={selected} onDateClick={date => { setSelected(null); setHighlightedPost(null); setHighlight(date); requestAnimationFrame(() => timeline.current?.scrollToDate(date)) }} onPostClick={jumpWithinSelection} onRangeSelect={(a, b) => { setSelected({ start: a < b ? a : b, end: a < b ? b : a }); setHighlight(null); setHighlightedPost(null) }} onRangeClear={() => { setSelected(null); setHighlight(null); setHighlightedPost(null) }} />
  return <section className="border-t border-border">
    <div className="border-b border-border bg-card/20 px-5 py-4 md:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div><p className="text-[10px] font-medium tracking-[.18em] text-chart-1">TIMELINE INDEX</p><p className="mt-1 text-sm text-foreground">{dateLabel(currentPost?.date)} <span className="text-muted-foreground">· {position + 1} / {posts.length}件目</span></p></div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative"><Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-muted-foreground" /><input aria-label="投稿内を検索" placeholder="投稿内を検索" value={keyword} onChange={e => setKeyword(e.target.value)} className="w-48 rounded-md border border-border bg-secondary/50 py-2 pl-9 pr-3 text-sm outline-none focus:border-chart-1" /></label>
          <label className="flex items-center gap-2 rounded-md border border-border bg-secondary/50 px-3 py-2 text-xs text-muted-foreground">表示 <select aria-label="表示件数" value={displayCount} onChange={e => setDisplayCount(e.target.value)} className="bg-transparent text-foreground outline-none"><option value="all">全件</option><option value="100">100件</option><option value="250">250件</option><option value="500">500件</option></select></label>
        </div>
      </div>
      <div className="mt-4 flex items-center gap-3"><span className="shrink-0 text-[11px] text-muted-foreground">{dateLabel(posts[0]?.date)}</span><input aria-label="タイムライン上の現在地" type="range" min="0" max={Math.max(0, posts.length - 1)} value={position} onChange={e => moveToPosition(Number(e.target.value))} className="h-1.5 w-full accent-[var(--chart-1)]" /><span className="shrink-0 text-[11px] text-muted-foreground">{dateLabel(posts[posts.length - 1]?.date)}</span></div>
      <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground"><span>{selected ? `${dateLabel(selected.start)} — ${dateLabel(selected.end)}` : "全期間"}</span>{selected && <button className="hover:text-foreground" onClick={() => setSelected(null)}>期間をリセット</button>}</div>
    </div>
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="min-w-0 border-r border-border">
        <div className="flex items-center justify-between border-b border-border px-5 py-3 md:px-8"><p className="text-xs text-muted-foreground">{visiblePosts.length} / {posts.length} posts · 古い順</p><span className="text-[11px] text-muted-foreground">{selected ? "期間を表示中" : "全期間を表示中"}</span></div>
        <div className="min-h-[650px]">{visiblePosts.length ? <Timeline ref={timeline} posts={visiblePosts} highlightedDate={highlight} highlightedPostId={highlightedPost} onVisiblePostChange={trackVisiblePost} /> : <p className="p-8 text-sm text-muted-foreground">条件に一致する投稿がありません。</p>}</div>
      </div>
      <aside className="max-h-[720px]" aria-label="補助情報"><Sidebar hideAccount account={{ username, displayName: username, avatar: "", bio: "", followers: 0, following: 0, posts: posts.length, joinedDate: "" }} media={media} topPosts={[...posts].sort((a, b) => b.likes + b.retweets + b.replies - a.likes - a.retweets - a.replies).slice(0, 5)} stats={{ totalPosts: posts.length, totalLikes, totalRetweets, avgEngagement: posts.length ? (totalLikes + totalRetweets + totalReplies) / posts.length : 0, postsPerDay: posts.length / days, peakHour: `${hours.indexOf(Math.max(...hours))}:00 UTC` }} onJumpToPost={jump} /></aside>
    </div>
    {chartExpanded && <button aria-label="分析パネルを閉じる" className="fixed inset-0 z-40 cursor-default bg-black/80 backdrop-blur-sm" onClick={() => setChartExpanded(false)} />}
    <div className={`border-t border-border ${chartExpanded ? "fixed inset-4 z-50 overflow-auto rounded-xl border bg-background shadow-2xl" : ""}`}>
      <button onClick={() => setChartOpen(!chartOpen)} aria-expanded={chartOpen} className="flex w-full items-center justify-between px-5 py-4 text-left hover:bg-secondary/20 md:px-8"><span className="flex items-center gap-2 text-sm"><SlidersHorizontal className="h-4 w-4 text-chart-1" />分析パネル <span className="text-xs text-muted-foreground">Overview / Per Post</span></span>{chartOpen ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}</button>
      {chartOpen && <div className="relative border-t border-border p-3 md:p-6"><button onClick={() => setChartExpanded(!chartExpanded)} className="absolute right-5 top-4 z-10 rounded-md border border-border bg-secondary/80 p-2 text-muted-foreground hover:text-foreground" aria-label={chartExpanded ? "分析パネルを縮小" : "分析パネルを拡大"}>{chartExpanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}</button>{chart}</div>}
    </div>
  </section>
}
