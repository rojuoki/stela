"use client"

import { useState } from "react"
import Link from "next/link"

export interface ProfileBannerData {
  username: string
  display_name?: string | null
  avatar_url?: string | null
  description?: string | null
  created_at?: string | null
  protected?: boolean
  followers_count?: number
  following_count?: number
}

/** One account identity, shared by the locked and readable timeline states. */
export function ProfileBanner({ account, compact = false, searchHref = "/" }: {
  account: ProfileBannerData
  compact?: boolean
  searchHref?: string
}) {
  const [expanded, setExpanded] = useState(false)
  const [failedAvatar, setFailedAvatar] = useState<string | null>(null)
  const showDetails = !compact || expanded
  const joined = account.created_at ? new Date(account.created_at) : null
  return <header className={`shrink-0 border-b border-border bg-background px-5 md:px-8 ${compact ? "py-4" : "py-7 md:py-10"}`}>
    {!compact && <Link href={searchHref} className="mb-6 inline-block text-sm text-muted-foreground hover:text-foreground">← 別のアカウントを検索</Link>}
    <div className="flex items-start gap-4 md:gap-5">
      <div className={`relative grid shrink-0 place-items-center overflow-hidden rounded-full bg-secondary text-muted-foreground ${compact ? "h-12 w-12 text-xl" : "h-20 w-20 text-3xl"}`}>
        <span aria-hidden="true">{account.username.slice(0, 1).toUpperCase()}</span>
        {account.avatar_url && failedAvatar !== account.avatar_url && <img src={account.avatar_url} alt="" className="absolute inset-0 h-full w-full object-cover" onError={() => setFailedAvatar(account.avatar_url || null)} />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1"><h1 className={`break-words font-semibold ${compact ? "text-lg" : "text-2xl md:text-3xl"}`}>{account.display_name || account.username}</h1>{account.protected && <span className="text-xs text-amber-300">非公開アカウント</span>}</div>
        <p className="mt-1 break-all text-sm text-muted-foreground">@{account.username}</p>
        {showDetails && <div className="mt-4 max-w-3xl space-y-3">
          {account.description && <p className="whitespace-pre-line text-sm leading-6 text-foreground/80">{account.description}</p>}
          <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
            {typeof account.followers_count === "number" && <span><strong className="font-medium text-foreground">{account.followers_count.toLocaleString()}</strong> フォロワー</span>}
            {typeof account.following_count === "number" && <span><strong className="font-medium text-foreground">{account.following_count.toLocaleString()}</strong> フォロー中</span>}
            {joined && !Number.isNaN(joined.getTime()) && <span>{joined.toLocaleDateString("ja-JP", { year: "numeric", month: "long" })}から利用</span>}
          </div>
          {account.protected && <p className="text-sm text-amber-300">非公開のため、投稿をUnlockできません。</p>}
        </div>}
      </div>
      {compact && <button onClick={() => setExpanded(!expanded)} aria-expanded={expanded} className="shrink-0 py-1 text-xs text-muted-foreground hover:text-foreground">{expanded ? "閉じる" : "プロフィール"}</button>}
    </div>
  </header>
}

export function LockedTimeline({ unavailable = false }: { unavailable?: boolean }) {
  return <section aria-label="投稿の表示エリア" className="flex min-h-[360px] flex-col items-center justify-center border-t border-border px-6 py-16 text-center">
    <p className="text-xs tracking-[.16em] text-muted-foreground">TIMELINE</p>
    <h2 className="mt-4 text-lg font-medium">{unavailable ? "投稿を表示できません" : "最初の投稿から、ここに。"}</h2>
    <p className="mt-3 max-w-md text-sm leading-7 text-muted-foreground">{unavailable ? "別の公開アカウントを検索してください。" : "Unlockすると、古い順の投稿と期間ごとのグラフが表示されます。"}</p>
  </section>
}
