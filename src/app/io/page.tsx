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
  return <main className="mx-auto max-w-3xl px-6 py-16 md:py-24"><p className="mb-5 text-xs tracking-[.2em] text-zinc-500">EXPLORE THE BEGINNING</p><h1 className="text-3xl font-medium leading-snug md:text-4xl">Trace an account<br />back to its beginning.</h1><p className="mt-5 text-sm leading-7 text-zinc-400">Explore past posts on X, starting with the earliest.</p><form className="mt-9 flex gap-3" onSubmit={e => { e.preventDefault(); if (valid) router.push(`/io/${username}`); }}><input aria-label="X username" autoComplete="off" placeholder="@username" value={input} onChange={e => setInput(e.target.value)} className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3" /><button disabled={!valid} className="rounded-lg bg-white px-6 py-3 text-sm font-medium text-black disabled:opacity-40">Search</button></form><p className="mt-3 text-xs text-zinc-500">Preview up to 20 of the earliest posts from any public account, free.</p>{input && !valid && <p className="mt-3 text-sm text-amber-300">Use 1–15 letters, numbers, or underscores.</p>}{user && <Link href="/io/my-results" className="mt-12 inline-block text-sm text-zinc-300 underline underline-offset-4">Continue from My Results →</Link>}</main>;
}
