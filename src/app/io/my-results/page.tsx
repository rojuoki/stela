"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useIoSession } from "@/components/io/session";
import { ioJson } from "@/components/io/client";
import { IO_COPY } from "@/lib/io/ui-copy";
export default function Page() {
  const { user, loading } = useIoSession();
  const [accounts, setAccounts] = useState<{ username: string; updated_at: string }[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { let canceled = false; if (user) ioJson<{ accounts: { username: string; updated_at: string }[] }>("/api/io/my-results").then(data => { if (!canceled) setAccounts(data.accounts); }).catch(e => { if (!canceled) setError(e.message); }); return () => { canceled = true; }; }, [user]);
  return <main className="mx-auto max-w-3xl px-6 py-12"><h1 className="text-3xl font-medium">{IO_COPY.myResults}</h1><p className="mt-3 mb-8 text-sm text-zinc-400">Unlocked results and accounts still processing.</p>{loading ? <p>{IO_COPY.loading}</p> : !user ? <div className="rounded-xl border border-zinc-800 p-6"><h2 className="text-lg font-medium">Sign in to view your results</h2><p className="mt-2 text-sm text-zinc-400">Review your unlocked ranges and active requests from your account.</p><div className="mt-5 flex gap-3"><Link href="/io/signin?returnTo=%2Fio%2Fmy-results" className="rounded-lg border border-zinc-700 px-4 py-2">{IO_COPY.signIn}</Link><Link href="/io/signin?mode=signup&returnTo=%2Fio%2Fmy-results" className="rounded-lg bg-white px-4 py-2 text-black">{IO_COPY.signUp}</Link></div></div> : error ? <p role="alert" className="text-red-400">{error}</p> : accounts === null ? <p>{IO_COPY.loading}</p> : accounts.length ? <div className="divide-y divide-zinc-800">{accounts.map(a => <Link key={a.username} href={`/io/${a.username}`} className="flex justify-between gap-4 py-5"><span>@{a.username}<span className="mt-1 block text-xs text-zinc-500">{new Date(a.updated_at).toLocaleString("en-US")}</span></span><span className="text-sm">View →</span></Link>)}</div> : <><p className="mb-5 text-zinc-400">No results yet.</p><Link href="/io" className="underline">Search for an account</Link></>}</main>;
}
