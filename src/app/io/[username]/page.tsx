"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useParams, useRouter } from "next/navigation"
import { Database, Pickaxe, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { TopBar } from "@/components/dashboard/top-bar"
import { EngagementChart } from "@/components/dashboard/engagement-chart"
import { Timeline, type TimelineHandle } from "@/components/dashboard/timeline"
import { Sidebar } from "@/components/dashboard/sidebar"
import {
  ACQUISITION_PROVIDER_DEFINITIONS,
  acquisitionProviderLabel,
  type AcquisitionProvider,
} from "@/lib/io/providers"

interface AccountData {
  account_id: string
  username: string
  display_name: string | null
  avatar_url: string | null
  description: string | null
  created_at: string | null
  followers_count: number
  following_count: number
  fetched_at: string
}

interface PostData {
  post_id: string
  created_at: string
  full_text: string
  url: string | null
  media_json: string | null
  like_count: number
  retweet_count: number
  reply_count: number
}

interface RunData {
  id: string
  provider: AcquisitionProvider
  status: "queued" | "running" | "succeeded" | "failed" | "canceled"
  progress_message: string | null
  request_count: number
  page_count: number
  unique_count: number
  candidate_count: number
  target_count: number | null
  error_message: string | null
}

interface AccountResponse {
  account: AccountData
  counts: { stored: number; covered: number }
  latestRun: RunData | null
}

interface MediaRecord {
  type?: string
  url?: string
  media_url_https?: string
  preview_image_url?: string
}

function parseMedia(value: string | null): MediaRecord[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is MediaRecord => !!item && typeof item === "object") : []
  } catch {
    return []
  }
}

function formatDateRange(posts: PostData[]): string {
  if (!posts.length) return "No posts"
  const format = (value: string) => new Date(value).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  })
  return `${format(posts[0].created_at)} – ${format(posts[posts.length - 1].created_at)}`
}

function buildChart(posts: PostData[]) {
  const groups = new Map<string, { posts: number; likes: number; retweets: number; replies: number }>()
  for (const post of posts) {
    const date = post.created_at.slice(0, 10)
    const row = groups.get(date) || { posts: 0, likes: 0, retweets: 0, replies: 0 }
    row.posts += 1
    row.likes += post.like_count
    row.retweets += post.retweet_count
    row.replies += post.reply_count
    groups.set(date, row)
  }
  return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([date, row]) => ({
    date: `${date}T00:00:00Z`,
    ...row,
    engagement: row.likes + row.retweets + row.replies,
  }))
}

export default function IoAccountPage() {
  const params = useParams<{ username: string }>()
  const router = useRouter()
  const username = Array.isArray(params.username) ? params.username[0] : params.username
  const [accountResponse, setAccountResponse] = useState<AccountResponse | null>(null)
  const [posts, setPosts] = useState<PostData[]>([])
  const [run, setRun] = useState<RunData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [keyword, setKeyword] = useState("")
  const [highlightedDate, setHighlightedDate] = useState<string | null>(null)
  const [selectedRange, setSelectedRange] = useState<{ start: string; end: string } | null>(null)
  const [provider, setProvider] = useState<AcquisitionProvider>("twitterapi_io")
  const timelineRef = useRef<TimelineHandle>(null)

  const loadData = useCallback(async (showSpinner = true) => {
    if (!username) return
    if (showSpinner) setLoading(true)
    try {
      const accountResult = await fetch(`/api/io/accounts/${encodeURIComponent(username)}`, { cache: "no-store" })
      const accountBody = await accountResult.json()
      if (!accountResult.ok) {
        setAccountResponse(null)
        setRun(accountBody.latestRun || null)
        setError(accountResult.status === 404 ? "" : accountBody.error || "読み込みに失敗しました")
        return
      }
      const response = accountBody as AccountResponse
      setAccountResponse(response)
      setRun(response.latestRun)
      const coveredOnly = response.latestRun && response.latestRun.status !== "succeeded"
      const postResult = await fetch(
        `/api/io/accounts/${encodeURIComponent(username)}/posts?limit=50000&coveredOnly=${coveredOnly ? "1" : "0"}`,
        { cache: "no-store" },
      )
      if (!postResult.ok) throw new Error("投稿を読み込めませんでした")
      const postBody = await postResult.json()
      setPosts(postBody.posts || [])
      setError("")
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "読み込みに失敗しました")
    } finally {
      if (showSpinner) setLoading(false)
    }
  }, [username])

  useEffect(() => { void loadData() }, [loadData])

  useEffect(() => {
    if (!run || !["queued", "running"].includes(run.status)) return
    const timer = window.setInterval(async () => {
      const response = await fetch(`/api/io/runs/${run.id}`, { cache: "no-store" })
      if (!response.ok) return
      const body = await response.json()
      const nextRun = body.run as RunData
      const progressChanged = nextRun.request_count !== run.request_count
        || nextRun.page_count !== run.page_count
        || nextRun.unique_count !== run.unique_count
        || nextRun.candidate_count !== run.candidate_count
        || nextRun.progress_message !== run.progress_message
      setRun(nextRun)
      if (progressChanged && ["queued", "running"].includes(nextRun.status)) {
        void loadData(false)
      }
      if (["succeeded", "failed", "canceled"].includes(nextRun.status)) {
        window.clearInterval(timer)
        void loadData(false)
      }
    }, 2000)
    return () => window.clearInterval(timer)
  }, [run, loadData])

  const startCollection = useCallback(async () => {
    if (!username) return
    const label = acquisitionProviderLabel(provider)
    const costNote = provider === "twitterapi_io"
      ? "TwitterAPI.ioのクレジットを使用します。"
      : "ローカルのtwscrapeアカウントを使用します。"
    if (!window.confirm(`@${username} の最古1000件を${label}で取得します。${costNote}続けますか？`)) return
    setError("")
    const response = await fetch("/api/io/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, targetCount: 1000, provider }),
    })
    const body = await response.json()
    if (!response.ok) {
      setError(body.error || "取得を開始できませんでした")
      return
    }
    setRun(body.run)
  }, [provider, username])

  const filteredPosts = useMemo(() => {
    const query = keyword.trim().toLocaleLowerCase()
    return query ? posts.filter((post) => post.full_text.toLocaleLowerCase().includes(query)) : posts
  }, [posts, keyword])
  const timelinePosts = useMemo(() => filteredPosts.map((post) => ({
    id: post.post_id,
    date: post.created_at,
    text: post.full_text,
    likes: post.like_count,
    retweets: post.retweet_count,
    hasMedia: parseMedia(post.media_json).length > 0,
    url: post.url,
  })), [filteredPosts])
  const chartData = useMemo(() => buildChart(posts), [posts])
  const topPosts = useMemo(() => [...timelinePosts]
    .sort((a, b) => (b.likes + b.retweets) - (a.likes + a.retweets)).slice(0, 5), [timelinePosts])
  const media = useMemo(() => posts.flatMap((post) => parseMedia(post.media_json).map((item, index) => {
    const thumbnail = item.preview_image_url || item.media_url_https || item.url
    return thumbnail ? {
      id: `${post.post_id}-${index}`,
      type: item.type === "video" ? "video" as const : "image" as const,
      thumbnail,
      postDate: post.created_at.slice(0, 10),
      postId: post.post_id,
    } : null
  })).filter((item): item is NonNullable<typeof item> => item !== null), [posts])

  const stats = useMemo(() => {
    const totalLikes = posts.reduce((sum, post) => sum + post.like_count, 0)
    const totalRetweets = posts.reduce((sum, post) => sum + post.retweet_count, 0)
    const spanDays = posts.length > 1
      ? Math.max(1, (new Date(posts[posts.length - 1].created_at).getTime() - new Date(posts[0].created_at).getTime()) / 86_400_000)
      : 1
    const hours = Array.from({ length: 24 }, () => 0)
    for (const post of posts) hours[new Date(post.created_at).getUTCHours()] += 1
    const peakHour = hours.indexOf(Math.max(...hours))
    return {
      totalPosts: posts.length,
      totalLikes,
      totalRetweets,
      avgEngagement: posts.length ? (totalLikes + totalRetweets) / posts.length : 0,
      postsPerDay: posts.length / spanDays,
      peakHour: `${String(peakHour).padStart(2, "0")}:00 UTC`,
    }
  }, [posts])

  const exportPosts = useCallback(() => {
    const blob = new Blob([JSON.stringify({ account: accountResponse?.account, posts }, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = `stela-${username}-posts.json`
    link.click()
    URL.revokeObjectURL(url)
  }, [accountResponse, posts, username])

  if (loading) return <div className="min-h-[calc(100vh-4rem)] bg-background text-foreground grid place-items-center"><RefreshCw className="h-7 w-7 animate-spin text-chart-1" /></div>

  if (!accountResponse) {
    const busy = run && ["queued", "running"].includes(run.status)
    return (
      <main className="min-h-[calc(100vh-4rem)] bg-background text-foreground grid place-items-center px-6">
        <section className="w-full max-w-lg rounded-2xl border border-border bg-card p-8 text-center">
          <Database className="mx-auto h-9 w-9 text-chart-1" />
          <h1 className="mt-4 text-2xl font-semibold">@{username}</h1>
          <p className="mt-2 text-sm text-muted-foreground">この独立DBにはまだタイムラインがありません。</p>
          {busy && (
            <div className="mt-6 rounded-lg bg-secondary/50 p-4 text-left">
              <p className="text-sm font-medium">採掘中</p>
              <p className="mt-1 break-words text-xs text-muted-foreground">{run?.progress_message}</p>
            </div>
          )}
          {run?.status === "failed" && <p className="mt-4 text-sm text-destructive">{run.error_message || "取得に失敗しました"}</p>}
          {error && <p className="mt-4 text-sm text-destructive">{error}</p>}
          <div className="mt-6 flex justify-center gap-2">
            <Button variant="ghost" onClick={() => router.push("/io")}>戻る</Button>
            <select
              value={provider}
              onChange={(event) => setProvider(event.target.value as AcquisitionProvider)}
              disabled={Boolean(busy)}
              aria-label="取得元"
              className="h-9 rounded-md border border-border bg-secondary px-3 text-sm text-foreground disabled:opacity-50"
            >
              {ACQUISITION_PROVIDER_DEFINITIONS.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
            <Button disabled={Boolean(busy)} onClick={startCollection} className="gap-2 bg-chart-1 text-primary-foreground">
              {busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Pickaxe className="h-4 w-4" />}
              {busy ? "採掘中" : "最古1000件を取得"}
            </Button>
          </div>
          <p className="mt-4 text-[11px] text-muted-foreground">開始時のみ確認が表示され、実行するとAPIクレジットを使います。</p>
        </section>
      </main>
    )
  }

  const account = accountResponse.account
  const selectedRangeText = selectedRange
    ? `Selected: ${formatDateRange(posts.filter((post) => post.created_at >= selectedRange.start && post.created_at <= selectedRange.end))}`
    : null
  return (
    <div className="h-[calc(100vh-4rem)] min-h-[640px] flex flex-col bg-background text-foreground">
      <TopBar
        status={run?.status === "running" ? `Excavating via ${acquisitionProviderLabel(run.provider)}` : "Ready"}
        postRange={keyword ? `${timelinePosts.length} / ${posts.length} posts` : `${posts.length} posts`}
        lastUpdated={account.fetched_at}
        dateRange={formatDateRange(posts)}
        selectedRange={selectedRangeText}
        keyword={keyword}
        onKeywordChange={setKeyword}
        onExport={exportPosts}
        provider={provider}
        providerOptions={ACQUISITION_PROVIDER_DEFINITIONS.map((option) => ({ value: option.id, label: option.label }))}
        onProviderChange={(value) => setProvider(value as AcquisitionProvider)}
        onExtend={startCollection}
        extendLabel={run && ["queued", "running"].includes(run.status) ? "採掘中" : "再取得1000"}
        extendDisabled={Boolean(run && ["queued", "running"].includes(run.status))}
      />
      <div className="flex-1 flex overflow-hidden">
        <main className="flex-1 flex flex-col overflow-hidden">
          {run && ["queued", "running"].includes(run.status) && (
            <div className="flex items-center justify-between gap-4 border-b border-border bg-secondary/20 px-4 py-2 text-xs">
              <span className="truncate text-muted-foreground">{run.progress_message || "採掘中"}</span>
              <span className="shrink-0 text-foreground">
                {run.unique_count} / {run.target_count || 1000} 確定
              </span>
            </div>
          )}
          <EngagementChart
            data={chartData}
            onDateClick={(date) => { setHighlightedDate(date); setSelectedRange(null); timelineRef.current?.scrollToDate(date) }}
            onRangeSelect={(start, end) => { setSelectedRange({ start, end }); setHighlightedDate(null) }}
          />
          <Timeline ref={timelineRef} posts={timelinePosts} highlightedDate={highlightedDate} />
        </main>
        <Sidebar
          account={{
            avatar: account.avatar_url || "/favicon.ico",
            displayName: account.display_name || account.username,
            username: account.username,
            bio: account.description || "",
            followers: account.followers_count,
            following: account.following_count,
            posts: posts.length,
            joinedDate: account.created_at || posts[0]?.created_at || new Date().toISOString(),
          }}
          media={media}
          topPosts={topPosts}
          stats={stats}
          onJumpToPost={(postId) => timelineRef.current?.scrollToPost(postId)}
        />
      </div>
    </div>
  )
}
