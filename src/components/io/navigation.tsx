"use client";
import Link from "next/link";
import { useIoSession } from "./session";
export function IoNavigation() {
  const { user, loading, error } = useIoSession();
  return <><nav aria-label="メインナビゲーション" className="flex flex-wrap items-center justify-between gap-4 border-b border-border bg-background px-5 py-5 md:px-8"><Link href="/io" className="text-xl font-semibold tracking-wider">STELA</Link><div className="flex gap-5 text-sm"><Link href="/io">検索</Link><Link href="/io/my-results">My Results</Link>{!loading && <Link href={user ? "/io/account" : "/io/signin"}>{user ? "アカウント" : "ログイン"}</Link>}</div></nav>{error && <p role="alert" className="px-5 py-3 text-sm text-red-400">{error}</p>}</>;
}
