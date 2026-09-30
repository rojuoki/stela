"use client";
import Link from "next/link";
import { useIoSession } from "./session";
import { useState } from "react";
import { IO_COPY } from "@/lib/io/ui-copy";
export function IoNavigation() {
  const { user, loading, error, refresh } = useIoSession();
  const [busy, setBusy] = useState(false);
  async function logout() {
    setBusy(true);
    try {
      await fetch("/api/io/auth/logout", { method: "POST" });
      await refresh();
    } finally {
      setBusy(false);
    }
  }
  return <><nav aria-label="Main navigation" className="flex flex-wrap items-center justify-between gap-4 border-b border-border bg-background px-5 py-5 md:px-8"><Link href="/io" className="text-xl font-semibold tracking-wider">STELA</Link><div className="flex flex-wrap items-center gap-5 text-sm"><Link href="/io">{IO_COPY.search}</Link><Link href="/io/my-results">{IO_COPY.myResults}</Link>{!loading && (user ? <><Link href="/io/account">{IO_COPY.account}</Link><button type="button" disabled={busy} onClick={() => void logout()} className="text-zinc-400 hover:text-white disabled:opacity-40">{IO_COPY.logOut}</button></> : <><Link href="/io/signin">{IO_COPY.signIn}</Link><Link href="/io/signin?mode=signup" className="rounded-md bg-white px-3 py-1.5 text-black">{IO_COPY.signUp}</Link></>)}</div></nav>{error && <p role="alert" className="px-5 py-3 text-sm text-red-400">{error}</p>}</>;
}
