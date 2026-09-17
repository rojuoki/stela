"use client"

import { useState, useRef, useCallback, useMemo, useEffect } from "react"
import { useParams, useRouter } from "next/navigation"
import { useUser } from "@/contexts/UserContext"
import { TopBar } from "@/components/dashboard/top-bar"
import { EngagementChart } from "@/components/dashboard/engagement-chart"
import { Timeline, TimelineHandle } from "@/components/dashboard/timeline"
import { Sidebar } from "@/components/dashboard/sidebar"

const IS_DEV = process.env.NEXT_PUBLIC_DEV_PANEL === "1"

// ─── Dev: extend1000 floating bar ───────────────────────────────────────────
function DevExtend1000Bar({ username, postCount, onDone }: {
  username: string
  postCount: number
  onDone: () => void
}) {
  type Status = "idle" | "loading" | "polling" | "done" | "error"
  const [status, setStatus] = useState<Status>("idle")
  const [msg, setMsg] = useState("")
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopPoll = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
  }

  const pollJob = useCallback((jobId: string) => {
    stopPoll()
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}`)
        if (!res.ok) return
        const data = await res.json()
        const job = data.job
        if (!job) return
        if (job.status === "succeeded") {
          stopPoll()
          setStatus("done")
          setMsg(`done — fetched ${job.fetched_count} (${job.api_calls} calls)`)
          onDone()
        } else if (job.status === "failed" || job.status === "canceled") {
          stopPoll()
          setStatus("error")
          setMsg(`job ${job.status}: ${job.error_code ?? "unknown"}`)
        } else {
          setMsg(`${job.status} — ${job.fetched_count} fetched, ${job.api_calls} calls`)
        }
      } catch { /* ignore */ }
    }, 2000)
  }, [onDone])

  useEffect(() => () => stopPoll(), [])

  const handleClick = async () => {
    if (status === "loading" || status === "polling") return
    setStatus("loading")
    setMsg("")
    try {
      const res = await fetch("/api/dev/extend1000", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username }),
        credentials: "include",
      })
      const data = await res.json()
      if (!res.ok) {
        setStatus("error")
        setMsg(data.error ?? `HTTP ${res.status}`)
        return
      }
      if (data.executionMode === "grant_only") {
        setStatus("done")
        setMsg(`granted → boundary ${data.boundary.new}`)
        onDone()
      } else if (data.executionMode === "excavate_more" && data.jobId) {
        setStatus("polling")
        setMsg(`excavating… (job ${data.jobId.slice(0, 8)})`)
        pollJob(data.jobId)
      }
    } catch {
      setStatus("error")
      setMsg("network error")
    }
  }

  const color =
    status === "done" ? "text-emerald-400" :
    status === "error" ? "text-red-400" :
    status === "polling" ? "text-yellow-400" :
    "text-zinc-400"

  return (
    <div className="fixed bottom-4 right-4 z-50 flex items-center gap-3 bg-zinc-900/95 border border-zinc-700 rounded-lg px-3 py-2 font-mono text-[11px] shadow-lg">
      <span className="text-zinc-600">dev</span>
      <span className="text-zinc-500">{postCount} posts</span>
      {msg && <span className={`max-w-[220px] truncate ${color}`}>{msg}</span>}
      <button
        onClick={handleClick}
        disabled={status === "loading" || status === "polling"}
        className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
      >
        {status === "loading" ? "…" : status === "polling" ? "digging…" : "+1000"}
      </button>
      {(status === "done" || status === "error") && (
        <button onClick={() => { setStatus("idle"); setMsg("") }} className="text-zinc-600 hover:text-zinc-400">
          ✕
        </button>
      )}
    </div>
  )
}

// Real data types from existing API
interface AccountData {
  account_id: string
  username: string
  display_name: string | null
  avatar_url: string | null
  description: string | null
  created_at: string | null
  protected: boolean
}

interface TweetData {
  post_id: string
  account_id: string
  created_at: string
  full_text: string
  media_json: string | null
  like_count: number
  retweet_count: number
  reply_count: number
}

// Transform data for v0 components
function transformAccountData(account: AccountData) {
  return {
    avatar: account.avatar_url || `https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=96&h=96&fit=crop&crop=face`,
    displayName: account.display_name || account.username,
    username: account.username,
    bio: account.description || "Building the future, one commit at a time.",
    followers: 50000, // Placeholder - not in scope
    following: 500,   // Placeholder - not in scope
    posts: 0, // Will be filled from tweets count
    joinedDate: account.created_at ? account.created_at.split('T')[0] : "2019-01-01",
  }
}

function transformTweetData(tweets: TweetData[]) {
  // CRITICAL: Explicitly sort by created_at ASC (oldest to newest)
  // This preserves Stela's "earliest posts" characteristic
  const sortedTweets = [...tweets].sort((a, b) => 
    new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  )
  
  return sortedTweets.map((tweet) => ({
    id: tweet.post_id,
    date: tweet.created_at,
    text: tweet.full_text,
    likes: tweet.like_count,
    retweets: tweet.retweet_count,
    replies: tweet.reply_count,
    hasMedia: !!tweet.media_json,
  }))
}

function generateChartData(tweets: TweetData[]): any[] {
  if (tweets.length === 0) return []

  // Group tweets by date
  const dateGroups = tweets.reduce((acc, tweet) => {
    const date = tweet.created_at.split('T')[0]
    if (!acc[date]) {
      acc[date] = []
    }
    acc[date].push(tweet)
    return acc
  }, {} as Record<string, TweetData[]>)

  // Find actual date range from tweets
  const dates = tweets.map(t => new Date(t.created_at).getTime())
  const minDate = new Date(Math.min(...dates))
  const maxDate = new Date(Math.max(...dates))
  
  // Set to start of day
  minDate.setHours(0, 0, 0, 0)
  maxDate.setHours(0, 0, 0, 0)

  // Generate chart data for actual date range
  const chartData = []
  const currentDate = new Date(minDate)
  
  while (currentDate <= maxDate) {
    const dateStr = currentDate.toISOString().split('T')[0]
    const dayTweets = dateGroups[dateStr] || []
    
    const likes = dayTweets.reduce((sum, t) => sum + t.like_count, 0)
    const retweets = dayTweets.reduce((sum, t) => sum + t.retweet_count, 0)
    const replies = dayTweets.reduce((sum, t) => sum + t.reply_count, 0)
    
    chartData.push({
      date: currentDate.toISOString(),
      posts: dayTweets.length,
      engagement: likes + retweets + replies,
      likes,
      retweets,
      replies,
    })
    
    // Move to next day
    currentDate.setDate(currentDate.getDate() + 1)
  }
  
  return chartData
}

function formatDateRange(start: Date, end: Date): string {
  const startStr = start.toLocaleDateString("en-US", { month: "short", day: "numeric" })
  const endStr = end.toLocaleDateString("en-US", { month: "short", day: "numeric" })
  return `${startStr} – ${endStr}`
}

export default function PrototypeDashboardPage() {
  const params = useParams()
  const router = useRouter()
  const { user, loading: authLoading } = useUser()
  const username = Array.isArray(params.username) ? params.username[0] : params.username
  
  // Data state
  const [accountData, setAccountData] = useState<AccountData | null>(null)
  const [tweets, setTweets] = useState<TweetData[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // UI state
  const timelineRef = useRef<TimelineHandle>(null)
  const [highlightedDate, setHighlightedDate] = useState<string | null>(null)
  const [selectedRange, setSelectedRange] = useState<{ start: string; end: string } | null>(null)

  // Redirect if not logged in
  useEffect(() => {
    if (!authLoading && !user) {
      router.push("/login")
    }
  }, [user, authLoading, router])

  // Reload data after extend1000 completes
  const reloadTweets = useCallback(async () => {
    if (!accountData) return
    try {
      const res = await fetch(`/api/tweets/${accountData.account_id}`, { credentials: "include" })
      if (!res.ok) return
      const data = await res.json()
      setTweets(data.tweets || [])
    } catch { /* ignore */ }
  }, [accountData])

  // Load account and tweets data
  useEffect(() => {
    if (!user || !username) return

    const loadData = async () => {
      setLoading(true)
      setError(null)

      try {
        // 1. Load account data
        const accountRes = await fetch(`/api/account?username=${encodeURIComponent(username)}`, {
          credentials: 'include'
        })
        
        if (!accountRes.ok) {
          if (accountRes.status === 404) {
            setError("Account not found")
          } else {
            setError(`Failed to load account: HTTP ${accountRes.status}`)
          }
          return
        }
        
        const account: AccountData = await accountRes.json()
        setAccountData(account)

        // 2. Load tweets data
        const tweetsRes = await fetch(`/api/tweets/${account.account_id}`, {
          credentials: 'include'
        })
        
        if (!tweetsRes.ok) {
          setError(`Failed to load tweets: HTTP ${tweetsRes.status}`)
          return
        }
        
        const tweetsData = await tweetsRes.json()
        setTweets(tweetsData.tweets || [])

      } catch (err) {
        console.error('Failed to load data:', err)
        setError('Network error')
      } finally {
        setLoading(false)
      }
    }

    loadData()
  }, [user, username])

  // Transform data for v0 components
  const transformedAccount = useMemo(() => {
    if (!accountData) return null
    const transformed = transformAccountData(accountData)
    transformed.posts = tweets.length // Update posts count
    return transformed
  }, [accountData, tweets.length])

  // Main timeline tweets: ALWAYS oldest to newest (Stela's core feature)
  const transformedTweets = useMemo(() => {
    return transformTweetData(tweets)
  }, [tweets])

  const chartData = useMemo(() => {
    return generateChartData(tweets)
  }, [tweets])

  // Calculate date range
  const fullDateRange = useMemo(() => {
    if (chartData.length === 0) return ""
    const start = new Date(chartData[0].date)
    const end = new Date(chartData[chartData.length - 1].date)
    return formatDateRange(start, end)
  }, [chartData])

  // Format selected range for display
  const selectedRangeText = useMemo(() => {
    if (!selectedRange) return null
    const start = new Date(selectedRange.start)
    const end = new Date(selectedRange.end)
    return `Selected: ${formatDateRange(start, end)}`
  }, [selectedRange])

  const handleDateClick = useCallback((date: string) => {
    setHighlightedDate(date)
    setSelectedRange(null)
    timelineRef.current?.scrollToDate(date)
  }, [])

  const handleRangeSelect = useCallback((startDate: string, endDate: string) => {
    setSelectedRange({ start: startDate, end: endDate })
    setHighlightedDate(null)
  }, [])

  const handleJumpToPost = useCallback((postId: string) => {
    timelineRef.current?.scrollToPost(postId)
  }, [])

  // Generate placeholder data for components that need it
  const mediaItems = transformedTweets
    .filter(post => post.hasMedia)
    .slice(0, 12)
    .map((post, i) => ({
      id: `media-${i}`,
      type: "image" as const, // Simplified for now
      thumbnail: `https://images.unsplash.com/photo-${1400000000 + i}?w=200&h=200&fit=crop`,
      postDate: post.date.split('T')[0],
      postId: post.id,
    }))

  // Top Posts: Sort by engagement (likes + retweets) DESC for sidebar display
  // This is separate from main timeline which should remain chronological
  const topPosts = [...transformedTweets]
    .sort((a, b) => (b.likes + b.retweets) - (a.likes + a.retweets))
    .slice(0, 5)

  const stats = {
    totalPosts: transformedTweets.length,
    totalLikes: transformedTweets.reduce((sum, post) => sum + post.likes, 0),
    totalRetweets: transformedTweets.reduce((sum, post) => sum + post.retweets, 0),
    avgEngagement: transformedTweets.length > 0 
      ? Math.round(transformedTweets.reduce((sum, post) => sum + post.likes + post.retweets, 0) / transformedTweets.length * 10) / 10
      : 0,
    postsPerDay: transformedTweets.length > 0 
      ? Math.round(transformedTweets.length / 30 * 10) / 10 
      : 0,
    peakHour: "2:00 PM", // Placeholder
  }

  if (authLoading || loading) {
    return (
      <div className="min-h-[calc(100vh-4rem)] flex items-center justify-center bg-background text-foreground">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    )
  }

  if (error || !transformedAccount) {
    return (
      <div className="min-h-[calc(100vh-4rem)] flex items-center justify-center bg-background text-foreground">
        <div className="text-center">
          <h1 className="text-xl font-bold text-destructive mb-2">Error</h1>
          <p className="text-muted-foreground">{error || "Failed to load account data"}</p>
          <button 
            onClick={() => router.back()}
            className="mt-4 px-4 py-2 bg-primary text-primary-foreground rounded hover:bg-primary/90"
          >
            Go Back
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="h-[calc(100vh-4rem)] flex flex-col bg-background text-foreground">
      <TopBar
        status="Ready"
        postRange={`${transformedTweets.length} posts`}
        lastUpdated="now"
        dateRange={fullDateRange}
        selectedRange={selectedRangeText}
      />
      
      <div className="flex-1 flex overflow-hidden">
        <main className="flex-1 flex flex-col overflow-hidden">
          <EngagementChart 
            data={chartData}
            onDateClick={handleDateClick}
            onRangeSelect={handleRangeSelect}
          />
          <Timeline 
            ref={timelineRef}
            posts={transformedTweets}
            highlightedDate={highlightedDate}
          />
        </main>
        
        <Sidebar
          account={transformedAccount}
          media={mediaItems}
          topPosts={topPosts}
          stats={stats}
          onJumpToPost={handleJumpToPost}
        />
      </div>

      {IS_DEV && username && (
        <DevExtend1000Bar
          username={username}
          postCount={transformedTweets.length}
          onDone={reloadTweets}
        />
      )}
    </div>
  )
}