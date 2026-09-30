"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ProfileBanner, LockedTimeline, type ProfileBannerData } from "@/components/dashboard/profile-banner";
import { SavedTimeline } from "@/components/dashboard/saved-timeline";
import { useIoSession } from "@/components/io/session";
import { ioJson, ioPost } from "@/components/io/client";
import type { TweetData } from "@/components/types";

type Run = { id: string; status: string; username: string; collection_mode?: string; progress_message?: string | null; error_message?: string | null; unique_count?: number; candidate_count?: number; target_count?: number; base_boundary?: number | null; target_boundary?: number | null; granted_boundary?: number | null; accountExhausted?: boolean };
type Range = { startAt: string; endAt: string };
type RangeRequest = Range & { id: string; status: string; errorMessage?: string | null; run?: Run | null };
type Snapshot = {
  account: ProfileBannerData | null;
  boundary: number;
  publicBoundary: number;
  coveredPrefixCount: number;
  previewComplete: boolean;
  previewRun: Run | null;
  ranges: Range[];
  latestRun: Run | null;
  rangeRequest: RangeRequest | null;
};
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
  const [previewRun, setPreviewRun] = useState<Run | null>(null);
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
  const shownBoundary = useRef(0);
  const submitting = useRef(false);
  const previewStarted = useRef(false);
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
    const result = await ioJson<{ posts: TweetData[]; boundary?: number }>(`${base}/posts?${query}`);
    if (mounted.current && viewing.current === version) { setPosts(result.posts); setView(range ? `${range.startAt} — ${range.endAt}` : "prefix"); if (!range) shownBoundary.current = result.boundary ?? result.posts.length; }
  }, [base]);
  const showRunPosts = useCallback(async (currentRun: Run, reset = false) => {
    const baseline = currentRun.base_boundary ?? 0;
    const afterRank = reset ? baseline : Math.max(baseline, shownBoundary.current);
    const version = ++viewing.current;
    const query = new URLSearchParams({
      view: "delta",
      runId: currentRun.id,
      afterRank: String(afterRank),
    }).toString();
    const result = await ioJson<{ posts: TweetData[]; boundary: number }>(`${base}/posts?${query}`);
    if (!mounted.current || viewing.current !== version) return;
    setPosts(previous => {
      const combined = reset ? result.posts : [...previous, ...result.posts];
      return [...new Map(combined.map(post => [post.post_id, post])).values()].sort((a, b) =>
        Date.parse(a.created_at) - Date.parse(b.created_at) || a.post_id.localeCompare(b.post_id));
    });
    setView(`run:${currentRun.id}`);
    shownBoundary.current = Math.max(afterRank, result.boundary ?? afterRank);
  }, [base]);
  const startPreview = useCallback(async () => {
    if (previewStarted.current) return;
    previewStarted.current = true;
    try {
      const result = await ioJson<
        | { kind: "queued"; run: Run }
        | { kind: "ready"; publicBoundary: number }
      >("/api/io/previews", ioPost({ username }));
      if (result.kind === "queued") {
        if (mounted.current) setPreviewRun(result.run);
        return;
      }
      const data = await loadSnapshot();
      if (data.publicBoundary > 0) await showPosts();
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : "Couldn’t prepare the free preview");
    }
  }, [username, loadSnapshot, showPosts]);
  useEffect(() => {
    if (authLoading) return;
    let canceled = false;
    (async () => {
      try {
        const data = await loadSnapshot();
        if (canceled) return;
        const currentRun = user ? data.latestRun : null;
        setRun(currentRun);
        setRangeRequest(user ? data.rangeRequest : null);
        setPreviewRun(data.previewRun?.id === data.latestRun?.id ? null : data.previewRun);
        if (currentRun && active(currentRun.status) && currentRun.base_boundary != null) {
          shownBoundary.current = currentRun.base_boundary;
          setPosts([]);
          await showRunPosts(currentRun, true);
        } else if (data.publicBoundary > 0 || (user && data.boundary > 0)) await showPosts();
        else if (user && data.ranges.length) await showPosts(data.ranges[0]);
        if (!data.account?.protected && !data.previewComplete && !data.previewRun) {
          await startPreview();
        }
      } catch (e) { if (!canceled) setError(e instanceof Error ? e.message : "Couldn’t load this account"); }
      finally { if (!canceled) setLoading(false); }
    })();
    return () => { canceled = true; };
  }, [authLoading, user, loadSnapshot, showPosts, showRunPosts, startPreview]);
  const previewRunId = previewRun?.id;
  const previewRunStatus = previewRun?.status;
  useEffect(() => {
    if (!previewRunId || !active(previewRunStatus)) return;
    let canceled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const data = await ioJson<{ run: Run }>(`/api/io/previews/${previewRunId}`);
        if (canceled) return;
        setPreviewRun(data.run);
        if (active(data.run.status) && (data.run.unique_count ?? 0) > shownBoundary.current) {
          const next = await loadSnapshot();
          if (next.publicBoundary > shownBoundary.current) await showPosts();
        }
        if (data.run.status === "succeeded") {
          const next = await loadSnapshot();
          if (next.publicBoundary > 0) {
            await showPosts();
            setNotice(`Showing the earliest ${next.publicBoundary.toLocaleString("en-US")} posts.`);
          } else if (!next.previewComplete) {
            previewStarted.current = false;
            await startPreview();
          }
        }
      } catch (e) {
        if (!canceled) setError(e instanceof Error ? e.message : "Couldn’t check preview progress");
      }
      if (!canceled) timer = setTimeout(poll, 2000);
    };
    timer = setTimeout(poll, 500);
    return () => { canceled = true; clearTimeout(timer); };
  }, [previewRunId, previewRunStatus, loadSnapshot, showPosts, startPreview]);
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
        if (!data.shared && (data.run.granted_boundary ?? 0) > shownBoundary.current) {
          const next = await loadSnapshot();
          await showRunPosts(data.run);
          const added = Math.max(0, next.boundary - (data.run.base_boundary ?? 0));
          setNotice(active(data.run.status)
            ? `Showing ${added.toLocaleString("en-US")} newly confirmed posts. Unlocking continues.`
            : `Showing ${added.toLocaleString("en-US")} posts confirmed in this unlock.`);
        }
        if (data.run.status === "succeeded") {
          const next = await loadSnapshot();
          if (!data.shared) { await showRunPosts(data.run); setNotice(next.latestRun?.accountExhausted ? `All ${next.boundary.toLocaleString("en-US")} available posts are now unlocked.` : "Unlock complete."); }
          else setNotice("Posts are ready. Select Unlock to add them to your accessible range.");
        }
      } catch (e) { if (!canceled) setError(e instanceof Error ? e.message : "Couldn’t check progress"); }
      if (!canceled) timer = setTimeout(poll, 2000);
    };
    timer = setTimeout(poll, 500);
    return () => { canceled = true; clearTimeout(timer); };
  }, [runId, runStatus, loadSnapshot, showRunPosts]);
  useEffect(() => {
    if (!rangeId || !active(rangeStatus)) return;
    let canceled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const data = await ioJson<{ rangeRequest: RangeRequest }>(`/api/io/range-requests/${rangeId}`);
        if (canceled) return;
        setRangeRequest(data.rangeRequest);
        if (data.rangeRequest.status === "succeeded") { await loadSnapshot(); await showPosts(data.rangeRequest); setNotice("Date range unlocked."); }
      } catch (e) { if (!canceled) setError(e instanceof Error ? e.message : "Couldn’t check progress"); }
      if (!canceled) timer = setTimeout(poll, 2000);
    };
    timer = setTimeout(poll, 500);
    return () => { canceled = true; clearTimeout(timer); };
  }, [rangeId, rangeStatus, loadSnapshot, showPosts]);
  const previewWorking = active(previewRun?.status);
  const working = busy || previewWorking || active(run?.status) || active(rangeRequest?.status);
  async function unlock(range?: Range) {
    if (working || submitting.current || !user) return;
    const label = range ? "the selected date range" : snapshot?.boundary ? "up to the next 1,000 posts" : "up to the earliest 1,000 posts";
    if (!window.confirm(`Unlock ${label} from @${username}? If needed, STELA will fetch posts from an external data provider.`)) return;
    submitting.current = true; setBusy(true); setError(""); setNotice("");
    try {
      if (range) {
        const result = await ioJson<{ kind: string; range: Range; requestId?: string; run?: Run }>("/api/io/unlocks/range", ioPost({ username, ...range }));
        if (result.kind === "granted") { await loadSnapshot(); await showPosts(result.range); setNotice("Date range unlocked."); }
        else if (result.requestId) setRangeRequest({ id: result.requestId, status: "queued", ...result.range, run: result.run });
        else throw new Error("Couldn’t start the request");
      } else {
        const result = await ioJson<{ run: Run; shared: boolean }>("/api/io/unlocks/prefix", ioPost({ username }));
        setShared(result.shared); setRun(result.run);
        const baseline = result.run.base_boundary ?? snapshot?.boundary ?? 0;
        shownBoundary.current = baseline;
        setPosts([]);
        setView(`run:${result.run.id}`);
        setNotice(`Unlocking from post ${(baseline + 1).toLocaleString("en-US")}. Confirmed posts will appear as they arrive.`);
        if (!result.shared) await showRunPosts(result.run, true);
        if (result.run.status === "succeeded") { const next = await loadSnapshot(); if (!result.shared) await showRunPosts(result.run); setNotice(next.latestRun?.accountExhausted ? `All ${next.boundary.toLocaleString("en-US")} available posts are now unlocked.` : "Unlock complete."); }
      }
    } catch (e) { setError(e instanceof Error ? e.message : "Couldn’t unlock posts"); }
    finally { submitting.current = false; setBusy(false); }
  }
  async function viewRange(range?: Range) { setBusy(true); setError(""); try { await showPosts(range); } catch (e) { setError(e instanceof Error ? e.message : "Couldn’t display posts"); } finally { setBusy(false); } }
  async function cancel() { if (!run || shared) return; setBusy(true); try { const data = await ioJson<{ run: Run }>(`/api/io/runs/${run.id}`, { method: "DELETE" }); setRun(data.run); setNotice("Unlock canceled."); } catch (e) { setError(e instanceof Error ? e.message : "Couldn’t cancel the unlock"); } finally { setBusy(false); } }
  const invalid = !/^[a-zA-Z0-9_]{1,15}$/.test(username);
  const accountExhausted = snapshot?.latestRun?.status === "succeeded" && snapshot.latestRun.accountExhausted;
  if (invalid) return <main className="p-8">Invalid username. <Link href="/io">Back to search</Link></main>;
  if (loading) return <main className="mx-auto max-w-7xl px-8 py-14" aria-busy="true"><p className="text-sm text-muted-foreground">Checking account</p><h1 className="mt-3 text-2xl">@{username}</h1><div className="mt-6 h-20 max-w-2xl animate-pulse rounded-lg bg-secondary" /></main>;
  const accountActions = snapshot && !snapshot.account?.protected ? <div className="flex max-w-sm flex-col items-end gap-1.5">
    <div className="flex flex-wrap justify-end gap-2">
      {user ? !accountExhausted && <button disabled={working} onClick={() => void unlock()} className={`${button} bg-white text-black hover:bg-zinc-200`}>{working ? "Working…" : snapshot.boundary ? "Unlock 1,000 more" : "Unlock up to 1,000"}</button> : <><Link className="px-2 py-2 text-sm text-muted-foreground hover:text-foreground" href={`/io/signin?returnTo=${encodeURIComponent(`/io/${username}`)}`}>Sign in</Link><Link className={`${button} bg-white text-black hover:bg-zinc-200`} href={`/io/signin?mode=signup&returnTo=${encodeURIComponent(`/io/${username}`)}`}>Sign up to unlock</Link></>}
    </div>
    <p className="text-right text-[11px] text-muted-foreground">{snapshot.boundary > 0 ? accountExhausted ? `All ${snapshot.boundary.toLocaleString("en-US")} posts unlocked` : `${snapshot.boundary.toLocaleString("en-US")} posts unlocked` : snapshot.publicBoundary > 0 ? `Free preview: ${snapshot.publicBoundary.toLocaleString("en-US")} · ${snapshot.coveredPrefixCount.toLocaleString("en-US")} available` : previewWorking ? "Preparing free preview" : "Free preview: up to 20"}</p>
  </div> : undefined;
  const runView = view.startsWith("run:");
  const runBase = run?.base_boundary ?? snapshot?.boundary ?? 0;
  const grantedEnd = Math.max(
    runBase,
    run?.granted_boundary ?? (run?.status === "succeeded" ? snapshot?.boundary ?? runBase : runBase),
  );
  const confirmedCount = Math.max(0, grantedEnd - runBase);
  const plannedCount = Math.max(0, (run?.target_boundary ?? runBase + (run?.target_count ?? 0)) - runBase);
  let statusMessage = "";
  let statusTone = "text-sky-300";
  let statusMark = "✓";
  let statusTitle: string | undefined;
  if (error) {
    statusMessage = error;
    statusTone = "text-red-400";
    statusMark = "!";
  } else if (previewWorking) {
    statusMessage = previewRun?.status === "queued" ? "Waiting to prepare the free preview" : "Finding the earliest posts";
    statusMark = "●";
    statusTitle = previewRun?.progress_message ?? undefined;
  } else if (previewRun?.status === "failed" && !snapshot?.previewComplete) {
    statusMessage = "Couldn’t prepare the free preview";
    statusTone = "text-red-400";
    statusMark = "!";
    statusTitle = previewRun.error_message ?? undefined;
  } else if (rangeRequest && active(rangeRequest.status)) {
    statusMessage = "Unlocking the selected date range";
    statusMark = "●";
    statusTitle = rangeRequest.run?.progress_message ?? undefined;
  } else if (rangeRequest?.status === "failed") {
    statusMessage = "Couldn’t unlock the selected date range";
    statusTone = "text-red-400";
    statusMark = "!";
    statusTitle = rangeRequest.errorMessage ?? undefined;
  } else if (run?.status === "queued") {
    statusMessage = `Waiting to unlock posts from #${(runBase + 1).toLocaleString("en-US")}`;
    statusMark = "●";
  } else if (run?.status === "running") {
    statusMessage = confirmedCount > 0
      ? `Unlocking from #${(runBase + 1).toLocaleString("en-US")} · ${confirmedCount.toLocaleString("en-US")}${plannedCount ? ` / ${plannedCount.toLocaleString("en-US")}` : ""} confirmed`
      : `Unlocking from #${(runBase + 1).toLocaleString("en-US")} · waiting for the first confirmed post`;
    statusMark = "●";
    statusTitle = run.progress_message ?? undefined;
  } else if (run?.status === "failed") {
    statusMessage = `Unlock failed${confirmedCount ? ` · ${confirmedCount.toLocaleString("en-US")} posts saved` : ""}`;
    statusTone = "text-red-400";
    statusMark = "!";
    statusTitle = run.error_message ?? undefined;
  } else if (run?.status === "canceled") {
    statusMessage = `Unlock canceled${confirmedCount ? ` · ${confirmedCount.toLocaleString("en-US")} posts saved` : ""}`;
    statusTone = "text-muted-foreground";
    statusMark = "■";
  } else if (run?.status === "succeeded") {
    statusMessage = accountExhausted
      ? `Unlock complete · reached the end after adding ${confirmedCount.toLocaleString("en-US")} posts`
      : `Unlock complete${confirmedCount ? ` · ${confirmedCount.toLocaleString("en-US")} posts added` : ""}`;
  } else if (notice) {
    statusMessage = notice;
  }
  return <main className="mx-auto max-w-7xl bg-background text-foreground">
    <ProfileBanner account={snapshot?.account || { username }} compact={posts.length > 0} searchHref="/io" actions={accountActions} />
    <section className="shrink-0 space-y-2 border-b border-border px-5 py-2 md:px-8">
      {statusMessage && <div role={statusTone === "text-red-400" ? "alert" : "status"} title={statusTitle} className="flex h-10 items-center justify-between gap-4"><p className={`min-w-0 truncate text-sm ${statusTone}`}><span className={active(run?.status) || previewWorking || active(rangeRequest?.status) ? "mr-2 inline-block animate-pulse" : "mr-2"}>{statusMark}</span>{statusMessage}</p><div className="flex shrink-0 items-center gap-4 text-xs">{previewRun?.status === "failed" && !snapshot?.previewComplete && <button className="text-red-300 underline underline-offset-4 hover:text-red-200" onClick={() => { previewStarted.current = false; setPreviewRun(null); setError(""); void startPreview(); }}>Retry</button>}{runView && <button disabled={busy} className="text-muted-foreground underline underline-offset-4 hover:text-foreground disabled:opacity-40" onClick={() => void viewRange()}>View all unlocked</button>}{active(run?.status) && !shared && <button disabled={busy} onClick={() => void cancel()} className="text-muted-foreground underline underline-offset-4 hover:text-foreground disabled:opacity-40">Cancel</button>}</div></div>}
      {user && snapshot && !snapshot.account?.protected && <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">Unlock a date range</summary><form className="mt-4 flex flex-wrap items-end gap-3" onSubmit={e => { e.preventDefault(); const a = Date.parse(start), b = Date.parse(end); if (!Number.isFinite(a) || !Number.isFinite(b) || a >= b || b-a > 31*86400000) { setError("Choose an end time after the start, within a 31-day range."); return; } void unlock({ startAt: new Date(a).toISOString(), endAt: new Date(b).toISOString() }); }}><label>Start<input required type="datetime-local" value={start} onChange={e => setStart(e.target.value)} className="mt-1 block rounded border border-border bg-secondary p-2" /></label><label>End<input required type="datetime-local" value={end} onChange={e => setEnd(e.target.value)} className="mt-1 block rounded border border-border bg-secondary p-2" /></label><button disabled={working} className={button}>Unlock range</button></form><p className="mt-2 text-xs text-muted-foreground">Up to 31 days. Times use your device time zone.</p></details>}
      {!!snapshot?.ranges.length && <div className="flex flex-wrap gap-2"><span className="py-2 text-xs text-muted-foreground">Saved ranges</span>{snapshot.ranges.map(r => <button key={r.startAt+r.endAt} disabled={busy} className={button} onClick={() => void viewRange(r)}>{new Date(r.startAt).toLocaleDateString("en-US")} — {new Date(r.endAt).toLocaleDateString("en-US")}</button>)}</div>}
    </section>
    <div>
      {posts.length ? <SavedTimeline key={view} tweets={posts} username={username} totalPostCount={snapshot?.account?.statuses_count} /> : runView ? <section className="flex min-h-[480px] flex-col items-center justify-center border-t border-border px-6 text-center"><p className="text-sm text-sky-300">{active(run?.status) ? `Unlocking posts from #${(runBase + 1).toLocaleString("en-US")}` : "No posts were added in this unlock"}</p><p className="mt-2 text-xs text-muted-foreground">{active(run?.status) ? "Confirmed posts will appear here." : "Return to all unlocked posts to review them."}</p></section> : snapshot?.previewComplete || (user && (snapshot?.boundary || view !== "prefix")) ? <p className="p-8 text-sm text-muted-foreground">No posts are available.</p> : <LockedTimeline unavailable={snapshot?.account?.protected} />}
    </div>
  </main>;
}
