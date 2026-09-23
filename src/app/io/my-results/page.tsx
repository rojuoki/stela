"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useIoSession } from "@/components/io/session";
import { ioJson } from "@/components/io/client";
export default function Page() {
  const { user, loading } = useIoSession();
  const [accounts, setAccounts] = useState<{ username: string; updated_at: string }[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { let canceled = false; if (user) ioJson<{ accounts: { username: string; updated_at: string }[] }>("/api/io/my-results").then(data => { if (!canceled) setAccounts(data.accounts); }).catch(e => { if (!canceled) setError(e.message); }); return () => { canceled = true; }; }, [user]);
  return <main className="mx-auto max-w-3xl px-6 py-12"><h1 className="text-3xl font-medium">My Results</h1><p className="mt-3 mb-8 text-sm text-zinc-400">取得済みの結果と、処理中のアカウント。</p>{loading ? <p>読み込み中…</p> : !user ? <Link href="/io/signin?returnTo=%2Fio%2Fmy-results" className="underline">ログインして結果を見る</Link> : error ? <p role="alert" className="text-red-400">{error}</p> : accounts === null ? <p>読み込み中…</p> : accounts.length ? <div className="divide-y divide-zinc-800">{accounts.map(a => <Link key={a.username} href={`/io/${a.username}`} className="flex justify-between gap-4 py-5"><span>@{a.username}<span className="mt-1 block text-xs text-zinc-500">{new Date(a.updated_at).toLocaleString("ja-JP")}</span></span><span className="text-sm">View →</span></Link>)}</div> : <><p className="mb-5 text-zinc-400">まだ結果はありません。</p><Link href="/io" className="underline">アカウントを検索</Link></>}</main>;
}
