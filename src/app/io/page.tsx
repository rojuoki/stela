"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"

export default function IoHomePage() {
  const router = useRouter()
  const [username, setUsername] = useState("jack")
  const [error, setError] = useState("")

  function openAccount() {
    const normalized = username.trim().replace(/^@/, "")
    if (!/^[A-Za-z0-9_]{1,15}$/.test(normalized)) {
      setError("Xのユーザー名を入力してください")
      return
    }
    router.push(`/io/${normalized}`)
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-12">
      <main>
        <div className="mb-8">
          <h1 className="text-4xl font-bold mb-2 tracking-tight">STELA</h1>
          <p className="text-zinc-400 text-lg font-medium">Deep historical insights for X accounts</p>
          <p className="text-zinc-500 text-sm mt-2">Multi-provider acquisition + local SQLite prototype</p>
          <Link href="/io/unlock" className="inline-block mt-4 text-sm text-sky-300 hover:text-sky-200 underline underline-offset-4">
            製品版：+1000 と期間指定採掘へ
          </Link>
        </div>

        <div className="flex gap-2 mb-10 max-w-lg mx-auto px-2">
          <div className="relative flex-1">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500">@</span>
            <input
              type="text"
              name="stela-io-username-search"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              value={username.replace(/^@/, "")}
              onChange={(event) => { setUsername(event.target.value.replace(/^@/, "")); setError("") }}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); openAccount() } }}
              placeholder="username"
              aria-label="X username"
              className="w-full bg-zinc-900 border border-zinc-700 rounded-lg pl-8 pr-3 py-2 text-sm focus:outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500"
            />
          </div>
          <button
            onClick={openAccount}
            disabled={!username.trim()}
            className="bg-white text-black font-semibold text-sm px-5 py-2 rounded-lg hover:bg-zinc-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Search
          </button>
        </div>

        <div className="mb-8 px-8">
          <div className="flex items-center gap-2 text-xs mb-2">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 bg-amber-400" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-400" />
            </span>
            <span className="text-amber-400 font-medium">Standby</span>
          </div>
          <div className="text-xs text-amber-300/70">Awaiting excavation input</div>
          {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
        </div>

        <div className="flex min-h-[22rem] items-center justify-center rounded-xl border border-zinc-800 bg-blue-950/30 p-8">
          <p className="max-w-md text-center text-sm leading-relaxed text-zinc-600">
            Timeline will appear here, starting from the earliest post. Opening saved data does not consume API credits.
          </p>
        </div>
      </main>
    </div>
  )
}
