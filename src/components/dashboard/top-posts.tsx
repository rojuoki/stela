"use client"

import { useState } from "react"
import { ChevronDown, ChevronUp, TrendingUp, Heart, Repeat2 } from "lucide-react"

interface TopPost {
  id: string
  text: string
  likes: number
  retweets: number
  date: string
}

interface TopPostsProps {
  posts: TopPost[]
  onJumpToPost?: (postId: string) => void
}

function formatNumber(num: number): string {
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`
  return num.toString()
}

export function TopPosts({ posts, onJumpToPost }: TopPostsProps) {
  const [isCollapsed, setIsCollapsed] = useState(false)
  const displayPosts = posts.slice(0, 5)

  return (
    <div className="border-b border-border">
      <button
        onClick={() => setIsCollapsed(!isCollapsed)}
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-secondary/30 transition-colors"
      >
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-chart-2" />
          <span className="text-sm font-medium text-foreground">Top Posts</span>
        </div>
        {isCollapsed ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronUp className="h-4 w-4 text-muted-foreground" />
        )}
      </button>

      {!isCollapsed && (
        <div className="px-4 pb-4 space-y-3">
          {displayPosts.map((post, index) => (
            <div
              key={post.id}
              onClick={() => onJumpToPost?.(post.id)}
              className="p-2.5 rounded-md bg-secondary/20 hover:bg-secondary/40 transition-colors cursor-pointer"
            >
              <div className="flex items-start gap-2">
                <span className="text-xs font-medium text-muted-foreground w-4 shrink-0">
                  #{index + 1}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-foreground line-clamp-2 leading-relaxed mb-2">
                    {post.text}
                  </p>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <div className="flex items-center gap-1">
                      <Heart className="h-3 w-3" />
                      <span>{formatNumber(post.likes)}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Repeat2 className="h-3 w-3" />
                      <span>{formatNumber(post.retweets)}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
