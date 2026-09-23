"use client"

import { useEffect, useMemo, useRef, useState } from "react"

export interface EngagementPost {
  id: string
  date: string
  text?: string
  likes: number
  retweets: number
  replies: number
}

interface EngagementChartV2Props {
  posts: EngagementPost[]
  selectedRange?: { start: string; end: string } | null
  onDateClick?: (date: string) => void
  onRangeSelect?: (startDate: string, endDate: string) => void
  onPostClick?: (postId: string) => void
}

type ViewMode = "overview" | "perPost"
type Metric = "total" | "likes" | "retweets" | "replies"
type ScaleMode = "balanced" | "linear" | "log"

const metricLabels: Record<Metric, string> = {
  total: "総反応",
  likes: "Likes",
  retweets: "Reposts",
  replies: "Replies",
}

const scaleLabels: Record<ScaleMode, string> = {
  balanced: "見やすく",
  linear: "実数",
  log: "Log",
}

function metricValue(post: EngagementPost, metric: Metric) {
  if (metric === "likes") return post.likes
  if (metric === "retweets") return post.retweets
  if (metric === "replies") return post.replies
  return post.likes + post.retweets + post.replies
}

function quantile(values: number[], q: number) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = (sorted.length - 1) * q
  const lower = Math.floor(index)
  const fraction = index - lower
  return sorted[lower + 1] === undefined
    ? sorted[lower]
    : sorted[lower] + fraction * (sorted[lower + 1] - sorted[lower])
}

function formatCompact(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`
  return Math.round(value).toLocaleString()
}

function formatDate(value: string, withYear = false) {
  return new Date(value).toLocaleDateString("ja-JP", {
    year: withYear ? "numeric" : undefined,
    month: "short",
    day: "numeric",
  })
}

function useContainerWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(720)

  useEffect(() => {
    const element = ref.current
    if (!element) return
    const update = () => setWidth(Math.max(320, element.getBoundingClientRect().width))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return { ref, width }
}

function getScale(values: number[], mode: ScaleMode) {
  const max = Math.max(1, ...values)
  const q1 = quantile(values, 0.25)
  const q3 = quantile(values, 0.75)
  const iqr = q3 - q1
  const balancedCap = Math.max(1, Math.min(max, Math.max(q3, q3 + iqr * 3)))
  const cap = mode === "balanced" ? balancedCap : max
  const transform = (value: number) => mode === "log" ? Math.log10(value + 1) : Math.min(value, cap)
  const transformedMax = mode === "log" ? Math.log10(max + 1) : cap
  return { max, cap, transform, transformedMax: Math.max(1, transformedMax) }
}

interface Bin {
  start: number
  end: number
  posts: EngagementPost[]
  count: number
  q1: number
  median: number
  q3: number
  max: number
}

function makeBins(posts: EngagementPost[], metric: Metric): Bin[] {
  if (!posts.length) return []
  const first = Date.parse(posts[0].date)
  const last = Date.parse(posts[posts.length - 1].date)
  const day = 86_400_000
  const span = Math.max(day, last - first + 1)
  const spanDays = Math.max(1, Math.ceil(span / day))
  const count = Math.min(48, spanDays)
  const binSize = span / count
  const bins = Array.from({ length: count }, (_, index) => ({
    start: first + binSize * index,
    end: first + binSize * (index + 1),
    posts: [] as EngagementPost[],
    count: 0,
    q1: 0,
    median: 0,
    q3: 0,
    max: 0,
  }))

  for (const post of posts) {
    const index = Math.min(count - 1, Math.max(0, Math.floor((Date.parse(post.date) - first) / binSize)))
    bins[index].posts.push(post)
  }

  return bins.map((bin) => {
    const values = bin.posts.map((post) => metricValue(post, metric))
    return {
      ...bin,
      count: bin.posts.length,
      q1: quantile(values, 0.25),
      median: quantile(values, 0.5),
      q3: quantile(values, 0.75),
      max: Math.max(0, ...values),
    }
  })
}

function pointsPath(points: Array<[number, number]>) {
  return points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ")
}

export function EngagementChartV2({
  posts,
  selectedRange,
  onDateClick,
  onRangeSelect,
  onPostClick,
}: EngagementChartV2Props) {
  const sortedPosts = useMemo(
    () => [...posts].sort((a, b) => Date.parse(a.date) - Date.parse(b.date)),
    [posts]
  )
  const [viewMode, setViewMode] = useState<ViewMode>("overview")
  const [metric, setMetric] = useState<Metric>("total")
  const [scaleMode, setScaleMode] = useState<ScaleMode>("balanced")
  const [drag, setDrag] = useState<{ start: number; current: number } | null>(null)
  const [hoveredBin, setHoveredBin] = useState<number | null>(null)
  const [selectedPostId, setSelectedPostId] = useState<string | null>(null)
  const { ref: overviewRef, width: overviewWidth } = useContainerWidth()
  const { ref: perPostRef, width: perPostWidth } = useContainerWidth()

  const bins = useMemo(() => makeBins(sortedPosts, metric), [sortedPosts, metric])
  const allValues = useMemo(() => sortedPosts.map((post) => metricValue(post, metric)), [sortedPosts, metric])
  const overviewScale = useMemo(() => getScale(allValues, scaleMode), [allValues, scaleMode])
  const maxPosts = Math.max(1, ...bins.map((bin) => bin.count))

  const postsInRange = useMemo(() => {
    if (!selectedRange) return sortedPosts
    const start = Date.parse(selectedRange.start)
    const end = Date.parse(selectedRange.end) + 86_399_999
    return sortedPosts.filter((post) => {
      const time = Date.parse(post.date)
      return time >= start && time <= end
    })
  }, [selectedRange, sortedPosts])

  const perPostValues = useMemo(() => postsInRange.map((post) => metricValue(post, metric)), [postsInRange, metric])
  const perPostScale = useMemo(() => getScale(perPostValues, scaleMode), [perPostValues, scaleMode])
  const selectedPost = postsInRange.find((post) => post.id === selectedPostId) ?? null

  const left = 42
  const right = 12
  const plotWidth = Math.max(1, overviewWidth - left - right)
  const centerX = (index: number) => left + ((index + 0.5) / Math.max(1, bins.length)) * plotWidth
  const edgeX = (index: number) => left + (index / Math.max(1, bins.length)) * plotWidth
  const postBaseY = 70
  const postHeight = 48
  const engagementTop = 99
  const engagementHeight = 78
  const engagementBottom = engagementTop + engagementHeight
  const navTop = 203
  const navHeight = 22
  const engagementY = (value: number) => engagementBottom - (overviewScale.transform(value) / overviewScale.transformedMax) * engagementHeight

  const selectBin = (clientX: number, element: SVGSVGElement) => {
    const rect = element.getBoundingClientRect()
    const local = ((clientX - rect.left) / rect.width) * overviewWidth
    return Math.min(bins.length - 1, Math.max(0, Math.floor(((local - left) / plotWidth) * bins.length)))
  }

  const finishSelection = (clientX: number, element: SVGSVGElement) => {
    if (!drag || !bins.length) return
    const current = selectBin(clientX, element)
    const firstIndex = Math.min(drag.start, current)
    const lastIndex = Math.max(drag.start, current)
    const selectedBins = bins.slice(firstIndex, lastIndex + 1)
    const selectedPosts = selectedBins.flatMap((bin) => bin.posts)
    if (firstIndex === lastIndex) {
      const firstPost = selectedPosts[0]
      if (firstPost) onDateClick?.(firstPost.date)
    } else if (selectedPosts.length) {
      onRangeSelect?.(selectedPosts[0].date, selectedPosts[selectedPosts.length - 1].date)
    }
    setDrag(null)
  }

  if (!sortedPosts.length) return null

  const median = quantile(allValues, 0.5)
  const max = Math.max(...allValues)
  const clippedCount = scaleMode === "balanced" ? allValues.filter((value) => value > overviewScale.cap).length : 0

  return (
    <div className="border-b border-border bg-background px-4 pb-4 pt-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 rounded-md bg-secondary p-1 text-sm">
          <button
            type="button"
            onClick={() => setViewMode("overview")}
            className={`rounded px-3 py-1.5 transition-colors ${viewMode === "overview" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
          >
            投稿の流れ
          </button>
          <button
            type="button"
            onClick={() => setViewMode("perPost")}
            className={`rounded px-3 py-1.5 transition-colors ${viewMode === "perPost" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
          >
            投稿ごと
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <label className="flex items-center gap-2 text-muted-foreground">
            指標
            <select
              value={metric}
              onChange={(event) => setMetric(event.target.value as Metric)}
              className="rounded-md border border-border bg-background px-2 py-1.5 text-foreground"
            >
              {(Object.keys(metricLabels) as Metric[]).map((key) => <option key={key} value={key}>{metricLabels[key]}</option>)}
            </select>
          </label>
          <div className="flex rounded-md border border-border p-0.5">
            {(Object.keys(scaleLabels) as ScaleMode[]).map((mode) => (
              <button
                type="button"
                key={mode}
                onClick={() => setScaleMode(mode)}
                className={`rounded px-2 py-1 ${scaleMode === mode ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                {scaleLabels[mode]}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span>{sortedPosts.length.toLocaleString()} posts · 中央値 {formatCompact(median)} · 最大 {formatCompact(max)}</span>
        {scaleMode === "balanced" && clippedCount > 0
          ? <span className="text-amber-500">△ {clippedCount}件の突出値は上端に表示</span>
          : <span>{viewMode === "overview" ? "ドラッグで期間選択 · クリックで移動" : "横にスクロール · 点をクリックで投稿へ"}</span>}
      </div>

      {viewMode === "overview" ? (
        <div ref={overviewRef} className="relative select-none">
          <svg
            width={overviewWidth}
            height={238}
            className="block touch-none overflow-visible"
            role="img"
            aria-label="投稿量と投稿あたりの反応の推移"
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId)
              const index = selectBin(event.clientX, event.currentTarget)
              setDrag({ start: index, current: index })
            }}
            onPointerMove={(event) => {
              const index = selectBin(event.clientX, event.currentTarget)
              setHoveredBin(index)
              if (drag) setDrag({ ...drag, current: index })
            }}
            onPointerLeave={() => setHoveredBin(null)}
            onPointerUp={(event) => finishSelection(event.clientX, event.currentTarget)}
            onPointerCancel={() => setDrag(null)}
          >
            <text x={0} y={18} fill="currentColor" className="fill-muted-foreground text-[10px]">投稿数</text>
            <text x={0} y={100} fill="currentColor" className="fill-muted-foreground text-[10px]">反応/投稿</text>
            {[0, 0.5, 1].map((ratio) => (
              <g key={ratio}>
                <line x1={left} x2={overviewWidth - right} y1={postBaseY - postHeight * ratio} y2={postBaseY - postHeight * ratio} className="stroke-border" strokeDasharray={ratio === 0 ? undefined : "3 4"} />
                <line x1={left} x2={overviewWidth - right} y1={engagementBottom - engagementHeight * ratio} y2={engagementBottom - engagementHeight * ratio} className="stroke-border" strokeDasharray={ratio === 0 ? undefined : "3 4"} />
              </g>
            ))}
            <text x={left - 6} y={postBaseY - postHeight + 3} textAnchor="end" className="fill-muted-foreground text-[9px]">{maxPosts}</text>
            <text x={left - 6} y={engagementTop + 3} textAnchor="end" className="fill-muted-foreground text-[9px]">{formatCompact(overviewScale.cap)}</text>
            <text x={left - 6} y={engagementBottom + 3} textAnchor="end" className="fill-muted-foreground text-[9px]">0</text>

            {bins.map((bin, index) => {
              const binWidth = plotWidth / bins.length
              const height = (bin.count / maxPosts) * postHeight
              return <rect key={`posts-${index}`} x={edgeX(index) + 1} y={postBaseY - height} width={Math.max(1, binWidth - 2)} height={height} rx={1.5} className="fill-chart-1/70" />
            })}

            {bins.some((bin) => bin.count > 0) && (
              <path
                d={`${pointsPath(bins.map((bin, index) => [centerX(index), engagementY(bin.q3)]))} ${pointsPath([...bins].reverse().map((bin, reverseIndex) => [centerX(bins.length - 1 - reverseIndex), engagementY(bin.q1)])).replace(/^M/, "L")} Z`}
                className="fill-chart-2/15"
              />
            )}
            <path d={pointsPath(bins.map((bin, index) => [centerX(index), engagementY(bin.median)]))} fill="none" className="stroke-chart-2" strokeWidth={2} />
            {bins.map((bin, index) => bin.count > 0 && (
              <g key={`engagement-${index}`}>
                <circle cx={centerX(index)} cy={engagementY(bin.median)} r={2.5} className="fill-chart-2" />
                {scaleMode === "balanced" && bin.max > overviewScale.cap && (
                  <polygon points={`${centerX(index)},${engagementTop - 7} ${centerX(index) - 4},${engagementTop} ${centerX(index) + 4},${engagementTop}`} className="fill-amber-500" />
                )}
              </g>
            ))}

            {bins.map((bin, index) => {
              const height = (bin.count / maxPosts) * navHeight
              return <rect key={`nav-${index}`} x={edgeX(index)} y={navTop + navHeight - height} width={Math.max(1, plotWidth / bins.length)} height={height} className="fill-muted-foreground/35" />
            })}
            <rect x={left} y={navTop} width={plotWidth} height={navHeight} rx={3} fill="none" className="stroke-border" />

            {selectedRange && (() => {
              const firstTime = Date.parse(sortedPosts[0].date)
              const lastTime = Date.parse(sortedPosts[sortedPosts.length - 1].date)
              const duration = Math.max(1, lastTime - firstTime)
              const startX = left + Math.max(0, Math.min(1, (Date.parse(selectedRange.start) - firstTime) / duration)) * plotWidth
              const endX = left + Math.max(0, Math.min(1, (Date.parse(selectedRange.end) - firstTime) / duration)) * plotWidth
              return <rect x={startX} y={navTop} width={Math.max(3, endX - startX)} height={navHeight} rx={3} className="fill-chart-1/25 stroke-chart-1" />
            })()}

            {drag && (
              <rect
                x={edgeX(Math.min(drag.start, drag.current))}
                y={8}
                width={edgeX(Math.max(drag.start, drag.current) + 1) - edgeX(Math.min(drag.start, drag.current))}
                height={engagementBottom - 8}
                className="fill-chart-1/10 stroke-chart-1/50"
              />
            )}

            <text x={left} y={237} className="fill-muted-foreground text-[9px]">{formatDate(sortedPosts[0].date, true)}</text>
            <text x={overviewWidth - right} y={237} textAnchor="end" className="fill-muted-foreground text-[9px]">{formatDate(sortedPosts[sortedPosts.length - 1].date, true)}</text>
          </svg>

          {hoveredBin !== null && bins[hoveredBin] && bins[hoveredBin].count > 0 && !drag && (
            <div
              className="pointer-events-none absolute top-7 z-10 min-w-40 -translate-x-1/2 rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-lg"
              style={{ left: Math.max(85, Math.min(overviewWidth - 85, centerX(hoveredBin))) }}
            >
              <p className="mb-1 font-medium text-foreground">{formatDate(bins[hoveredBin].posts[0].date, true)}</p>
              <p className="text-muted-foreground">投稿 {bins[hoveredBin].count}件</p>
              <p className="text-muted-foreground">中央値 {formatCompact(bins[hoveredBin].median)}</p>
              <p className="text-muted-foreground">範囲 {formatCompact(bins[hoveredBin].q1)}–{formatCompact(bins[hoveredBin].q3)}</p>
              <p className="text-muted-foreground">最大 {formatCompact(bins[hoveredBin].max)}</p>
            </div>
          )}
        </div>
      ) : (
        <div ref={perPostRef}>
          {postsInRange.length ? (
            <div className="flex min-w-0">
              <div className="relative h-[220px] w-12 shrink-0 border-r border-border text-[9px] text-muted-foreground">
                <span className="absolute right-2 top-1">{formatCompact(perPostScale.cap)}</span>
                <span className="absolute right-2 top-1/2 -translate-y-1/2">{formatCompact(scaleMode === "log" ? Math.sqrt(perPostScale.max) : perPostScale.cap / 2)}</span>
                <span className="absolute bottom-7 right-2">0</span>
              </div>
              <div className="min-w-0 flex-1 overflow-x-auto pb-2" aria-label="投稿ごとの反応グラフ">
                {(() => {
                  const innerWidth = Math.max(perPostWidth - 48, postsInRange.length * 14)
                  const top = 12
                  const bottom = 188
                  const height = bottom - top
                  const y = (value: number) => bottom - (perPostScale.transform(value) / perPostScale.transformedMax) * height
                  const labelEvery = Math.max(1, Math.ceil(120 / 14))
                  return (
                    <svg width={innerWidth} height={220} className="block max-w-none">
                      {[0, 0.5, 1].map((ratio) => <line key={ratio} x1={0} x2={innerWidth} y1={bottom - height * ratio} y2={bottom - height * ratio} className="stroke-border" strokeDasharray={ratio === 0 ? undefined : "3 4"} />)}
                      {postsInRange.map((post, index) => {
                        const value = metricValue(post, metric)
                        const x = (index + 0.5) * (innerWidth / postsInRange.length)
                        const pointY = y(value)
                        const clipped = scaleMode === "balanced" && value > perPostScale.cap
                        const selected = selectedPostId === post.id
                        return (
                          <g
                            key={post.id}
                            className="cursor-pointer"
                            onClick={() => {
                              setSelectedPostId(post.id)
                              onPostClick?.(post.id)
                            }}
                          >
                            <title>{`${formatDate(post.date, true)} · ${metricLabels[metric]} ${value.toLocaleString()}\nLikes ${post.likes.toLocaleString()} · Reposts ${post.retweets.toLocaleString()} · Replies ${post.replies.toLocaleString()}`}</title>
                            <rect x={x - 7} y={0} width={14} height={205} fill="transparent" />
                            <line x1={x} x2={x} y1={bottom} y2={pointY} className={selected ? "stroke-chart-3" : "stroke-chart-1/25"} />
                            {clipped
                              ? <polygon points={`${x},${top - 2} ${x - 4},${top + 5} ${x + 4},${top + 5}`} className="fill-amber-500" />
                              : <circle cx={x} cy={pointY} r={selected ? 4 : 2.5} className={selected ? "fill-chart-3" : "fill-chart-1"} />}
                            {index % labelEvery === 0 && <text x={x} y={211} textAnchor="middle" className="fill-muted-foreground text-[8px]">{formatDate(post.date)}</text>}
                          </g>
                        )
                      })}
                    </svg>
                  )
                })()}
              </div>
            </div>
          ) : <p className="py-14 text-center text-sm text-muted-foreground">選択期間に投稿がありません。</p>}

          {selectedPost && (
            <button
              type="button"
              onClick={() => onPostClick?.(selectedPost.id)}
              className="mt-2 w-full rounded-md border border-border bg-secondary/40 px-3 py-2 text-left hover:bg-secondary"
            >
              <span className="text-xs text-muted-foreground">{formatDate(selectedPost.date, true)} · 総反応 {(selectedPost.likes + selectedPost.retweets + selectedPost.replies).toLocaleString()}</span>
              {selectedPost.text && <span className="mt-1 block truncate text-sm text-foreground">{selectedPost.text}</span>}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
