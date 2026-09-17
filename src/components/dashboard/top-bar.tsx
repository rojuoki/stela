"use client"

import { useState } from "react"
import { Search, Download, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

interface TopBarProps {
  status: string
  postRange: string
  lastUpdated: string
  dateRange: string
  selectedRange?: string | null
  keyword?: string
  onKeywordChange?: (value: string) => void
  onExport?: () => void
  onExtend?: () => void
  extendLabel?: string
  extendDisabled?: boolean
  provider?: string
  providerOptions?: readonly { value: string; label: string }[]
  onProviderChange?: (value: string) => void
}

export function TopBar({
  status,
  postRange,
  lastUpdated,
  dateRange,
  selectedRange,
  keyword: controlledKeyword,
  onKeywordChange,
  onExport,
  onExtend,
  extendLabel = "Extend",
  extendDisabled = false,
  provider,
  providerOptions,
  onProviderChange,
}: TopBarProps) {
  const [localKeyword, setLocalKeyword] = useState("")
  const keyword = controlledKeyword ?? localKeyword
  const setKeyword = onKeywordChange ?? setLocalKeyword

  return (
    <div className="h-14 border-b border-border bg-card/50 backdrop-blur-sm px-4 flex items-center justify-between">
      <div className="flex items-center gap-6">
        <span className="text-sm text-muted-foreground" title={`Last updated: ${lastUpdated}`}>
          {postRange} · {selectedRange ? (
            <span className="text-chart-1">{selectedRange}</span>
          ) : (
            <span className="text-foreground">{dateRange}</span>
          )} · <span className="text-foreground">{status}</span>
        </span>
      </div>

      <div className="flex items-center gap-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Filter by keyword..."
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            className="h-8 w-44 pl-8 bg-secondary/50 border-border text-sm placeholder:text-muted-foreground"
          />
        </div>

        <div className="w-px h-5 bg-border" />

        {provider && providerOptions?.length && onProviderChange ? (
          <select
            value={provider}
            onChange={(event) => onProviderChange(event.target.value)}
            aria-label="Acquisition provider"
            className="h-8 rounded-md border border-border bg-secondary/50 px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          >
            {providerOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        ) : null}

        <Button onClick={onExport} disabled={!onExport} variant="ghost" size="sm" className="h-8 gap-1.5 text-muted-foreground hover:text-foreground">
          <Download className="h-4 w-4" />
          Export
        </Button>

        <Button onClick={onExtend} disabled={extendDisabled || !onExtend} size="sm" className="h-8 gap-1.5 bg-chart-1 hover:bg-chart-1/90 text-primary-foreground">
          <Plus className="h-4 w-4" />
          {extendLabel}
        </Button>
      </div>
    </div>
  )
}
