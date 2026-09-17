"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type User = { id: string; email: string; name: string };
type Run = { id: string; username: string; status: string; progress_message?: string | null; granted_boundary?: number | null; error_message?: string | null };
type Post = { post_id: string; created_at: string; full_text: string; url?: string | null; rank?: number };
type RangeRequest = { id: string; status: string; startAt: string; endAt: string; errorMessage?: string | null; run?: Run | null };

async function json<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error || "リクエストに失敗しました");
  return body;
}

function username(value: string): string | null {
  const normalized = value.trim().replace(/^@/, "");
  return /^[A-Za-z0-9_]{1,15}$/.test(normalized) ? normalized : null;
}

export default function IoUnlockPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [handle, setHandle] = useState("");
  const [prefixRun, setPrefixRun] = useState<Run | null>(null);
  const [prefixAccount, setPrefixAccount] = useState("");
  const [waitingOnSharedRun, setWaitingOnSharedRun] = useState(false);
  const [rangeRequest, setRangeRequest] = useState<RangeRequest | null>(null);
  const [rangeStart, setRangeStart] = useState("");
  const [rangeEnd, setRangeEnd] = useState("");
  const [posts, setPosts] = useState<Post[]>([]);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    json<{ user: User }>("/api/io/auth/me").then(({ user: current }) => setUser(current)).catch(() => router.replace("/io/signin"));
  }, [router]);

  async function loadPrefixPosts(account: string, runId?: string) {
    const query = runId ? `?view=delta&runId=${encodeURIComponent(runId)}` : "?view=prefix";
    const response = await json<{ posts: Post[] }>(`/api/io/accounts/${account}/posts${query}`);
    setPosts(response.posts);
  }

  async function loadRangePosts(account: string, startAt: string, endAt: string) {
    const params = new URLSearchParams({ view: "range", startAt, endAt });
    const response = await json<{ posts: Post[] }>(`/api/io/accounts/${account}/posts?${params}`);
    setPosts(response.posts);
  }

  useEffect(() => {
    if (!prefixRun || !["queued", "running"].includes(prefixRun.status)) return;
    const poll = async () => {
      try {
        const { run } = await json<{ run: Run; shared?: boolean }>(`/api/io/runs/${prefixRun.id}`);
        setPrefixRun(run);
        if (run.status === "succeeded") {
          const account = username(run.username) || username(prefixAccount);
          if (account && waitingOnSharedRun) {
            setPrefixRun(null);
            await startPrefixRequest(account);
            setNotice("採掘結果を準備しています。");
          } else {
            if (account) await loadPrefixPosts(account, run.id);
            setNotice("追加分を解放しました。");
          }
        }
      } catch (cause) { setError(cause instanceof Error ? cause.message : "進捗を取得できません"); }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2_000);
    return () => window.clearInterval(timer);
  }, [prefixRun, prefixAccount, waitingOnSharedRun]);

  useEffect(() => {
    if (!rangeRequest || !["queued", "running"].includes(rangeRequest.status)) return;
    const poll = async () => {
      try {
        const { rangeRequest: current } = await json<{ rangeRequest: RangeRequest }>(`/api/io/range-requests/${rangeRequest.id}`);
        setRangeRequest(current);
        if (current.status === "succeeded") {
          const account = username(handle);
          if (account) await loadRangePosts(account, current.startAt, current.endAt);
          setNotice("指定期間を解放しました。");
        }
      } catch (cause) { setError(cause instanceof Error ? cause.message : "進捗を取得できません"); }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2_000);
    return () => window.clearInterval(timer);
  }, [rangeRequest, handle, rangeStart, rangeEnd]);

  async function startPrefixRequest(account: string) {
    const result = await json<{ kind: string; run?: Run; reused?: boolean; shared?: boolean }>("/api/io/unlocks/prefix", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: account }),
      });
    if (!result.run) throw new Error("採掘ジョブを開始できません");
    setWaitingOnSharedRun(Boolean(result.shared));
    setPrefixRun(result.run);
  }

  async function unlockPrefix(event: FormEvent) {
    event.preventDefault();
    const account = username(handle);
    if (!account) return setError("有効なXユーザー名を入力してください");
    setPrefixAccount(account);
    setBusy(true); setError(""); setNotice(""); setPosts([]);
    try {
      await startPrefixRequest(account);
      setNotice("採掘ジョブを開始しました。完了までこのまま表示します。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "追加採掘を開始できません"); }
    finally { setBusy(false); }
  }

  async function unlockRange(event: FormEvent) {
    event.preventDefault();
    const account = username(handle);
    if (!account) return setError("先にXユーザー名を入力してください");
    if (!rangeStart || !rangeEnd) return setError("開始日時と終了日時を入力してください");
    setBusy(true); setError(""); setNotice(""); setPosts([]);
    try {
      const startAt = new Date(rangeStart).toISOString();
      const endAt = new Date(rangeEnd).toISOString();
      const result = await json<{ kind: string; range?: { startAt: string; endAt: string }; requestId?: string; run?: Run }>("/api/io/unlocks/range", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: account, startAt, endAt }),
      });
      if (result.kind === "granted" && result.range) {
        await loadRangePosts(account, result.range.startAt, result.range.endAt);
        setNotice("すでに採掘済みのため、すぐに期間を解放しました。");
      } else if (result.requestId && result.range) {
        setRangeRequest({ id: result.requestId, status: "queued", ...result.range, run: result.run ?? null });
        setNotice("期間指定の採掘ジョブを開始しました。");
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "期間指定採掘を開始できません"); }
    finally { setBusy(false); }
  }

  async function signOut() {
    await fetch("/api/io/auth/logout", { method: "POST" });
    router.replace("/io/signin");
  }

  async function showFullPrefix() {
    const account = username(prefixRun?.username || prefixAccount);
    if (!account) return;
    setBusy(true); setError("");
    try {
      await loadPrefixPosts(account);
      setNotice("解放済みの投稿をすべて表示しています。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "投稿を取得できません");
    } finally {
      setBusy(false);
    }
  }

  async function cancelPrefixRun() {
    if (!prefixRun || waitingOnSharedRun) return;
    setBusy(true); setError("");
    try {
      const { run } = await json<{ run: Run }>(`/api/io/runs/${prefixRun.id}`, { method: "DELETE" });
      setPrefixRun(run);
      setNotice("採掘をキャンセルしました。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "採掘をキャンセルできません");
    } finally {
      setBusy(false);
    }
  }

  const progress = prefixRun && ["queued", "running"].includes(prefixRun.status) ? prefixRun.progress_message :
    rangeRequest && ["queued", "running"].includes(rangeRequest.status) ? rangeRequest.run?.progress_message || "範囲を確認中" : null;

  return (
    <main className="mx-auto max-w-4xl px-4 py-10">
      <header className="flex items-start justify-between gap-4 border-b border-zinc-800 pb-7">
        <div><Link href="/io" className="text-sm text-zinc-400 hover:text-white">← プロトタイプ</Link><h1 className="mt-3 text-3xl font-semibold tracking-tight">STELA IO</h1><p className="mt-1 text-sm text-zinc-400">連続した最古側の投稿を、+1000ずつ安全に解放します。</p></div>
        {user && <button onClick={signOut} className="text-sm text-zinc-400 hover:text-white">{user.name} · ログアウト</button>}
      </header>
      <section className="mt-8 rounded-xl border border-zinc-800 bg-zinc-950 p-5">
        <form onSubmit={unlockPrefix} className="flex flex-wrap gap-3">
          <label className="min-w-56 flex-1 text-sm text-zinc-300">Xユーザー名
            <input value={handle} onChange={(event) => setHandle(event.target.value)} placeholder="@username" className="mt-1 block w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-white" />
          </label>
          <button disabled={busy} className="mt-6 rounded-lg bg-white px-5 py-2 text-sm font-semibold text-black disabled:opacity-50">解放 / +1000</button>
        </form>
        <p className="mt-3 text-xs leading-relaxed text-zinc-500">投稿が1000件未満で採掘が終端まで確定した場合は、その実数だけを確定して解放します。連続しない採掘結果は保存も解放もしません。</p>
      </section>
      <section className="mt-5 rounded-xl border border-zinc-800 p-5">
        <h2 className="font-medium">期間を指定して解放</h2>
        <p className="mt-1 text-sm text-zinc-500">最大31日。既に完全に採掘済みの区間は、外部APIを呼ばずに解放します。</p>
        <form onSubmit={unlockRange} className="mt-4 grid gap-3 sm:grid-cols-3">
          <input required type="datetime-local" value={rangeStart} onChange={(event) => setRangeStart(event.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm" />
          <input required type="datetime-local" value={rangeEnd} onChange={(event) => setRangeEnd(event.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm" />
          <button disabled={busy} className="rounded-lg border border-zinc-600 px-4 py-2 text-sm font-medium hover:bg-zinc-900 disabled:opacity-50">期間を解放</button>
        </form>
      </section>
      {(progress || notice || error || prefixRun?.status === "failed" || rangeRequest?.status === "failed") && <section className="mt-5 rounded-xl border border-zinc-800 bg-zinc-950 p-4 text-sm">
        {progress && <p className="text-sky-300">進行中：{progress}</p>}
        {prefixRun && ["queued", "running"].includes(prefixRun.status) && !waitingOnSharedRun && <button type="button" disabled={busy} onClick={() => void cancelPrefixRun()} className="mt-3 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-900 disabled:opacity-50">キャンセル</button>}
        {notice && <p className="text-emerald-300">{notice}</p>}
        {(error || prefixRun?.error_message || rangeRequest?.errorMessage) && <p className="text-red-400">{error || prefixRun?.error_message || rangeRequest?.errorMessage}</p>}
      </section>}
      {posts.length > 0 && <section className="mt-7"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-medium">解放された投稿 <span className="text-sm font-normal text-zinc-500">{posts.length}件</span></h2>{prefixRun?.status === "succeeded" && <button type="button" disabled={busy} onClick={() => void showFullPrefix()} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-900 disabled:opacity-50">解放済み全件を見る</button>}</div><div className="mt-3 space-y-3">
        {posts.map((post) => <article key={post.post_id} className="rounded-xl border border-zinc-800 p-4"><div className="text-xs text-zinc-500">{post.rank ? `#${post.rank} · ` : ""}{new Date(post.created_at).toLocaleString("ja-JP")}</div><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-zinc-200">{post.full_text}</p>{post.url && <a className="mt-2 inline-block text-xs text-sky-300 hover:underline" href={post.url} target="_blank" rel="noreferrer">投稿を開く</a>}</article>)}
      </div></section>}
    </main>
  );
}
