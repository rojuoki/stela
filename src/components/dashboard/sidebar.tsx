"use client"

import { AccountCard } from "./account-card"
import { MediaGrid } from "./media-grid"
import { TopPosts } from "./top-posts"
import { StatsSummary } from "./stats-summary"

interface SidebarProps {
  account: {
    avatar: string
    displayName: string
    username: string
    bio: string
    followers: number
    following: number
    posts: number
    joinedDate: string
  }
  media: Array<{
    id: string
    type: "image" | "video"
    thumbnail: string
    postDate: string
    postId?: string
  }>
  topPosts: Array<{
    id: string
    text: string
    likes: number
    retweets: number
    date: string
  }>
  stats: {
    totalPosts: number
    totalLikes: number
    totalRetweets: number
    avgEngagement: number
    postsPerDay: number
    peakHour: string
  }
  onJumpToPost?: (postId: string) => void
}

export function Sidebar({ account, media, topPosts, stats, onJumpToPost }: SidebarProps) {
  return (
    <div className="w-[300px] border-l border-border bg-card/30 overflow-y-auto shrink-0">
      <AccountCard account={account} />
      <MediaGrid media={media} onJumpToPost={onJumpToPost} />
      <TopPosts posts={topPosts} onJumpToPost={onJumpToPost} />
      <StatsSummary stats={stats} />
    </div>
  )
}
