"use client"

import { useState, useEffect, useCallback } from "react"
import { ChevronDown, ChevronUp, Play, X, ChevronLeft, ChevronRight, ExternalLink } from "lucide-react"
import type { MediaAttachment } from "./media-types"
import { bestVideoUrl } from "./media-types"

interface MediaGridProps {
  media: MediaAttachment[]
  onJumpToPost?: (postId: string) => void
}

export function MediaGrid({ media, onJumpToPost }: MediaGridProps) {
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [query, setQuery] = useState("")
  const visibleMedia = media.filter((item) => !query.trim() || `${item.postDate} ${item.type}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const displayMedia = (showAll || query.trim() ? visibleMedia : visibleMedia.slice(0, 9))

  const openLightbox = (index: number) => {
    setLightboxIndex(index)
  }

  const closeLightbox = useCallback(() => {
    setLightboxIndex(null)
  }, [])

  const goToPrevious = useCallback(() => {
    if (lightboxIndex !== null) {
      setLightboxIndex(lightboxIndex === 0 ? visibleMedia.length - 1 : lightboxIndex - 1)
    }
  }, [lightboxIndex, visibleMedia.length])

  const goToNext = useCallback(() => {
    if (lightboxIndex !== null) {
      setLightboxIndex(lightboxIndex === visibleMedia.length - 1 ? 0 : lightboxIndex + 1)
    }
  }, [lightboxIndex, visibleMedia.length])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (lightboxIndex === null) return
      
      if (e.key === "Escape") {
        closeLightbox()
      } else if (e.key === "ArrowLeft") {
        goToPrevious()
      } else if (e.key === "ArrowRight") {
        goToNext()
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [lightboxIndex, closeLightbox, goToPrevious, goToNext])

  const currentMedia = lightboxIndex !== null ? visibleMedia[lightboxIndex] : null

  return (
    <>
      <div className="border-b border-border">
        <button
          onClick={() => setIsCollapsed(!isCollapsed)}
          className="w-full px-4 py-3 flex items-center justify-between hover:bg-secondary/30 transition-colors"
        >
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground">Media</span>
            <span className="text-xs text-muted-foreground">{media.length}</span>
          </div>
          {isCollapsed ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronUp className="h-4 w-4 text-muted-foreground" />
          )}
        </button>

        {!isCollapsed && (
          <div className="px-4 pb-4">
            {media.length > 6 && <input aria-label="メディアを検索" value={query} onChange={(event) => { setQuery(event.target.value); setLightboxIndex(null) }} placeholder="日付・種類で絞り込み" className="mb-3 w-full rounded-md border border-border bg-secondary px-2.5 py-1.5 text-xs" />}
            <div className="grid grid-cols-3 gap-1.5">
              {displayMedia.map((item, index) => (
                <div
                  key={item.id}
                  onClick={() => openLightbox(index)}
                  className="aspect-square rounded-md overflow-hidden bg-secondary relative group cursor-pointer"
                >
                  <img src={item.thumbnail} alt="" className="h-full w-full object-cover transition-transform group-hover:scale-105" loading="lazy" />
                  {item.type === "video" && (
                    <div className="absolute inset-0 flex items-center justify-center bg-background/30">
                      <div className="w-8 h-8 rounded-full bg-background/80 flex items-center justify-center">
                        <Play className="h-4 w-4 text-foreground fill-foreground" />
                      </div>
                    </div>
                  )}
                  <div className="absolute inset-0 bg-background/0 group-hover:bg-background/20 transition-colors" />
                </div>
              ))}
            </div>
            {visibleMedia.length > 9 && !query.trim() && (
              <button onClick={() => setShowAll(!showAll)} className="mt-2 w-full py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
                {showAll ? "Show fewer media" : `View all ${visibleMedia.length} media`}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Lightbox Modal */}
      {lightboxIndex !== null && currentMedia && (
        <div 
          className="fixed inset-0 z-50 flex items-center justify-center"
          onClick={closeLightbox}
        >
          {/* Dark overlay */}
          <div className="absolute inset-0 bg-background/90 backdrop-blur-sm" />
          
          {/* Content */}
          <div 
            className="relative z-10 max-w-4xl max-h-[90vh] flex flex-col items-center"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Close button */}
            <button
              onClick={closeLightbox}
              className="absolute -top-10 right-0 p-2 text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="h-5 w-5" />
            </button>

            {/* Navigation - Previous */}
            <button
              onClick={goToPrevious}
              className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-12 p-2 text-muted-foreground hover:text-foreground transition-colors"
            >
              <ChevronLeft className="h-6 w-6" />
            </button>

            {currentMedia.type === "image" ? <img src={currentMedia.thumbnail} alt="" className="max-h-[80vh] max-w-full rounded-lg object-contain" /> : (
              <video controls autoPlay preload="metadata" poster={currentMedia.thumbnail} src={bestVideoUrl(currentMedia) || undefined} className="max-h-[80vh] max-w-full rounded-lg bg-black" />
            )}

            {/* Navigation - Next */}
            <button
              onClick={goToNext}
              className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-12 p-2 text-muted-foreground hover:text-foreground transition-colors"
            >
              <ChevronRight className="h-6 w-6" />
            </button>

            {/* Footer with post link */}
            <div className="mt-4 flex items-center gap-4 text-sm">
              <span className="text-muted-foreground">
                {lightboxIndex + 1} of {media.length}
              </span>
              <span className="text-muted-foreground">·</span>
              <span className="text-muted-foreground">{currentMedia.postDate}</span>
              {currentMedia.postId && onJumpToPost && (
                <>
                  <span className="text-muted-foreground">·</span>
                  <button
                    onClick={() => {
                      onJumpToPost(currentMedia.postId!)
                      closeLightbox()
                    }}
                    className="flex items-center gap-1 text-chart-1 hover:text-chart-1/80 transition-colors"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    View post
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
