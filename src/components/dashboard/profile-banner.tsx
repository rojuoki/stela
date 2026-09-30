"use client"

import { useState } from "react"
import Link from "next/link"
import type { ReactNode } from "react"

export interface ProfileBannerData {
  username: string
  display_name?: string | null
  avatar_url?: string | null
  description?: string | null
  created_at?: string | null
  protected?: boolean
  followers_count?: number
  following_count?: number
  statuses_count?: number
}

/** One account identity, shared by the locked and readable timeline states. */
export function ProfileBanner({ account, compact = false, searchHref = "/", actions }: {
  account: ProfileBannerData
  compact?: boolean
  searchHref?: string
  actions?: ReactNode
}) {
  const [expanded, setExpanded] = useState(false)
  const [failedAvatar, setFailedAvatar] = useState<string | null>(null)
  const showDetails = !compact || expanded
  const joined = account.created_at ? new Date(account.created_at) : null
  return <header className={`shrink-0 border-b border-border bg-background px-5 md:px-8 ${compact ? "py-4" : "py-7 md:py-10"}`}>
    {!compact && <Link href={searchHref} className="mb-6 inline-block text-sm text-muted-foreground hover:text-foreground">← Search another account</Link>}
    <div className="flex items-start gap-4 md:gap-5">
      <div className={`relative grid shrink-0 place-items-center overflow-hidden rounded-full bg-secondary text-muted-foreground ${compact ? "h-12 w-12 text-xl" : "h-20 w-20 text-3xl"}`}>
        <span aria-hidden="true">{account.username.slice(0, 1).toUpperCase()}</span>
        {account.avatar_url && failedAvatar !== account.avatar_url && <img src={account.avatar_url} alt="" className="absolute inset-0 h-full w-full object-cover" onError={() => setFailedAvatar(account.avatar_url || null)} />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-start justify-between gap-x-5 gap-y-3">
          <div className="min-w-0"><div className="flex flex-wrap items-center gap-x-3 gap-y-1"><h1 className={`break-words font-semibold ${compact ? "text-lg" : "text-2xl md:text-3xl"}`}>{account.display_name || account.username}</h1>{account.protected && <span className="text-xs text-amber-300">Private account</span>}</div><p className="mt-1 break-all text-sm text-muted-foreground">@{account.username}</p></div>
          {actions && <div className="shrink-0">{actions}</div>}
        </div>
        {showDetails && <div className="mt-4 max-w-3xl space-y-3">
          {account.description && <p className="whitespace-pre-line text-sm leading-6 text-foreground/80">{account.description}</p>}
          <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
            {typeof account.followers_count === "number" && <span><strong className="font-medium text-foreground">{account.followers_count.toLocaleString("en-US")}</strong> followers</span>}
            {typeof account.following_count === "number" && <span><strong className="font-medium text-foreground">{account.following_count.toLocaleString("en-US")}</strong> following</span>}
            {joined && !Number.isNaN(joined.getTime()) && <span>Joined {joined.toLocaleDateString("en-US", { year: "numeric", month: "long" })}</span>}
          </div>
          {account.protected && <p className="text-sm text-amber-300">Posts from private accounts cannot be unlocked.</p>}
        </div>}
      </div>
      {compact && <button onClick={() => setExpanded(!expanded)} aria-expanded={expanded} className="shrink-0 py-1 text-xs text-muted-foreground hover:text-foreground">{expanded ? "Close" : "Profile"}</button>}
    </div>
  </header>
}

export function LockedTimeline({ unavailable = false }: { unavailable?: boolean }) {
  return <section aria-label="Post display area" className="flex min-h-[360px] flex-col items-center justify-center border-t border-border px-6 py-16 text-center">
    <p className="text-xs tracking-[.16em] text-muted-foreground">TIMELINE</p>
    <h2 className="mt-4 text-lg font-medium">{unavailable ? "Posts unavailable" : "Start from the earliest post."}</h2>
    <p className="mt-3 max-w-md text-sm leading-7 text-muted-foreground">{unavailable ? "Search for another public account." : "Unlock to view posts in chronological order and explore activity over time."}</p>
  </section>
}
