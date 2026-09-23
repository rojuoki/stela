"use client"

import { useState } from "react"
import { ChevronDown, ChevronUp, BarChart3 } from "lucide-react"

interface Stats {
  totalPosts: number
  totalLikes: number
  totalRetweets: number
  avgEngagement: number
  postsPerDay: number
  peakHour: string
}

interface StatsSummaryProps {
  stats: Stats
}

function formatNumber(num: number): string {
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`
  return num.toString()
}

export function StatsSummary({ stats }: StatsSummaryProps) {
  const [isCollapsed, setIsCollapsed] = useState(false)

  return (
    <div className="border-b border-border">
      <button
        onClick={() => setIsCollapsed(!isCollapsed)}
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-secondary/30 transition-colors"
      >
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-chart-1" />
          <span className="text-sm font-medium text-foreground">Stats Summary</span>
        </div>
        {isCollapsed ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronUp className="h-4 w-4 text-muted-foreground" />
        )}
      </button>

      {!isCollapsed && (
        <div className="px-4 pb-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between py-1.5">
              <span className="text-xs text-muted-foreground">Total Posts</span>
              <span className="text-sm font-medium text-foreground">
                {formatNumber(stats.totalPosts)}
              </span>
            </div>
            <div className="flex items-center justify-between py-1.5">
              <span className="text-xs text-muted-foreground">Total Likes</span>
              <span className="text-sm font-medium text-foreground">
                {formatNumber(stats.totalLikes)}
              </span>
            </div>
            <div className="flex items-center justify-between py-1.5">
              <span className="text-xs text-muted-foreground">Total Retweets</span>
              <span className="text-sm font-medium text-foreground">
                {formatNumber(stats.totalRetweets)}
              </span>
            </div>
            <div className="h-px bg-border my-2" />
            <div className="flex items-center justify-between py-1.5">
              <span className="text-xs text-muted-foreground">Avg. reactions/post</span>
              <span className="text-sm font-medium text-chart-2">
                {stats.avgEngagement.toFixed(1)}
              </span>
            </div>
            <div className="flex items-center justify-between py-1.5">
              <span className="text-xs text-muted-foreground">Posts/Day</span>
              <span className="text-sm font-medium text-foreground">
                {stats.postsPerDay.toFixed(1)}
              </span>
            </div>
            <div className="flex items-center justify-between py-1.5">
              <span className="text-xs text-muted-foreground">Peak Hour</span>
              <span className="text-sm font-medium text-foreground">{stats.peakHour}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
