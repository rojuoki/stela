"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useIoSession } from "@/components/io/session";
export default function Page() {
  const [input, setInput] = useState("");
  const router = useRouter();
  const { user } = useIoSession();
  const username = input.trim().replace(/^@/, "").toLowerCase();
  const valid = /^[a-z0-9_]{1,15}$/.test(username);
  return <main className="mx-auto max-w-3xl px-6 py-16 md:py-24"><p className="mb-5 text-xs tracking-[.2em] text-zinc-500">EXPLORE THE BEGINNING</p><h1 className="text-3xl font-medium leading-snug md:text-4xl">あのアカウントの、<br />はじまりをたどる。</h1><p className="mt-5 text-sm leading-7 text-zinc-400">Xの過去の投稿を、古い順に。気になるアカウントを探してみよう。</p><form className="mt-9 flex gap-3" onSubmit={e => { e.preventDefault(); if (valid) router.push(`/io/${username}`); }}><input aria-label="Xのユーザー名" autoComplete="off" placeholder="@username" value={input} onChange={e => setInput(e.target.value)} className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3" /><button disabled={!valid} className="rounded-lg bg-white px-6 py-3 text-sm font-medium text-black disabled:opacity-40">検索</button></form><p className="mt-3 text-xs text-zinc-500">公開アカウントのユーザー名を入力。検索では投稿の取得を開始しません。</p>{input && !valid && <p className="mt-3 text-sm text-amber-300">英数字とアンダースコア、1〜15文字で入力してください。</p>}{user && <Link href="/io/my-results" className="mt-12 inline-block text-sm text-zinc-300 underline underline-offset-4">My Resultsから続きを見る →</Link>}</main>;
}
