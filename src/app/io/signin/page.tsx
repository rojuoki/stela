"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useIoSession } from "@/components/io/session";
import { IO_COPY } from "@/lib/io/ui-copy";

type Mode = "login" | "signup";

export default function IoSignInPage() {
  const router = useRouter();
  const { refresh } = useIoSession();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Read this browser-only query after hydration without changing the form URL.
    setMode(new URLSearchParams(window.location.search).get("mode") === "signup" ? "signup" : "login");
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    if (mode === "signup" && password !== passwordConfirmation) {
      setError("Passwords do not match");
      setBusy(false);
      return;
    }
    try {
      const response = await fetch(`/api/io/auth/${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, ...(mode === "signup" ? { name } : {}) }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || "Authentication failed");
      await refresh();
      const returnTo = new URLSearchParams(window.location.search).get("returnTo");
      router.replace(returnTo && /^\/io(?:\/[^\\?#]*)?$/.test(returnTo) ? returnTo : "/io");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Authentication failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-md px-4 py-16">
      <Link href="/io" className="text-sm text-zinc-400 hover:text-white">← Back to search</Link>
      <h1 className="mt-8 text-3xl font-semibold tracking-tight">STELA IO</h1>
      <p className="mt-2 text-sm text-zinc-400">Save unlocked results and access them from your account.</p>
      <div className="mt-8 flex rounded-lg border border-zinc-800 p-1 text-sm">
        {(["login", "signup"] as const).map((item) => (
          <button key={item} type="button" onClick={() => { setMode(item); setError(""); }}
            className={`flex-1 rounded-md px-3 py-2 ${mode === item ? "bg-white text-black" : "text-zinc-400 hover:text-white"}`}>
            {item === "login" ? IO_COPY.signIn : IO_COPY.signUp}
          </button>
        ))}
      </div>
      <form onSubmit={submit} className="mt-5 space-y-4">
        {mode === "signup" && <label className="block text-sm">Name
          <input required value={name} onChange={(event) => setName(event.target.value)} className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2" />
        </label>}
        <label className="block text-sm">Email
          <input required type="email" autoComplete="email" autoCapitalize="none" spellCheck={false} value={email} onChange={(event) => setEmail(event.target.value)} className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2" />
        </label>
        <label className="block text-sm">Password
          <input required minLength={8} type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} value={password} onChange={(event) => setPassword(event.target.value)} className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2" />
        </label>
        {mode === "signup" && <label className="block text-sm">Confirm password
          <input required minLength={8} type="password" autoComplete="new-password" value={passwordConfirmation} onChange={(event) => setPasswordConfirmation(event.target.value)} className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2" />
        </label>}
        {mode === "signup" && <p className="text-xs leading-relaxed text-zinc-500">Use at least 8 characters. Email verification and password reset will be available before launch.</p>}
        {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
        <button disabled={busy} className="w-full rounded-lg bg-white px-4 py-2.5 text-sm font-semibold text-black disabled:opacity-50">
          {busy ? IO_COPY.working : mode === "login" ? IO_COPY.signIn : "Create account"}
        </button>
      </form>
    </main>
  );
}
