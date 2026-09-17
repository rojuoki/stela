"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

type Mode = "login" | "signup";

export default function IoSignInPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/io/auth/${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, ...(mode === "signup" ? { name } : {}) }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || "認証に失敗しました");
      router.replace("/io/unlock");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "認証に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-md px-4 py-16">
      <Link href="/io" className="text-sm text-zinc-400 hover:text-white">← プロトタイプに戻る</Link>
      <h1 className="mt-8 text-3xl font-semibold tracking-tight">STELA IO</h1>
      <p className="mt-2 text-sm text-zinc-400">採掘済みデータへのアクセスを、あなたのアカウントに紐づけます。</p>
      <div className="mt-8 flex rounded-lg border border-zinc-800 p-1 text-sm">
        {(["login", "signup"] as const).map((item) => (
          <button key={item} type="button" onClick={() => { setMode(item); setError(""); }}
            className={`flex-1 rounded-md px-3 py-2 ${mode === item ? "bg-white text-black" : "text-zinc-400 hover:text-white"}`}>
            {item === "login" ? "ログイン" : "新規登録"}
          </button>
        ))}
      </div>
      <form onSubmit={submit} className="mt-5 space-y-4">
        {mode === "signup" && <label className="block text-sm">名前
          <input required value={name} onChange={(event) => setName(event.target.value)} className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2" />
        </label>}
        <label className="block text-sm">メールアドレス
          <input required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2" />
        </label>
        <label className="block text-sm">パスワード
          <input required minLength={8} type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} value={password} onChange={(event) => setPassword(event.target.value)} className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2" />
        </label>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button disabled={busy} className="w-full rounded-lg bg-white px-4 py-2.5 text-sm font-semibold text-black disabled:opacity-50">
          {busy ? "処理中…" : mode === "login" ? "ログイン" : "アカウントを作成"}
        </button>
      </form>
    </main>
  );
}
