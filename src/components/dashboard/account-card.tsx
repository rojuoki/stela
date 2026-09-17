"use client"

import { useState } from "react"
import { ChevronDown, ChevronUp, Users, FileText, Calendar } from "lucide-react"

interface AccountInfo {
  avatar: string
  displayName: string
  username: string
  bio: string
  followers: number
  following: number
  posts: number
  joinedDate: string
}

interface AccountCardProps {
  account: AccountInfo
}

function formatNumber(num: number): string {
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`
  return num.toString()
}

export function AccountCard({ account }: AccountCardProps) {
  const [isCollapsed, setIsCollapsed] = useState(false)

  return (
    <div className="border-b border-border">
      <button
        onClick={() => setIsCollapsed(!isCollapsed)}
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-secondary/30 transition-colors"
      >
        <span className="text-sm font-medium text-foreground">Account</span>
        {isCollapsed ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronUp className="h-4 w-4 text-muted-foreground" />
        )}
      </button>

      {!isCollapsed && (
        <div className="px-4 pb-4">
          <div className="flex items-start gap-3 mb-3">
            <div className="w-12 h-12 rounded-full bg-secondary overflow-hidden shrink-0">
              <img
                src={account.avatar}
                alt={account.displayName}
                className="w-full h-full object-cover"
              />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-medium text-foreground truncate">
                {account.displayName}
              </h3>
              <p className="text-xs text-muted-foreground">@{account.username}</p>
            </div>
          </div>

          <p className="text-xs text-muted-foreground leading-relaxed mb-4 line-clamp-2">
            {account.bio}
          </p>

          <div className="grid grid-cols-3 gap-2">
            <div className="text-center p-2 rounded-md bg-secondary/30">
              <div className="flex items-center justify-center gap-1 mb-1">
                <Users className="h-3 w-3 text-muted-foreground" />
              </div>
              <div className="text-sm font-medium text-foreground">
                {formatNumber(account.followers)}
              </div>
              <div className="text-xs text-muted-foreground">Followers</div>
            </div>
            <div className="text-center p-2 rounded-md bg-secondary/30">
              <div className="flex items-center justify-center gap-1 mb-1">
                <FileText className="h-3 w-3 text-muted-foreground" />
              </div>
              <div className="text-sm font-medium text-foreground">
                {formatNumber(account.posts)}
              </div>
              <div className="text-xs text-muted-foreground">Posts</div>
            </div>
            <div className="text-center p-2 rounded-md bg-secondary/30">
              <div className="flex items-center justify-center gap-1 mb-1">
                <Calendar className="h-3 w-3 text-muted-foreground" />
              </div>
              <div className="text-sm font-medium text-foreground">
                {new Date(account.joinedDate).getFullYear()}
              </div>
              <div className="text-xs text-muted-foreground">Joined</div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
