"use client"

import { useState, useEffect, useCallback } from "react"
import { ChevronDown, ChevronUp, Play, X, ChevronLeft, ChevronRight, ExternalLink } from "lucide-react"

interface MediaItem {
  id: string
  type: "image" | "video"
  thumbnail: string
  postDate: string
  postId?: string
}

interface MediaGridProps {
  media: MediaItem[]
  onJumpToPost?: (postId: string) => void
}

export function MediaGrid({ media, onJumpToPost }: MediaGridProps) {
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const displayMedia = media.slice(0, 9)

  const openLightbox = (index: number) => {
    setLightboxIndex(index)
  }

  const closeLightbox = useCallback(() => {
    setLightboxIndex(null)
  }, [])

  const goToPrevious = useCallback(() => {
    if (lightboxIndex !== null) {
      setLightboxIndex(lightboxIndex === 0 ? media.length - 1 : lightboxIndex - 1)
    }
  }, [lightboxIndex, media.length])

  const goToNext = useCallback(() => {
    if (lightboxIndex !== null) {
      setLightboxIndex(lightboxIndex === media.length - 1 ? 0 : lightboxIndex + 1)
    }
  }, [lightboxIndex, media.length])

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

  const currentMedia = lightboxIndex !== null ? media[lightboxIndex] : null

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
            <div className="grid grid-cols-3 gap-1.5">
              {displayMedia.map((item, index) => (
                <div
                  key={item.id}
                  onClick={() => openLightbox(index)}
                  className="aspect-square rounded-md overflow-hidden bg-secondary relative group cursor-pointer"
                >
                  <img
                    src={item.thumbnail}
                    alt=""
                    className="w-full h-full object-cover transition-transform group-hover:scale-105"
                  />
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
            {media.length > 9 && (
              <button className="w-full mt-2 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
                View all {media.length} media
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

            {/* Image */}
            <img
              src={currentMedia.thumbnail.replace("w=200&h=200", "w=800&h=800")}
              alt=""
              className="max-w-full max-h-[80vh] rounded-lg object-contain"
            />

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
