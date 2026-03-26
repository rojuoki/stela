"use client";

import { useState, useEffect, useRef, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { JobStatus } from "../../components/JobStatus";
import { apiFetch } from "../../lib/apiFetch";
import { useUser } from "../../contexts/UserContext";
import type { Status, JobPhase } from "../../components/types";

const POLL_INTERVAL_MS = 2500;
const MIN_EXCAVATING_MS = 3000;

interface JobResponse {
  jobId: string;
  status: "queued" | "running" | "waiting_rate_limit" | "succeeded" | "failed" | "canceled";
  username: string;
  fetchedCount: number;
  apiCalls: number;
  resumeAt?: string | null;
  queuePosition?: number | null;
  error?: { code: string; message: string };
  result?: {
    accountId: string;
    fetchedCount: number;
    stopReason: string;
    previousBoundary?: number;
    finalBoundary?: number;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function ExcavatingContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { refreshCredits } = useUser();

  const flow = searchParams.get("flow");
  const username = searchParams.get("username");
  const jobIdParam = searchParams.get("jobId");

  const [status, setStatus] = useState<Status>("running");
  const [jobPhase, setJobPhase] = useState<JobPhase>("running");
  const [jobInfo, setJobInfo] = useState("Starting...");
  const [error, setError] = useState<string | null>(null);
  const [resumeAt, setResumeAt] = useState<string | null>(null);

  const startedAtRef = useRef(Date.now());
  const initiatedRef = useRef(false);

  const ensureMinTime = async () => {
    const elapsed = Date.now() - startedAtRef.current;
    if (elapsed < MIN_EXCAVATING_MS) {
      await sleep(MIN_EXCAVATING_MS - elapsed);
    }
  };

  const navigateToResults = (
    targetUsername: string,
    rangeStart: number,
    rangeEnd: number,
  ) => {
    router.replace(
      `/user/${encodeURIComponent(targetUsername)}?rangeStart=${rangeStart}&rangeEnd=${rangeEnd}`,
    );
  };

  const navigateBack = () => {
    if (username) {
      router.replace(`/user/${encodeURIComponent(username)}`);
    } else {
      router.replace("/");
    }
  };

  // Poll a job until terminal state, then call onSuccess callback
  const pollJob = async (jobId: string, onSuccess: (job: JobResponse) => void) => {
    const tick = async (): Promise<void> => {
      try {
        const res = await apiFetch(`/api/jobs/${jobId}`);

        if (res.status === 404) {
          setStatus("failed");
          setError("Job not found — may have expired");
          setJobPhase(null);
          return;
        }

        if (!res.ok) {
          setJobInfo(`Polling error (HTTP ${res.status}) — retrying…`);
          await sleep(POLL_INTERVAL_MS);
          return tick();
        }

        const job: JobResponse = await res.json();

        if (job.status === "succeeded") {
          setJobInfo("Finishing up...");
          await ensureMinTime();
          refreshCredits();
          onSuccess(job);
          return;
        }

        if (job.status === "failed") {
          setStatus("failed");
          setError(job.error?.message || "Excavation failed");
          setJobPhase(null);
          setResumeAt(null);
          return;
        }

        if (job.status === "canceled") {
          setStatus("failed");
          setError("Job was canceled");
          setJobPhase(null);
          return;
        }

        if (job.status === "waiting_rate_limit") {
          setJobPhase("waiting_rate_limit");
          setResumeAt(job.resumeAt ?? null);
          setJobInfo(`API calls: ${job.apiCalls}`);
        } else if (job.status === "queued") {
          setJobPhase("queued");
          setResumeAt(null);
          const pos = job.queuePosition;
          setJobInfo(
            pos != null
              ? `Position ${pos} in queue — waiting for slot…`
              : `Waiting for slot…`,
          );
        } else {
          setJobPhase("running");
          setResumeAt(null);
          setJobInfo(`Excavating… (API calls: ${job.apiCalls})`);
        }

        await sleep(POLL_INTERVAL_MS);
        return tick();
      } catch {
        setJobInfo("Network error — retrying…");
        await sleep(POLL_INTERVAL_MS);
        return tick();
      }
    };

    await tick();
  };

  // ── Extend flows ────────────────────────────────────────────────────────

  const handleExtendGranted = async () => {
    const raw = sessionStorage.getItem("stela-extend-result");
    sessionStorage.removeItem("stela-extend-result");

    if (!raw || !username) {
      setStatus("failed");
      setError("Session expired. Please try again.");
      setJobPhase(null);
      return;
    }

    let result: {
      boundary: { previous: number; new: number };
      range: { start: number; end: number; count: number; rangeString: string };
    };
    try {
      result = JSON.parse(raw);
    } catch {
      setStatus("failed");
      setError("Invalid session data. Please try again.");
      setJobPhase(null);
      return;
    }

    setJobInfo(`Processing ${result.range.count} posts...`);
    await ensureMinTime();
    refreshCredits();
    navigateToResults(username, result.range.start, result.range.end);
  };

  const handleExtendJob = async (jobId: string) => {
    setJobInfo("Excavating additional posts...");
    setJobPhase("running");

    const raw = sessionStorage.getItem("stela-extend-result");
    let previousBoundary = 0;
    if (raw) {
      try {
        const data = JSON.parse(raw);
        previousBoundary = data.previousBoundary ?? 0;
      } catch { /* ignore */ }
      sessionStorage.removeItem("stela-extend-result");
    }

    await pollJob(jobId, (job) => {
      const prevBound = job.result?.previousBoundary ?? previousBoundary;
      const finalBound = job.result?.finalBoundary ?? prevBound;
      navigateToResults(username!, prevBound + 1, finalBound);
    });
  };

  // ── Initial excavation flows ──────────────────────────────────────────

  const handleInitialCached = async () => {
    setJobInfo("Unlocking...");
    await ensureMinTime();
    refreshCredits();
    router.replace(`/user/${encodeURIComponent(username!)}`);
  };

  const handleInitialJob = async (jobId: string) => {
    setJobInfo("Excavating earliest posts...");
    setJobPhase("running");

    await pollJob(jobId, () => {
      router.replace(`/user/${encodeURIComponent(username!)}`);
    });
  };

  // ── Main orchestration: runs once on mount ────────────────────────────

  useEffect(() => {
    if (initiatedRef.current) return;
    initiatedRef.current = true;

    if (!username || !flow) {
      setStatus("failed");
      setError("Missing parameters");
      setJobPhase(null);
      return;
    }

    if (flow === "extend-granted") {
      handleExtendGranted();
    } else if (flow === "extend" && jobIdParam) {
      handleExtendJob(jobIdParam);
    } else if (flow === "initial-cached") {
      handleInitialCached();
    } else if (flow === "initial" && jobIdParam) {
      handleInitialJob(jobIdParam);
    } else {
      setStatus("failed");
      setError("Unknown flow");
      setJobPhase(null);
    }
  }, []);

  const isError = status === "failed";

  return (
    <main className="max-w-2xl mx-auto px-4 py-12">
      <div className="mb-8">
        <Link
          href={username ? `/user/${encodeURIComponent(username)}` : "/"}
          className="text-zinc-400 hover:text-white transition-colors text-sm inline-flex items-center gap-2"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          Back to @{username || "Stela"}
        </Link>
      </div>

      {username && (
        <div className="mb-6 text-center">
          <h1 className="text-xl font-bold text-white">@{username}</h1>
          <p className="text-sm text-zinc-500 mt-1">
            {flow?.startsWith("extend") ? "Additional excavation" : "Excavating earliest posts"}
          </p>
        </div>
      )}

      {!isError && (
        <JobStatus
          status={status}
          jobPhase={jobPhase}
          jobInfo={jobInfo}
          error={null}
          credits={0}
          cacheHit={false}
          resumeAt={resumeAt}
        />
      )}

      <div className="border border-zinc-800 rounded-xl min-h-[200px] flex items-center justify-center">
        {isError ? (
          <div className="text-center px-6 max-w-md">
            <svg
              className="w-12 h-12 mx-auto text-red-500 mb-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"
              />
            </svg>
            <p className="text-red-300 font-medium mb-2">{error}</p>
            <button
              onClick={navigateBack}
              className="mt-4 bg-zinc-800 text-zinc-300 font-medium px-4 py-2 rounded-lg hover:bg-zinc-700 transition-colors"
            >
              Go back
            </button>
          </div>
        ) : (
          <div className="text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white mx-auto mb-4" />
            <p className="text-zinc-400 text-sm">
              {jobInfo || "Excavating..."}
            </p>
          </div>
        )}
      </div>
    </main>
  );
}

export default function ExcavatingPage() {
  return (
    <Suspense
      fallback={
        <main className="max-w-2xl mx-auto px-4 py-12">
          <div className="border border-zinc-800 rounded-xl min-h-[200px] flex items-center justify-center">
            <div className="text-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white mx-auto mb-4" />
              <p className="text-zinc-400 text-sm">Loading...</p>
            </div>
          </div>
        </main>
      }
    >
      <ExcavatingContent />
    </Suspense>
  );
}
