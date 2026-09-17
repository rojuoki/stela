"use client"

import { useMemo, useState, useCallback } from "react"
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
  posts: number
  engagement: number
  likes: number
  retweets: number
  replies?: number
}

interface EngagementChartProps {
  data: DataPoint[]
  onDateClick?: (date: string) => void
  onRangeSelect?: (startDate: string, endDate: string) => void
}

type ViewMode = "overview" | "perPost"

export function EngagementChart({ data, onDateClick, onRangeSelect }: EngagementChartProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("overview")
  const [refAreaLeft, setRefAreaLeft] = useState<string | null>(null)
  const [refAreaRight, setRefAreaRight] = useState<string | null>(null)
  const [isSelecting, setIsSelecting] = useState(false)

  const chartData = useMemo(() => {
    if (data.length === 0) return []

    // データポイント数に応じた最適なビニング戦略を決定
    const getOptimalBinning = (dataPoints: number): 'raw' | 'day' | 'week' | 'month' => {
      if (dataPoints <= 30) return 'raw'      // そのまま
      if (dataPoints <= 90) return 'day'      // 日単位
      if (dataPoints <= 365) return 'week'    // 週単位  
      return 'month'                           // 月単位
    }

    const binType = getOptimalBinning(data.length)

    // ビニング関数
    const aggregateData = (rawData: DataPoint[], binning: typeof binType) => {
      if (binning === 'raw') {
        return rawData.map((d) => ({
          ...d,
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
            posts: 0,
            engagement: 0,
            likes: 0,
            retweets: 0,
            replies: 0,
          })
        }
        
        const group = grouped.get(key)!
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

    return aggregateData(data, binType)
  }, [data])

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
      setRefAreaLeft(String(e.activeLabel))
      setIsSelecting(true)
    }
  }, [])

  const handleMouseMove = useCallback((e: MouseHandlerDataParam) => {
    if (isSelecting && e.activeLabel !== undefined) {
      setRefAreaRight(String(e.activeLabel))
    }
  }, [isSelecting])

  const handleMouseUp = useCallback(() => {
    if (refAreaLeft && refAreaRight && onRangeSelect) {
      const leftIndex = chartData.findIndex(d => d.dateLabel === refAreaLeft)
      const rightIndex = chartData.findIndex(d => d.dateLabel === refAreaRight)
      
      if (leftIndex !== -1 && rightIndex !== -1) {
        const startIdx = Math.min(leftIndex, rightIndex)
        const endIdx = Math.max(leftIndex, rightIndex)
        onRangeSelect(chartData[startIdx].date, chartData[endIdx].date)
      }
    }
    setRefAreaLeft(null)
    setRefAreaRight(null)
    setIsSelecting(false)
  }, [refAreaLeft, refAreaRight, chartData, onRangeSelect])

  const handleChartClick = useCallback((e: MouseHandlerDataParam) => {
    const index = Number(e.activeTooltipIndex)
    if (!isSelecting && Number.isInteger(index) && chartData[index] && onDateClick) {
      onDateClick(chartData[index].date)
    }
  }, [isSelecting, onDateClick, chartData])

  return (
    <div className="h-[260px] border-b border-border p-4">
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
                <span className="text-muted-foreground">Engagement</span>
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
        <div className="text-xs text-muted-foreground">
          Click to jump · Drag to select range
        </div>
      </div>

      <ResponsiveContainer width="100%" height={190}>
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
              dataKey="dateLabel"
              axisLine={false}
              tickLine={false}
              tick={{ fontSize: 10, fill: "oklch(0.6 0 0)" }}
              interval="preserveStartEnd"
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
                value: 'Engagement', 
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
              labelStyle={{ color: "oklch(0.95 0 0)", marginBottom: "4px" }}
              itemStyle={{ color: "oklch(0.6 0 0)" }}
              formatter={(value, name) => {
                const label = String(name) === "posts" ? "Posts" : "Engagement"
                return [Number(value ?? 0).toLocaleString(), label]
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
            data={chartData} 
            margin={{ top: 0, right: 0, left: -20, bottom: 0 }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onClick={handleChartClick}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.25 0 0)" vertical={false} />
            <XAxis
              dataKey="dateLabel"
              axisLine={false}
              tickLine={false}
              tick={{ fontSize: 10, fill: "oklch(0.6 0 0)" }}
              interval="preserveStartEnd"
            />
            <YAxis
              axisLine={false}
              tickLine={false}
              tick={{ fontSize: 10, fill: "oklch(0.6 0 0)" }}
              tickFormatter={(value) => (value >= 1000 ? `${(value / 1000).toFixed(0)}K` : value)}
              domain={(() => {
                if (chartData.length === 0) return [0, 'auto']
                const allValues = chartData.flatMap(d => [d.likes, d.retweets, d.replies || 0])
                const min = Math.min(...allValues)
                const max = Math.max(...allValues)
                const range = max - min
                if (range < max * 0.3) {
                  const padding = Math.max(range * 0.2, max * 0.1)
                  return [Math.max(0, min - padding), max + padding]
                }
                return [0, 'auto']
              })()}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "oklch(0.15 0 0)",
                border: "1px solid oklch(0.25 0 0)",
                borderRadius: "6px",
                fontSize: "12px",
              }}
              labelFormatter={(label) => {
                const point = chartData.find(d => d.dateLabel === label)
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
  )
}
