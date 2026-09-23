export interface MediaVariant {
  url: string
  bitrate?: number
  contentType?: string
}

export interface MediaAttachment {
  id: string
  type: "image" | "video" | "gif"
  thumbnail: string
  url?: string
  variants?: MediaVariant[]
  postDate: string
  postId?: string
}

export function bestVideoUrl(media: MediaAttachment): string | null {
  if (media.url) return media.url
  const variants = (media.variants || [])
    .filter((variant) => variant.url && (!variant.contentType || variant.contentType.includes("mp4")))
    .sort((left, right) => (right.bitrate || 0) - (left.bitrate || 0))
  return variants[0]?.url || null
}
