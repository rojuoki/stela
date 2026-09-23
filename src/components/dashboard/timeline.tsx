"use client"

import { useEffect, useRef, forwardRef, useImperativeHandle } from "react"
import { Heart, Repeat2 } from "lucide-react"
import type { MediaAttachment } from "./media-types"

interface Post {
  id: string
  date: string
  text: string
  likes: number
  retweets: number
  hasMedia?: boolean
  media?: MediaAttachment[]
  url?: string | null
}

interface TimelineProps {
  posts: Post[]
  highlightedDate?: string | null
  highlightedPostId?: string | null
  onVisiblePostChange?: (postId: string) => void
}

export interface TimelineHandle {
  scrollToDate: (date: string) => void
  scrollToPost: (postId: string) => void
}

function formatNumber(num: number): string {
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`
  return num.toString()
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr)
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })
}

function formatTime(dateStr: string): string {
  const date = new Date(dateStr)
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
}

function isSameDay(date1: string, date2: string): boolean {
  const d1 = new Date(date1)
  const d2 = new Date(date2)
  return d1.toDateString() === d2.toDateString()
}

function linkedText(text: string) {
  return text.split(/(@[A-Za-z0-9_]{1,15})/g).map((part, index) => {
    const match = /^@([A-Za-z0-9_]{1,15})$/.exec(part)
    if (!match) return <span key={`${index}-${part}`}>{part}</span>
    return (
      <a
        key={`${index}-${part}`}
        href={`/io/${match[1]}`}
        onClick={(event) => event.stopPropagation()}
        className="text-chart-1 hover:underline"
      >
        {part}
      </a>
    )
  })
}

export const Timeline = forwardRef<TimelineHandle, TimelineProps>(function Timeline(
  { posts, highlightedDate, highlightedPostId, onVisiblePostChange },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const postRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  useImperativeHandle(ref, () => ({
    scrollToDate: (date: string) => {
      const post = posts.find((p) => isSameDay(p.date, date))
      if (post) {
        const element = postRefs.current.get(post.id)
        if (element) {
          element.scrollIntoView({ behavior: "smooth", block: "center" })
        }
      }
    },
    scrollToPost: (postId: string) => {
      const element = postRefs.current.get(postId)
      if (element) {
        element.scrollIntoView({ behavior: "smooth", block: "center" })
      }
    },
  }))

  useEffect(() => {
    if (highlightedDate) {
      const post = posts.find((p) => isSameDay(p.date, highlightedDate))
      if (post) {
        const element = postRefs.current.get(post.id)
        if (element) {
          element.scrollIntoView({ behavior: "smooth", block: "center" })
        }
      }
    }
  }, [highlightedDate, posts])

  useEffect(() => {
    if (!highlightedPostId) return
    const element = postRefs.current.get(highlightedPostId)
    element?.scrollIntoView({ behavior: "smooth", block: "center" })
  }, [highlightedPostId])

  useEffect(() => {
    if (!onVisiblePostChange) return
    const elements = [...postRefs.current.values()]
    if (!elements.length) return

    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => Math.abs(a.boundingClientRect.top - window.innerHeight * 0.28) - Math.abs(b.boundingClientRect.top - window.innerHeight * 0.28))[0]
      const postId = visible?.target.getAttribute("data-post-id")
      if (postId) onVisiblePostChange(postId)
    }, { rootMargin: "-18% 0px -62% 0px", threshold: [0, 0.25, 0.5, 0.75, 1] })

    elements.forEach((element) => observer.observe(element))
    return () => observer.disconnect()
  }, [posts, onVisiblePostChange])

  return (
    <div ref={containerRef} className="flex-1 overflow-y-auto">
      <div className="px-4 py-3 border-b border-border sticky top-0 bg-card/80 backdrop-blur-sm z-10">
        <span className="text-sm font-medium text-foreground">Timeline</span>
        <span className="text-xs text-muted-foreground ml-2">{posts.length} posts</span>
      </div>

      <div className="divide-y divide-border">
        {posts.map((post) => {
          const isHighlighted = post.id === highlightedPostId || Boolean(highlightedDate && isSameDay(post.date, highlightedDate))
          
          return (
            <div
              key={post.id}
              data-post-id={post.id}
              ref={(el) => {
                if (el) postRefs.current.set(post.id, el)
              }}
              className={`px-4 py-3 transition-colors cursor-pointer group ${
                isHighlighted
                  ? "bg-chart-1/10 border-l-2 border-l-chart-1"
                  : "hover:bg-secondary/30"
              }`}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-xs text-muted-foreground">
                      {formatDate(post.date)}
                    </span>
                    <span className="text-xs text-muted-foreground/50">·</span>
                    <span className="text-xs text-muted-foreground/70">
                      {formatTime(post.date)}
                    </span>
                    {post.hasMedia && (
                      <>
                        <span className="text-xs text-muted-foreground/50">·</span>
                        <span className="text-xs text-chart-1">Media</span>
                      </>
                    )}
                  </div>
                  <p className="text-sm text-foreground leading-relaxed line-clamp-3">
                    {linkedText(post.text)}
                  </p>
                  {post.media && post.media.length > 0 && (
                    <div className={`mt-3 grid gap-1.5 overflow-hidden rounded-xl ${post.media.length === 1 ? "max-w-xl grid-cols-1" : "grid-cols-2"}`}>
                      {post.media.map((media) => {
                        const videoUrl = media.type === "image" ? null : media.url || media.variants?.[0]?.url
                        return videoUrl ? (
                          <video key={media.id} controls preload="metadata" poster={media.thumbnail} className="max-h-80 w-full rounded-lg bg-black object-contain" src={videoUrl} />
                        ) : (
                          <img key={media.id} src={media.thumbnail} alt="投稿のメディア" loading="lazy" className="max-h-80 w-full rounded-lg bg-secondary object-cover" />
                        )
                      })}
                    </div>
                  )}
                  {post.url && (
                    <a
                      href={post.url}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1.5 inline-block text-[11px] text-muted-foreground hover:text-chart-1"
                    >
                      Open on X
                    </a>
                  )}
                </div>

                <div className="flex items-center gap-4 text-xs text-muted-foreground shrink-0">
                  <div className="flex items-center gap-1.5 group-hover:text-chart-3 transition-colors">
                    <Heart className="h-3.5 w-3.5" />
                    <span>{formatNumber(post.likes)}</span>
                  </div>
                  <div className="flex items-center gap-1.5 group-hover:text-chart-2 transition-colors">
                    <Repeat2 className="h-3.5 w-3.5" />
                    <span>{formatNumber(post.retweets)}</span>
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
})
