"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ProfileBanner, LockedTimeline, type ProfileBannerData } from "@/components/dashboard/profile-banner";
import { SavedTimeline } from "@/components/dashboard/saved-timeline";
import { useIoSession } from "@/components/io/session";
import { ioJson, ioPost } from "@/components/io/client";
import type { TweetData } from "@/components/types";

type Run = { id: string; status: string; username: string; progress_message?: string | null; error_message?: string | null; unique_count?: number; target_count?: number };
type Range = { startAt: string; endAt: string };
type RangeRequest = Range & { id: string; status: string; errorMessage?: string | null; run?: Run | null };
type Snapshot = { account: ProfileBannerData | null; boundary: number; ranges: Range[]; latestRun: Run | null; rangeRequest: RangeRequest | null };
const active = (status?: string) => status === "queued" || status === "running";
const button = "rounded-lg border border-zinc-700 px-4 py-2 text-sm disabled:opacity-40 hover:bg-zinc-800";

export default function Page() {
  const { username } = useParams<{ username: string }>();
  const { user } = useIoSession();
  return <Account key={`${username}:${user?.id || "guest"}`} username={username} />;
}
function Account({ username }: { username: string }) {
  const { user, loading: authLoading } = useIoSession();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [posts, setPosts] = useState<TweetData[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [rangeRequest, setRangeRequest] = useState<RangeRequest | null>(null);
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [view, setView] = useState("prefix");
  const mounted = useRef(true);
  const viewing = useRef(0);
  const submitting = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const base = `/api/io/accounts/${encodeURIComponent(username)}`;
  const loadSnapshot = useCallback(async () => {
    const data = await ioJson<Snapshot>(base);
    if (mounted.current) setSnapshot(data);
    return data;
  }, [base]);
  const showPosts = useCallback(async (range?: Range) => {
    const version = ++viewing.current;
    const query = range ? new URLSearchParams({ view: "range", ...range }).toString() : "view=prefix";
    const result = await ioJson<{ posts: TweetData[] }>(`${base}/posts?${query}`);
    if (mounted.current && viewing.current === version) { setPosts(result.posts); setView(range ? `${range.startAt} — ${range.endAt}` : "prefix"); }
  }, [base]);
  useEffect(() => {
    if (authLoading) return;
    let canceled = false;
    (async () => {
      try {
        const data = await loadSnapshot();
        if (canceled) return;
        setRun(user ? data.latestRun : null); setRangeRequest(user ? data.rangeRequest : null);
        if (user && data.boundary > 0) await showPosts();
        else if (user && data.ranges.length) await showPosts(data.ranges[0]);
      } catch (e) { if (!canceled) setError(e instanceof Error ? e.message : "読み込めませんでした"); }
      finally { if (!canceled) setLoading(false); }
    })();
    return () => { canceled = true; };
  }, [authLoading, user, loadSnapshot, showPosts]);
  const runId = run?.id;
  const runStatus = run?.status;
  const rangeId = rangeRequest?.id;
  const rangeStatus = rangeRequest?.status;
  useEffect(() => {
    if (!runId || !active(runStatus)) return;
    let canceled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const data = await ioJson<{ run: Run; shared: boolean }>(`/api/io/runs/${runId}`);
        if (canceled) return;
        setRun(data.run); setShared(data.shared);
        if (data.run.status === "succeeded") {
          await loadSnapshot();
          if (!data.shared) { await showPosts(); setNotice("Unlockが完了しました。"); }
          else setNotice("投稿の準備ができました。Unlockを押すと、あなたの閲覧範囲を開きます。");
        }
      } catch (e) { if (!canceled) setError(e instanceof Error ? e.message : "進捗を確認できません"); }
      if (!canceled) timer = setTimeout(poll, 2000);
    };
    timer = setTimeout(poll, 500);
    return () => { canceled = true; clearTimeout(timer); };
  }, [runId, runStatus, loadSnapshot, showPosts]);
  useEffect(() => {
    if (!rangeId || !active(rangeStatus)) return;
    let canceled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const data = await ioJson<{ rangeRequest: RangeRequest }>(`/api/io/range-requests/${rangeId}`);
        if (canceled) return;
        setRangeRequest(data.rangeRequest);
        if (data.rangeRequest.status === "succeeded") { await loadSnapshot(); await showPosts(data.rangeRequest); setNotice("指定期間をUnlockしました。"); }
      } catch (e) { if (!canceled) setError(e instanceof Error ? e.message : "進捗を確認できません"); }
      if (!canceled) timer = setTimeout(poll, 2000);
    };
    timer = setTimeout(poll, 500);
    return () => { canceled = true; clearTimeout(timer); };
  }, [rangeId, rangeStatus, loadSnapshot, showPosts]);
  const working = busy || active(run?.status) || active(rangeRequest?.status);
  async function unlock(range?: Range) {
    if (working || submitting.current || !user) return;
    const label = range ? "指定した期間" : snapshot?.boundary ? "次の最大1,000件" : "最古側の最大1,000件";
    if (!window.confirm(`@${username} の${label}をUnlockします。未取得の場合は外部APIを使用して取得します。続けますか？`)) return;
    submitting.current = true; setBusy(true); setError(""); setNotice("");
    try {
      if (range) {
        const result = await ioJson<{ kind: string; range: Range; requestId?: string; run?: Run }>("/api/io/unlocks/range", ioPost({ username, ...range }));
        if (result.kind === "granted") { await loadSnapshot(); await showPosts(result.range); setNotice("指定期間をUnlockしました。"); }
        else if (result.requestId) setRangeRequest({ id: result.requestId, status: "queued", ...result.range, run: result.run });
        else throw new Error("取得を開始できませんでした");
      } else {
        const result = await ioJson<{ run: Run; shared: boolean }>("/api/io/unlocks/prefix", ioPost({ username }));
        setShared(result.shared); setRun(result.run);
        if (result.run.status === "succeeded") { await loadSnapshot(); await showPosts(); }
      }
    } catch (e) { setError(e instanceof Error ? e.message : "Unlockできませんでした"); }
    finally { submitting.current = false; setBusy(false); }
  }
  async function viewRange(range?: Range) { setBusy(true); setError(""); try { await showPosts(range); } catch (e) { setError(e instanceof Error ? e.message : "表示できません"); } finally { setBusy(false); } }
  async function cancel() { if (!run || shared) return; setBusy(true); try { const data = await ioJson<{ run: Run }>(`/api/io/runs/${run.id}`, { method: "DELETE" }); setRun(data.run); setNotice("取得をキャンセルしました。"); } catch (e) { setError(e instanceof Error ? e.message : "キャンセルできません"); } finally { setBusy(false); } }
  const invalid = !/^[a-zA-Z0-9_]{1,15}$/.test(username);
  if (invalid) return <main className="p-8">無効なユーザー名です。<Link href="/io">検索に戻る</Link></main>;
  if (loading) return <main className="mx-auto max-w-7xl px-8 py-14" aria-busy="true"><p className="text-sm text-muted-foreground">アカウントを確認しています</p><h1 className="mt-3 text-2xl">@{username}</h1><div className="mt-6 h-20 max-w-2xl animate-pulse rounded-lg bg-secondary" /></main>;
  return <main className="mx-auto max-w-7xl bg-background text-foreground">
    <ProfileBanner account={snapshot?.account || { username }} compact={posts.length > 0} searchHref="/io" />
    <section className="space-y-4 px-5 py-6 md:px-8">

      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
      {notice && <p role="status" className="text-sm text-sky-300">{notice}</p>}
      {snapshot && !snapshot.account?.protected && <div className="flex flex-col justify-between gap-6 rounded-xl border border-border p-5 sm:flex-row sm:items-center">
        <div><p className="mb-2 text-xs tracking-widest text-muted-foreground">{snapshot.boundary ? "YOUR TIMELINE" : "UNLOCK TIMELINE"}</p><h2 className="mb-2 text-lg font-medium">{snapshot.boundary ? "続きをたどる" : "このアカウントの、最初の投稿へ。"}</h2><p className="text-sm text-muted-foreground">{snapshot.boundary > 0 ? `最古側 ${snapshot.boundary.toLocaleString()}件をUnlock済み` : "最古側から最大1,000件。古い順の投稿・グラフ・反応の多い投稿を閲覧できます。"}</p></div><div className="flex shrink-0 flex-wrap gap-3">
        {user ? <button disabled={working} onClick={() => void unlock()} className={`${button} bg-white text-black hover:bg-zinc-200`}>{working ? "処理中…" : snapshot.boundary ? "追加Unlock · +1,000" : "Unlock"}</button> : <Link className={button} href={`/io/signin?returnTo=${encodeURIComponent(`/io/${username}`)}`}>ログインして続ける</Link>}
        {snapshot.boundary > 0 && <button disabled={busy} className={button} onClick={() => void viewRange()}>View · Unlock済み全件</button>}</div>
      </div>}
      {active(run?.status) && <div role="status" className="text-sm text-sky-300"><p>{run?.status === "queued" ? "取得の順番を待っています。準備ができ次第、自動で開始します。" : run?.progress_message || "投稿を取得しています。"}</p><p className="mt-1 text-xs text-muted-foreground">ページを閉じても取得は続きます。My Resultsから戻れます。</p>{!shared && <button disabled={busy} onClick={() => void cancel()} className={`${button} mt-3`}>キャンセル</button>}</div>}
      {run?.status === "failed" && <p role="alert" className="text-sm text-red-400">取得に失敗しました。{run.error_message}</p>}
      {rangeRequest && <p role="status" className="text-sm text-muted-foreground">期間指定：{active(rangeRequest.status) ? rangeRequest.run?.progress_message || "取得中" : rangeRequest.status === "failed" ? rangeRequest.errorMessage || "取得に失敗しました" : rangeRequest.status === "succeeded" ? "完了" : "キャンセル済み"}</p>}
      {user && snapshot && !snapshot.account?.protected && <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">期間を指定してUnlock</summary><form className="mt-4 flex flex-wrap items-end gap-3" onSubmit={e => { e.preventDefault(); const a = Date.parse(start), b = Date.parse(end); if (!Number.isFinite(a) || !Number.isFinite(b) || a >= b || b-a > 31*86400000) { setError("開始より後の終了日時を、31日以内で指定してください。"); return; } void unlock({ startAt: new Date(a).toISOString(), endAt: new Date(b).toISOString() }); }}><label>開始日時<input required type="datetime-local" value={start} onChange={e => setStart(e.target.value)} className="mt-1 block rounded border border-border bg-secondary p-2" /></label><label>終了日時<input required type="datetime-local" value={end} onChange={e => setEnd(e.target.value)} className="mt-1 block rounded border border-border bg-secondary p-2" /></label><button disabled={working} className={button}>期間をUnlock</button></form><p className="mt-2 text-xs text-muted-foreground">最大31日。日時はお使いの端末のタイムゾーンです。</p></details>}
      {!!snapshot?.ranges.length && <div className="flex flex-wrap gap-2"><span className="py-2 text-xs text-muted-foreground">保存済みの期間</span>{snapshot.ranges.map(r => <button key={r.startAt+r.endAt} disabled={busy} className={button} onClick={() => void viewRange(r)}>{new Date(r.startAt).toLocaleDateString()} — {new Date(r.endAt).toLocaleDateString()}</button>)}</div>}
    </section>
    {user && posts.length ? <SavedTimeline key={view} tweets={posts} username={username} /> : user && (snapshot?.boundary || view !== "prefix") ? <p className="border-t border-border p-8 text-sm text-muted-foreground">閲覧できる投稿がありません。</p> : <LockedTimeline unavailable={snapshot?.account?.protected} />}
  </main>;
}
