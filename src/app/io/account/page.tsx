"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useIoSession } from "@/components/io/session";
import { ioJson } from "@/components/io/client";
export default function Page() {
  const { user, loading, refresh } = useIoSession();
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function logout() { setBusy(true); try { await ioJson("/api/io/auth/logout", { method: "POST" }); await refresh(); router.replace("/io"); } catch { setError("ログアウトできませんでした。"); } finally { setBusy(false); } }
  return <main className="mx-auto max-w-2xl px-6 py-12"><h1 className="text-3xl">アカウント</h1>{loading ? <p className="mt-6">読み込み中…</p> : user ? <><p className="mt-6">{user.name}</p><p className="mt-2 text-sm text-zinc-400">{user.email}</p><div className="my-8"><Link href="/io/my-results" className="underline">My Results →</Link></div><p className="mb-6 text-sm text-zinc-500">購入・支払い管理は準備中です。</p><button disabled={busy} onClick={logout} className="rounded-lg border border-zinc-700 px-4 py-2 disabled:opacity-40">ログアウト</button></> : <Link href="/io/signin" className="mt-6 block underline">ログイン</Link>}{error && <p role="alert" className="mt-4 text-red-400">{error}</p>}</main>;
}
