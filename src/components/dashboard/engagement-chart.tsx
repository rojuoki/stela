"use client"

import { useMemo, useState, useCallback, useEffect, useRef } from "react"
import {
  ComposedChart,
  Area,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceArea,
  type MouseHandlerDataParam,
} from "recharts"

interface DataPoint {
  date: string
  rangeStart?: string
  rangeEnd?: string
  posts: number
  engagement: number
  likes: number
  retweets: number
  replies?: number
}

interface PerPostPoint {
  id: string
  date: string
  likes: number
  retweets: number
  replies?: number
}

interface EngagementChartProps {
  data: DataPoint[]
  perPostData?: PerPostPoint[]
  selectedRange?: { start: string; end: string } | null
  onDateClick?: (date: string) => void
  onPostClick?: (postId: string) => void
  onRangeSelect?: (startDate: string, endDate: string) => void
  onRangeClear?: () => void
}

type ViewMode = "overview" | "perPost"

export function EngagementChart({ data, perPostData, selectedRange, onDateClick, onPostClick, onRangeSelect, onRangeClear }: EngagementChartProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("overview")
  const [refAreaLeft, setRefAreaLeft] = useState<string | null>(null)
  const [refAreaRight, setRefAreaRight] = useState<string | null>(null)
  const [isSelecting, setIsSelecting] = useState(false)
  const selectionStartRef = useRef<string | null>(null)
  const selectionEndRef = useRef<string | null>(null)
  const perPostScrollRef = useRef<HTMLDivElement>(null)
  const [perPostScroll, setPerPostScroll] = useState({ left: 0, max: 0, viewport: 0 })

  const visibleData = useMemo(() => {
    if (!selectedRange) return data
    const start = selectedRange.start.slice(0, 10)
    const end = selectedRange.end.slice(0, 10)
    return data.filter((point) => {
      const date = point.date.slice(0, 10)
      return date >= start && date <= end
    })
  }, [data, selectedRange])

  const chartData = useMemo(() => {
    if (visibleData.length === 0) return []

    // データポイント数に応じた最適なビニング戦略を決定
    const getOptimalBinning = (dataPoints: number): 'raw' | 'day' | 'week' | 'month' => {
      if (dataPoints <= 30) return 'raw'      // そのまま
      if (dataPoints <= 90) return 'day'      // 日単位
      if (dataPoints <= 365) return 'week'    // 週単位  
      return 'month'                           // 月単位
    }

    const binType = getOptimalBinning(visibleData.length)

    // ビニング関数
    const aggregateData = (rawData: DataPoint[], binning: typeof binType) => {
      if (binning === 'raw') {
        return rawData.map((d) => ({
          ...d,
          rangeStart: d.rangeStart || d.date,
          rangeEnd: d.rangeEnd || d.date,
          dateLabel: new Date(d.date).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
          fullDate: new Date(d.date).toLocaleDateString("en-US", { 
            weekday: "short",
            month: "short", 
            day: "numeric",
            year: "numeric"
          }),
        }))
      }

      // グループ化キーを生成
      const getGroupKey = (date: Date): string => {
        if (binning === 'day') {
          return date.toISOString().split('T')[0] // YYYY-MM-DD
        } else if (binning === 'week') {
          // 週の開始日（日曜日）を取得
          const day = date.getDay()
          const diff = date.getDate() - day
          const weekStart = new Date(date.setDate(diff))
          return weekStart.toISOString().split('T')[0]
        } else { // month
          return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`
        }
      }

      // データを集約
      const grouped = new Map<string, DataPoint>()
      
      rawData.forEach((d) => {
        const date = new Date(d.date)
        const key = getGroupKey(date)
        
        if (!grouped.has(key)) {
          grouped.set(key, {
            date: key,
            rangeStart: d.rangeStart || d.date,
            rangeEnd: d.rangeEnd || d.date,
            posts: 0,
            engagement: 0,
            likes: 0,
            retweets: 0,
            replies: 0,
          })
        }
        
        const group = grouped.get(key)!
        const pointStart = d.rangeStart || d.date
        const pointEnd = d.rangeEnd || d.date
        if (!group.rangeStart || pointStart < group.rangeStart) group.rangeStart = pointStart
        if (!group.rangeEnd || pointEnd > group.rangeEnd) group.rangeEnd = pointEnd
        group.posts += d.posts
        group.engagement += d.engagement
        group.likes += d.likes
        group.retweets += d.retweets
        group.replies = (group.replies || 0) + (d.replies || 0)
      })

      // 日付順にソート & ラベル生成
      return Array.from(grouped.values())
        .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
        .map((d) => {
          const date = new Date(d.date)
          let dateLabel = ''
          let fullDate = ''

          if (binning === 'day') {
            dateLabel = date.toLocaleDateString("en-US", { month: "short", day: "numeric" })
            fullDate = date.toLocaleDateString("en-US", { 
              weekday: "short",
              month: "short", 
              day: "numeric",
              year: "numeric"
            })
          } else if (binning === 'week') {
            const weekEnd = new Date(date)
            weekEnd.setDate(weekEnd.getDate() + 6)
            dateLabel = `${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
            fullDate = `Week of ${date.toLocaleDateString("en-US", { 
              month: "short", 
              day: "numeric",
              year: "numeric"
            })}`
          } else { // month
            dateLabel = date.toLocaleDateString("en-US", { month: "short", year: "2-digit" })
            fullDate = date.toLocaleDateString("en-US", { 
              month: "long",
              year: "numeric"
            })
          }

          return {
            ...d,
            dateLabel,
            fullDate,
          }
        })
    }

    return aggregateData(visibleData, binType)
  }, [visibleData])

  const perPostChartData = useMemo(() => {
    const start = selectedRange?.start.slice(0, 10)
    const end = selectedRange?.end.slice(0, 10)
    return [...(perPostData || [])]
      .filter((post) => {
        const date = post.date.slice(0, 10)
        return (!start || date >= start) && (!end || date <= end)
      })
      .sort((a, b) => Date.parse(a.date) - Date.parse(b.date))
      .map((post) => ({
        ...post,
        dateLabel: new Date(post.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" }),
        fullDate: new Date(post.date).toLocaleDateString("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
          year: "numeric",
        }),
      }))
  }, [perPostData, selectedRange])

  const perPostChartWidth = Math.max(760, perPostChartData.length * 14)
  const perPostTickInterval = Math.max(0, Math.ceil(perPostChartData.length / Math.max(2, Math.floor(perPostChartWidth / 100))) - 1)

  const syncPerPostScroll = useCallback(() => {
    const element = perPostScrollRef.current
    if (!element) return
    setPerPostScroll({ left: element.scrollLeft, max: Math.max(0, element.scrollWidth - element.clientWidth), viewport: element.clientWidth })
  }, [])

  useEffect(() => {
    if (viewMode !== "perPost") return
    const frame = requestAnimationFrame(syncPerPostScroll)
    window.addEventListener("resize", syncPerPostScroll)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener("resize", syncPerPostScroll)
    }
  }, [viewMode, perPostChartWidth, syncPerPostScroll])

  const movePerPost = useCallback((direction: -1 | 1) => {
    const element = perPostScrollRef.current
    if (!element) return
    element.scrollBy({ left: direction * element.clientWidth * 0.8, behavior: "smooth" })
  }, [])

  const visiblePerPostData = useMemo(() => {
    if (!perPostChartData.length) return []
    const contentWidth = Math.max(1, perPostScroll.max + perPostScroll.viewport)
    const start = Math.max(0, Math.floor((perPostScroll.left / contentWidth) * perPostChartData.length) - 2)
    const end = Math.min(perPostChartData.length, Math.ceil(((perPostScroll.left + perPostScroll.viewport) / contentWidth) * perPostChartData.length) + 2)
    return perPostChartData.slice(start, Math.max(start + 1, end))
  }, [perPostChartData, perPostScroll])

  const perPostYAxisMax = useMemo(() => {
    const values = visiblePerPostData.flatMap((post) => [post.likes, post.retweets, post.replies || 0]).sort((a, b) => a - b)
    if (!values.length) return 1
    const percentileIndex = Math.min(values.length - 1, Math.floor((values.length - 1) * 0.95))
    return Math.max(1, Math.ceil(values[percentileIndex] * 1.15))
  }, [visiblePerPostData])

  const handlePerPostAreaClick = useCallback((clientX: number, clientY: number) => {
    const element = perPostScrollRef.current
    if (!element || !perPostChartData.length) return
    const rect = element.getBoundingClientRect()
    if (clientY - rect.top > 176) return
    const chartLeft = 40
    const contentX = clientX - rect.left + element.scrollLeft
    const plotWidth = Math.max(1, perPostChartWidth - chartLeft)
    const index = Math.floor(((contentX - chartLeft) / plotWidth) * perPostChartData.length)
    const post = perPostChartData[Math.max(0, Math.min(perPostChartData.length - 1, index))]
    if (post) onPostClick?.(post.id)
  }, [onPostClick, perPostChartData, perPostChartWidth])

  // 動的なY軸のドメインを計算
  const getYAxisDomain = useCallback((dataKey: 'posts' | 'engagement'): [number, number | string] => {
    if (chartData.length === 0) return [0, 'auto']
    
    const values = chartData.map(d => d[dataKey])
    const min = Math.min(...values)
    const max = Math.max(...values)
    const range = max - min

    // 範囲が小さい場合は調整
    if (range < max * 0.3) {
      const padding = Math.max(range * 0.2, max * 0.1)
      return [Math.max(0, min - padding), max + padding]
    }

    return [0, 'auto']
  }, [chartData])

  const handleMouseDown = useCallback((e: MouseHandlerDataParam) => {
    if (e.activeLabel !== undefined) {
      const label = String(e.activeLabel)
      selectionStartRef.current = label
      selectionEndRef.current = null
      setRefAreaLeft(label)
      setRefAreaRight(null)
      setIsSelecting(true)
    }
  }, [])

  const handleMouseMove = useCallback((e: MouseHandlerDataParam) => {
    if (selectionStartRef.current && e.activeLabel !== undefined) {
      const label = String(e.activeLabel)
      selectionEndRef.current = label
      setRefAreaRight(label)
    }
  }, [])

  const handleMouseUp = useCallback((e: MouseHandlerDataParam) => {
    const startLabel = selectionStartRef.current
    const endLabel = selectionEndRef.current || (e.activeLabel !== undefined ? String(e.activeLabel) : null)
    if (startLabel && endLabel && startLabel !== endLabel && onRangeSelect) {
      const leftIndex = chartData.findIndex(d => d.date === startLabel)
      const rightIndex = chartData.findIndex(d => d.date === endLabel)
      
      if (leftIndex !== -1 && rightIndex !== -1) {
        const startIdx = Math.min(leftIndex, rightIndex)
        const endIdx = Math.max(leftIndex, rightIndex)
        onRangeSelect(
          chartData[startIdx].rangeStart || chartData[startIdx].date,
          chartData[endIdx].rangeEnd || chartData[endIdx].date
        )
      }
    } else if (startLabel && onDateClick) {
      const index = chartData.findIndex(d => d.date === startLabel)
      if (index !== -1) onDateClick(chartData[index].rangeStart || chartData[index].date)
    }
    selectionStartRef.current = null
    selectionEndRef.current = null
    setRefAreaLeft(null)
    setRefAreaRight(null)
    setIsSelecting(false)
  }, [chartData, onRangeSelect, onDateClick])

  const handleChartClick = useCallback((e: MouseHandlerDataParam) => {
    const index = Number(e.activeTooltipIndex)
    if (!isSelecting && Number.isInteger(index) && chartData[index] && onDateClick) {
      onDateClick(chartData[index].date)
    }
  }, [isSelecting, onDateClick, chartData])

  return (
    <div className={`${viewMode === "perPost" ? "h-[290px]" : "h-[260px]"} border-b border-border p-4`}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-4">
          {/* Tabs */}
          <div className="flex items-center gap-1 text-sm">
            <button
              onClick={() => setViewMode("overview")}
              className={`px-2 py-1 rounded transition-colors ${
                viewMode === "overview"
                  ? "text-foreground bg-accent"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Overview
            </button>
            <button
              onClick={() => setViewMode("perPost")}
              className={`px-2 py-1 rounded transition-colors ${
                viewMode === "perPost"
                  ? "text-foreground bg-accent"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Per Post
            </button>
          </div>

          {/* Legend */}
          {viewMode === "overview" ? (
            <div className="flex items-center gap-4 text-xs">
              <div className="flex items-center gap-1.5">
                <div 
                  className="w-2 h-2 rounded-sm" 
                  style={{ backgroundColor: "oklch(0.7 0.15 220)" }} 
                />
                <span className="text-muted-foreground">Posts</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div 
                  className="w-2 h-2 rounded-full" 
                  style={{ backgroundColor: "oklch(0.65 0.12 160)" }} 
                />
                <span className="text-muted-foreground">Total reactions</span>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-4 text-xs">
              <div className="flex items-center gap-1.5">
                <div 
                  className="w-2 h-2 rounded-sm" 
                  style={{ backgroundColor: "oklch(0.7 0.15 220)" }} 
                />
                <span className="text-muted-foreground">Likes</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div 
                  className="w-2 h-2 rounded-full" 
                  style={{ backgroundColor: "oklch(0.65 0.12 160)" }} 
                />
                <span className="text-muted-foreground">Reposts</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div 
                  className="w-2 h-2 rounded-full" 
                  style={{ backgroundColor: "oklch(0.7 0.12 60)" }} 
                />
                <span className="text-muted-foreground">Replies</span>
              </div>
            </div>
          )}
        </div>
        {selectedRange ? (
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>{new Date(selectedRange.start).toLocaleDateString("ja-JP")} — {new Date(selectedRange.end).toLocaleDateString("ja-JP")}</span>
            <button type="button" onClick={onRangeClear} className="text-foreground hover:underline">全期間に戻す</button>
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">
            {viewMode === "overview" ? "Click to jump · Drag to zoom" : "Scroll horizontally · Click to jump"}
          </div>
        )}
      </div>

      <div
        ref={viewMode === "perPost" ? perPostScrollRef : undefined}
        onScroll={viewMode === "perPost" ? syncPerPostScroll : undefined}
        onClick={viewMode === "perPost" ? (event) => handlePerPostAreaClick(event.clientX, event.clientY) : undefined}
        className={viewMode === "perPost" ? "overflow-x-scroll overflow-y-hidden" : "overflow-hidden"}
        style={viewMode === "perPost" ? { scrollbarGutter: "stable" } : undefined}
      >
      <ResponsiveContainer width={viewMode === "perPost" ? perPostChartWidth : "100%"} height={190}>
        {viewMode === "overview" ? (
          <ComposedChart 
            data={chartData}
            margin={{ top: 0, right: 0, left: -20, bottom: 0 }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onClick={handleChartClick}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.25 0 0)" vertical={false} />
            <XAxis
              dataKey="date"
              axisLine={false}
              tickLine={false}
              tick={{ fontSize: 10, fill: "oklch(0.6 0 0)" }}
              interval="preserveStartEnd"
              tickFormatter={(date) => chartData.find((point) => point.date === String(date))?.dateLabel || ""}
            />
            {/* Left Y-axis for Posts */}
            <YAxis
              yAxisId="left"
              orientation="left"
              axisLine={false}
              tickLine={false}
              tick={{ fontSize: 10, fill: "oklch(0.7 0.15 220)" }}
              domain={getYAxisDomain('posts')}
              label={{ 
                value: 'Posts', 
                angle: -90, 
                position: 'insideLeft',
                style: { fontSize: 10, fill: "oklch(0.7 0.15 220)" },
                offset: 10
              }}
            />
            {/* Right Y-axis for Engagement */}
            <YAxis
              yAxisId="right"
              orientation="right"
              axisLine={false}
              tickLine={false}
              tick={{ fontSize: 10, fill: "oklch(0.65 0.12 160)" }}
              tickFormatter={(value) => (value >= 1000 ? `${(value / 1000).toFixed(0)}K` : value)}
              domain={getYAxisDomain('engagement')}
              label={{ 
                value: 'Reactions',
                angle: 90, 
                position: 'insideRight',
                style: { fontSize: 10, fill: "oklch(0.65 0.12 160)" },
                offset: 10
              }}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "oklch(0.15 0 0)",
                border: "1px solid oklch(0.25 0 0)",
                borderRadius: "6px",
                fontSize: "12px",
              }}
              labelFormatter={(label) => chartData.find((point) => point.date === String(label))?.fullDate || label}
              labelStyle={{ color: "oklch(0.95 0 0)", marginBottom: "4px" }}
              itemStyle={{ color: "oklch(0.6 0 0)" }}
              formatter={(value, name, item) => {
                if (String(name) === "posts") return [Number(value ?? 0).toLocaleString(), "Posts"]
                const total = Number(value ?? 0)
                const count = Number((item.payload as { posts?: number } | undefined)?.posts || 0)
                const average = count > 0 ? total / count : 0
                return [`${total.toLocaleString()} total · ${average.toFixed(1)}/post`, "Reactions"]
              }}
            />
            {/* Posts as area on left axis */}
            <Area
              yAxisId="left"
              type="monotone"
              dataKey="posts"
              fill="oklch(0.7 0.15 220 / 0.2)"
              stroke="oklch(0.7 0.15 220)"
              strokeWidth={2}
              style={{ cursor: "pointer" }}
            />
            {/* Engagement as area on right axis */}
            <Area
              yAxisId="right"
              type="monotone"
              dataKey="engagement"
              fill="oklch(0.65 0.12 160 / 0.2)"
              stroke="oklch(0.65 0.12 160)"
              strokeWidth={2}
              style={{ cursor: "pointer" }}
            />
            {refAreaLeft && refAreaRight && (
              <ReferenceArea
                yAxisId="left"
                x1={refAreaLeft}
                x2={refAreaRight}
                strokeOpacity={0.3}
                fill="oklch(0.7 0.15 220)"
                fillOpacity={0.2}
              />
            )}
          </ComposedChart>
        ) : (
          <ComposedChart 
            data={perPostChartData}
            margin={{ top: 0, right: 0, left: -20, bottom: 0 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.25 0 0)" vertical={false} />
            <XAxis
              dataKey="id"
              axisLine={false}
              tickLine={false}
              tick={{ fontSize: 10, fill: "oklch(0.6 0 0)" }}
              interval={perPostTickInterval}
              tickFormatter={(id) => perPostChartData.find((post) => post.id === String(id))?.dateLabel || ""}
            />
            <YAxis
              axisLine={false}
              tickLine={false}
              tick={{ fontSize: 10, fill: "oklch(0.6 0 0)" }}
              tickFormatter={(value) => (value >= 1000 ? `${(value / 1000).toFixed(0)}K` : value)}
              domain={[0, perPostYAxisMax]}
              allowDataOverflow
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "oklch(0.15 0 0)",
                border: "1px solid oklch(0.25 0 0)",
                borderRadius: "6px",
                fontSize: "12px",
              }}
              labelFormatter={(label) => {
                const point = perPostChartData.find(d => d.id === String(label))
                return point?.fullDate || label
              }}
              labelStyle={{ color: "oklch(0.95 0 0)", marginBottom: "4px" }}
              itemStyle={{ color: "oklch(0.6 0 0)" }}
              formatter={(value, name) => {
                const labels: Record<string, string> = {
                  likes: "Likes",
                  retweets: "Reposts",
                  replies: "Replies"
                }
                const key = String(name)
                return [Number(value ?? 0).toLocaleString(), labels[key] || key]
              }}
            />
            <Bar
              dataKey="likes"
              fill="oklch(0.7 0.15 220)"
              radius={[2, 2, 0, 0]}
              barSize={8}
              style={{ cursor: "pointer" }}
            />
            <Line
              type="monotone"
              dataKey="retweets"
              stroke="oklch(0.65 0.12 160)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, fill: "oklch(0.65 0.12 160)" }}
              style={{ cursor: "pointer" }}
            />
            <Line
              type="monotone"
              dataKey="replies"
              stroke="oklch(0.7 0.12 60)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, fill: "oklch(0.7 0.12 60)" }}
              style={{ cursor: "pointer" }}
            />
            {refAreaLeft && refAreaRight && (
              <ReferenceArea
                x1={refAreaLeft}
                x2={refAreaRight}
                strokeOpacity={0.3}
                fill="oklch(0.7 0.15 220)"
                fillOpacity={0.2}
              />
            )}
          </ComposedChart>
        )}
      </ResponsiveContainer>
      </div>
      {viewMode === "perPost" && perPostScroll.max > 0 && (
        <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
          <button type="button" onClick={() => movePerPost(-1)} disabled={perPostScroll.left <= 1} className="rounded px-1.5 py-0.5 hover:bg-secondary hover:text-foreground disabled:opacity-30">← 前へ</button>
          <input
            aria-label="投稿グラフの表示位置"
            type="range"
            min={0}
            max={Math.max(1, Math.round(perPostScroll.max))}
            value={Math.min(Math.round(perPostScroll.left), Math.round(perPostScroll.max))}
            onChange={(event) => {
              const element = perPostScrollRef.current
              if (element) element.scrollLeft = Number(event.target.value)
            }}
            className="h-4 min-w-0 flex-1 cursor-ew-resize accent-[oklch(0.7_0.15_220)]"
          />
          <button type="button" onClick={() => movePerPost(1)} disabled={perPostScroll.left >= perPostScroll.max - 1} className="rounded px-1.5 py-0.5 hover:bg-secondary hover:text-foreground disabled:opacity-30">次へ →</button>
        </div>
      )}
    </div>
  )
}
