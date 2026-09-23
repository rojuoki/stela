"use client"

import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import { useEffect, useRef, useState } from "react"
import { TopBar } from "@/components/dashboard/top-bar"
import { EngagementChart } from "@/components/dashboard/engagement-chart"
import { Timeline, type TimelineHandle } from "@/components/dashboard/timeline"
import { Sidebar } from "@/components/dashboard/sidebar"

const primary = "inline-flex items-center justify-center rounded-lg bg-white px-5 py-3 text-sm font-medium text-black hover:bg-zinc-200 disabled:opacity-40"
const secondary = "inline-flex items-center justify-center rounded-lg border border-zinc-700 px-4 py-2 text-sm hover:bg-zinc-800"
const storageKey = "stela-ux-draft-v1"
const samples = ["小さなアイデアから、最初の一歩。", "今日は新しいプロジェクトのことを考えていた。", "試して、直して、また試す。少しずつ形になってきた。", "散歩の途中で思いついたことをメモ。", "最初に作ったものを見返すと、原点がよくわかる。", "ひとつ公開できた。次はもっとシンプルにしたい。"]
const posts = Array.from({ length: 30 }, (_, i) => ({ id: `demo-${i}`, date: new Date(Date.UTC(2009, 2, i + 1, 9)).toISOString(), text: samples[i % samples.length], likes: (i * 37) % 180, retweets: (i * 7) % 25 }))
const chart = posts.map(p => ({ date: p.date, posts: 1, likes: p.likes, retweets: p.retweets, replies: 0, engagement: p.likes + p.retweets }))
const avatar = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="#303036"/><text x="48" y="60" text-anchor="middle" font-family="sans-serif" font-size="34" fill="white">S</text></svg>')

export default function UxDraft() {
  const params = useParams<{ screen?: string[] }>()
  const router = useRouter()
  const [view = "home", rawName = "stela_demo"] = params.screen || []
  const username = /^[A-Za-z0-9_]{1,15}$/.test(rawName) ? rawName : "stela_demo"
  const [signedIn, setSignedIn] = useState(false)
  const [saved, setSaved] = useState<string[]>([])
  const [input, setInput] = useState("")
  const [notice, setNotice] = useState("")
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    try {
      const data = JSON.parse(localStorage.getItem(storageKey) || "{}")
      // Restore browser-only draft state after hydration.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSignedIn(data.signedIn === true)
      setSaved(Array.isArray(data.saved) ? data.saved.filter((v: unknown) => typeof v === "string" && /^[a-z0-9_]{1,15}$/.test(v)) : [])
    } catch { /* A fresh draft also works without browser storage. */ }
    setLoaded(true)
  }, [])
  function persist(auth: boolean, names: string[]) {
    setSignedIn(auth)
    setSaved(names)
    try { localStorage.setItem(storageKey, JSON.stringify({ signedIn: auth, saved: names })) } catch { /* Keep the current session usable. */ }
  }
  function go(path: string) { setNotice(""); router.push(`/ux${path}`) }
  const clean = input.trim().replace(/^@/, "").toLowerCase()
  const valid = /^[a-z0-9_]{1,15}$/.test(clean)
  const target = `/account/${username}`
  const results = (names: string[]) => <div className="divide-y divide-zinc-800">{names.map(name => <Link key={name} href={`/ux/result/${name}`} className="flex items-center justify-between gap-4 py-5 hover:text-sky-300"><div><p className="font-medium">@{name}</p><p className="mt-1 text-xs text-zinc-500">30 posts · Mar 1–30, 2009 · サンプル</p></div><span className="text-sm">View →</span></Link>)}</div>
  return <div className="min-h-screen bg-background text-foreground">
    <div className="border-b border-zinc-800 px-5 py-2 text-center text-xs text-zinc-400">画面構成の試作 · データ・ログイン・Unlockはすべてダミーです</div>
    <header className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-800 px-5 py-4 md:px-10">
      <Link href="/ux" className="text-xl font-semibold tracking-[.18em]">STELA</Link>
      <nav aria-label="メインナビゲーション" className="flex items-center gap-5 text-sm">
        <Link href="/ux">検索</Link><Link href="/ux/my-results">My Results</Link>
        {signedIn ? <Link href="/ux/settings">アカウント</Link> : <button onClick={() => go("/signin")}>ログイン</button>}
      </nav>
    </header>
    {notice && <div role="status" className="flex items-center justify-between gap-3 border-b border-zinc-700 bg-zinc-900 px-5 py-3 text-sm"><span>{notice}</span><button aria-label="閉じる" onClick={() => setNotice("")}>×</button></div>}
    {!loaded ? <p className="p-10 text-zinc-400">読み込み中…</p> : view === "result" ? <Result key={username} username={username} notify={setNotice} /> : <main className="mx-auto max-w-3xl px-6 py-12 md:py-20">
      {view === "home" && <>
        <p className="mb-4 text-xs tracking-[.2em] text-zinc-500">EXPLORE THE BEGINNING</p>
        <h1 className="text-3xl font-medium leading-snug md:text-4xl">あのアカウントの、<br />はじまりをたどる。</h1>
        <p className="mt-5 text-sm leading-7 text-zinc-400">Xの過去の投稿を、古い順に。<br />気になるアカウントを見つけて、最初の言葉から読んでみよう。</p>
        <form className="mt-9 flex gap-3" onSubmit={e => { e.preventDefault(); if (valid) go(`/account/${clean}`) }}>
          <label className="sr-only" htmlFor="username">Xのユーザー名</label>
          <input id="username" value={input} onChange={e => setInput(e.target.value)} placeholder="@username" autoComplete="off" className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3 focus:outline-sky-400" />
          <button className={primary} disabled={!valid}>検索 →</button>
        </form>
        <p className="mt-3 text-xs text-zinc-500">公開アカウントのユーザー名を入力 · 検索ではUnlockしません</p>
        {input && !valid && <p role="status" className="mt-2 text-sm text-amber-300">英数字とアンダースコア、1〜15文字で入力してください。</p>}
        <button onClick={() => go("/result/stela_demo")} className="mt-7 text-sm text-zinc-300 underline underline-offset-4">サンプルの結果を見る</button>
        {signedIn && <section className="mt-16 border-t border-zinc-800 pt-7"><div className="flex justify-between"><h2>最近の結果</h2><Link href="/ux/my-results" className="text-sm text-zinc-400">すべて見る →</Link></div>{saved.length ? results(saved.slice(0, 3)) : <p className="mt-4 text-sm text-zinc-500">Unlockした結果が、ここから開けるようになります。</p>}</section>}
      </>}
      {view === "account" && <>
        <Link href="/ux" className="text-sm text-zinc-400">← 別のアカウントを検索</Link>
        <h1 className="mt-8 text-3xl font-medium">@{username}</h1>
        <p className="mt-3 text-sm text-zinc-400">公開アカウント · プロフィール情報は仮表示</p>
        <section className="my-8 rounded-xl border border-zinc-800 p-6"><h2 className="text-lg">最初の投稿から読む</h2><p className="mt-3 text-sm leading-7 text-zinc-400">古い順の投稿、期間ごとのグラフ、反応の多い投稿をまとめて閲覧できます。</p><div className="mt-5 flex justify-between border-t border-zinc-800 pt-5 text-sm"><span>Unlockの範囲・料金</span><span>仮設定：30件 / 1クレジット</span></div></section>
        {saved.includes(username) ? <button className={primary} onClick={() => go(`/result/${username}`)}>View — 保存済みの結果を開く</button> : <button className={primary} onClick={() => go(signedIn ? `/loading/${username}` : `/signin/${username}`)}>{signedIn ? "Unlock（デモ）" : "ログインして続ける"}</button>}
        <p className="mt-4 text-xs text-zinc-500">この試作では料金は発生しません。件数・料金は検討用です。</p>
      </>}
      {view === "signin" && <>
        <h1 className="text-3xl font-medium">続きを、自分の場所に。</h1><p className="mt-4 text-sm leading-7 text-zinc-400">ログインすると、Unlockした結果をMy Resultsから再び開けます。</p>
        {params.screen?.[1] && <p className="mt-7 border-l-2 border-zinc-600 pl-4 text-sm">検索した対象：@{username}<br /><span className="text-zinc-500">ログイン後、このアカウントに戻ります。</span></p>}
        <button className={`${primary} mt-8`} onClick={() => { persist(true, saved); go(params.screen?.[1] ? target : "") }}>デモアカウントで続ける</button><p className="mt-4 text-xs text-zinc-500">登録・ログイン方式は未接続です。個人情報の入力は不要です。</p>
      </>}
      {view === "loading" && <>
        <h1 className="text-3xl font-medium">@{username} の投稿を準備中</h1><p className="mt-5 text-sm leading-7 text-zinc-400">古い投稿から順に集めています。<br />本実装では、取得した件数と進み具合をここに表示します。</p>
        <div className="my-8 h-1 overflow-hidden rounded bg-zinc-800"><div className="h-full w-2/5 bg-sky-300" /></div>
        <p className="mb-6 text-xs text-zinc-500">状態確認用のダミー画面です。次のボタンで完了を再現します。</p>
        <div className="flex flex-wrap gap-3"><button className={primary} onClick={() => { persist(signedIn, [username, ...saved.filter(n => n !== username)]); go(`/result/${username}`) }}>完了して結果を見る</button><button className={secondary} onClick={() => go(`/failed/${username}`)}>失敗時の表示を見る</button></div>
      </>}
      {view === "failed" && <><h1 className="text-2xl">投稿を取得できませんでした</h1><p className="my-5 text-sm text-zinc-400">@{username} · クレジットは消費されていません。（デモ）</p><button className={primary} onClick={() => go(target)}>対象の確認に戻る</button></>}
      {view === "my-results" && <>
        <h1 className="text-3xl font-medium">My Results</h1><p className="mt-3 mb-8 text-sm text-zinc-400">以前の結果から、続きを読もう。</p>
        {!signedIn ? <button className={primary} onClick={() => { persist(true, saved); setNotice("デモアカウントでログインしました。") }}>デモログインして結果を見る</button> : saved.length ? results(saved) : <div className="border-y border-zinc-800 py-10"><p className="mb-5 text-zinc-400">まだ結果がありません。最初のアカウントを探してみましょう。</p><Link href="/ux" className={primary}>アカウントを検索</Link></div>}
      </>}
      {view === "settings" && <>
        <h1 className="text-3xl font-medium">アカウント</h1><p className="mt-4 text-zinc-400">{signedIn ? "Demo user" : "未ログイン"}</p>
        <div className="my-8 flex flex-wrap gap-3"><Link className={secondary} href="/ux/my-results">My Results →</Link><button className={secondary} onClick={() => setNotice("購入・支払い管理は未接続です。料金とクレジットの設計後に追加します。")}>クレジット・支払い</button></div>
        {signedIn && <button className={secondary} onClick={() => { persist(false, saved); go("") }}>ログアウト</button>}
      </>}
      {!["home", "account", "signin", "loading", "failed", "my-results", "settings"].includes(view) && <><h1>ページが見つかりません</h1><Link href="/ux" className={secondary}>ホームに戻る</Link></>}
    </main>}
  </div>
}

function Result({ username, notify }: { username: string; notify: (message: string) => void }) {
  const timeline = useRef<TimelineHandle>(null)
  const [keyword, setKeyword] = useState("")
  const [highlight, setHighlight] = useState<string | null>(null)
  const [range, setRange] = useState<{ start: string; end: string } | null>(null)
  const [details, setDetails] = useState(false)
  const filtered = posts.filter(p => p.text.includes(keyword) && (!range || (p.date >= range.start && p.date <= range.end)))
  const likes = posts.reduce((n, p) => n + p.likes, 0)
  const retweets = posts.reduce((n, p) => n + p.retweets, 0)
  return <section className="flex h-[calc(100dvh-108px)] min-h-[600px] flex-col">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 px-5 py-3 text-sm"><div><span className="font-medium">@{username}</span><span className="ml-3 text-xs text-zinc-500">架空のサンプル投稿</span></div><div className="flex items-center gap-4"><Link href="/ux/my-results">My Resultsへ</Link><button className="lg:hidden" onClick={() => setDetails(!details)}>{details ? "投稿に戻る" : "アカウント詳細"}</button>{range && <button onClick={() => setRange(null)}>期間をリセット</button>}</div></div>
    <div className="overflow-x-auto shrink-0"><div className="min-w-[720px]"><TopBar status="Ready" postRange={`${filtered.length} posts`} lastUpdated="demo" dateRange="Mar 1–30, 2009" selectedRange={range ? `${range.start.slice(0, 10)} – ${range.end.slice(0, 10)}` : null} keyword={keyword} onKeywordChange={setKeyword} onExport={() => notify("Exportはダミーです。本実装では閲覧できる投稿を書き出します。")} onExtend={() => notify("追加Unlockはダミーです。追加する範囲・必要なクレジットを確認してから実行する予定です。")} /></div></div>
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className={`${details ? "hidden lg:flex" : "flex"} min-w-0 flex-1 flex-col overflow-hidden`}>
        <EngagementChart data={chart} onDateClick={date => { setHighlight(date); setRange(null); timeline.current?.scrollToDate(date) }} onRangeSelect={(start, end) => { setRange({ start: start < end ? start : end, end: start < end ? end : start }); setHighlight(null) }} />
        {filtered.length ? <Timeline ref={timeline} posts={filtered} highlightedDate={highlight} /> : <p className="p-8 text-sm text-zinc-400">この条件に一致する投稿はありません。検索語や期間を変更してください。</p>}
      </div>
      <div className={`${details ? "flex" : "hidden lg:flex"} min-h-0 max-w-full [&>div]:max-w-full`}><Sidebar account={{ avatar, username, displayName: "Sample account", bio: "画面構成を確認するための架空のプロフィールです。", followers: 2400, following: 180, posts: 30, joinedDate: "Mar 2009" }} media={[]} topPosts={[...posts].sort((a, b) => b.likes - a.likes).slice(0, 5)} stats={{ totalPosts: 30, totalLikes: likes, totalRetweets: retweets, avgEngagement: (likes + retweets) / 30, postsPerDay: 1, peakHour: "9 AM" }} onJumpToPost={id => { setKeyword(""); setRange(null); setDetails(false); requestAnimationFrame(() => timeline.current?.scrollToPost(id)) }} /></div>
    </div>
  </section>
}
