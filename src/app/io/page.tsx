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
  return <main className="mx-auto max-w-4xl px-6 py-16 md:py-24">
    <section className="max-w-3xl">
      <p className="mb-5 text-xs tracking-[.2em] text-zinc-500">EXPLORE THE BEGINNING</p>
      <h1 className="text-4xl font-medium leading-tight md:text-6xl">Trace an account<br />back to its beginning.</h1>
      <p className="mt-5 max-w-xl text-sm leading-7 text-zinc-400 md:text-base">Search a public X account, preview its earliest posts, then explore the timeline, media, and engagement in one place.</p>
      <form className="mt-9 flex flex-col gap-3 sm:flex-row" onSubmit={e => { e.preventDefault(); if (valid) router.push(`/io/${username}`); }}><input aria-label="X username" autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="@username" value={input} onChange={e => setInput(e.target.value)} className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3" /><button disabled={!valid} className="rounded-lg bg-white px-6 py-3 text-sm font-medium text-black disabled:opacity-40">Explore account</button></form>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-zinc-500"><span>Preview up to 20 earliest posts, free.</span><Link href="/io/jack" className="text-zinc-300 underline underline-offset-4">Try @jack →</Link></div>
      {input && !valid && <p className="mt-3 text-sm text-amber-300">Use 1–15 letters, numbers, or underscores.</p>}
      {user && <Link href="/io/my-results" className="mt-8 inline-block text-sm text-zinc-300 underline underline-offset-4">Continue from My Results →</Link>}
    </section>
    <section className="mt-24 border-t border-zinc-800 pt-10" aria-labelledby="how-it-works"><p className="text-xs tracking-[.18em] text-zinc-500">HOW IT WORKS</p><h2 id="how-it-works" className="mt-3 text-2xl font-medium">From username to navigable archive</h2><div className="mt-8 grid gap-4 md:grid-cols-3">{[
      ["01", "Search", "Enter a public X username. No account is needed for the first preview."],
      ["02", "Explore", "Move chronologically, search text, inspect media, and open engagement analytics."],
      ["03", "Save", "Sign in to unlock more posts or a specific date range and return to it later."],
    ].map(([number, title, copy]) => <article key={number} className="rounded-xl border border-zinc-800 bg-zinc-950 p-5"><p className="text-xs text-sky-300">{number}</p><h3 className="mt-5 font-medium">{title}</h3><p className="mt-2 text-sm leading-6 text-zinc-500">{copy}</p></article>)}</div></section>
    <section className="mt-16 grid gap-8 border-t border-zinc-800 py-10 md:grid-cols-2"><div><h2 className="text-lg font-medium">What can I search?</h2><p className="mt-3 text-sm leading-6 text-zinc-500">Public X accounts. Protected accounts cannot be fetched, and availability depends on the external source.</p></div><div><h2 className="text-lg font-medium">What is stored?</h2><p className="mt-3 text-sm leading-6 text-zinc-500">Unlocked results are attached to your STELA account. You can export the posts currently shown as CSV or JSON.</p></div></section>
  </main>;
}
