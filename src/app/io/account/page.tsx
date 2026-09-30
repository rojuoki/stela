"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useIoSession } from "@/components/io/session";
import { ioJson } from "@/components/io/client";
import { IO_COPY } from "@/lib/io/ui-copy";
export default function Page() {
  const { user, loading, refresh } = useIoSession();
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function logout() { setBusy(true); try { await ioJson("/api/io/auth/logout", { method: "POST" }); await refresh(); router.replace("/io"); } catch { setError("Couldn’t log out."); } finally { setBusy(false); } }
  return <main className="mx-auto max-w-2xl px-6 py-12"><h1 className="text-3xl">{IO_COPY.account}</h1>{loading ? <p className="mt-6">{IO_COPY.loading}</p> : user ? <><p className="mt-6">{user.name}</p><p className="mt-2 text-sm text-zinc-400">{user.email}</p><div className="my-8"><Link href="/io/my-results" className="underline">{IO_COPY.myResults} →</Link></div><p className="mb-6 text-sm text-zinc-500">Billing and payment management are coming soon.</p><button disabled={busy} onClick={logout} className="rounded-lg border border-zinc-700 px-4 py-2 disabled:opacity-40">{IO_COPY.logOut}</button></> : <div className="mt-8 rounded-xl border border-zinc-800 p-6"><h2 className="text-lg font-medium">Sign in required</h2><p className="mt-2 text-sm text-zinc-400">Your unlocks and results are saved to your account.</p><div className="mt-5 flex gap-3"><Link href="/io/signin?returnTo=%2Fio%2Faccount" className="rounded-lg border border-zinc-700 px-4 py-2">{IO_COPY.signIn}</Link><Link href="/io/signin?mode=signup&returnTo=%2Fio%2Faccount" className="rounded-lg bg-white px-4 py-2 text-black">{IO_COPY.signUp}</Link></div></div>}{error && <p role="alert" className="mt-4 text-red-400">{error}</p>}</main>;
}
