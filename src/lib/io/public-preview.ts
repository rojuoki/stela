import { getIoCoveredPrefixSummary, getIoPgAccountByUsername } from "./pg-cache";
import { ioPgQuery } from "./pg-db";
import {
  createIoPgRun,
  getActiveIoPgRunForUsername,
  getIoPgRun,
  type IoPgRun,
} from "./pg-runs";

export const IO_PUBLIC_PREVIEW_LIMIT = 20;
export const IO_PUBLIC_PREVIEW_TARGET = 1;
const PROVIDER = "twitterapi_io";

export interface IoPublicRun {
  id: string;
  username: string;
  collection_mode: string;
  status: string;
  progress_message: string | null;
  request_count: number;
  page_count: number;
  unique_count: number;
  candidate_count: number;
  error_message: string | null;
}

export interface IoPublicPreviewState {
  publicBoundary: number;
  coveredPrefixCount: number;
  complete: boolean;
  run: IoPublicRun | null;
}

export function toIoPublicRun(run: IoPgRun): IoPublicRun {
  return {
    id: run.id,
    username: run.username,
    collection_mode: run.collection_mode,
    status: run.status,
    progress_message: run.progress_message,
    request_count: run.request_count,
    page_count: run.page_count,
    unique_count: run.unique_count,
    candidate_count: run.candidate_count,
    error_message: run.error_message,
  };
}

async function latestPreviewRun(username: string): Promise<IoPgRun | null> {
  const result = await ioPgQuery<{ id: string }>(
    `SELECT id FROM acquisition_runs
     WHERE LOWER(username) = LOWER($1) AND collection_mode = 'prefix_preview'
     ORDER BY created_at DESC LIMIT 1`,
    [username],
  );
  return result.rows[0] ? getIoPgRun(result.rows[0].id) : null;
}

export async function getIoPublicPreviewState(username: string): Promise<IoPublicPreviewState> {
  const account = await getIoPgAccountByUsername(username);
  const [summary, active, latest] = await Promise.all([
    account ? getIoCoveredPrefixSummary(account.account_id, PROVIDER) : null,
    getActiveIoPgRunForUsername(username),
    latestPreviewRun(username),
  ]);
  const coveredPrefixCount = summary?.coveredPostCount ?? 0;
  const prefixActive = active
    && ["prefix_preview", "prefix_initial", "prefix_extend"].includes(active.collection_mode)
    ? active
    : null;
  return {
    publicBoundary: Math.min(IO_PUBLIC_PREVIEW_LIMIT, coveredPrefixCount),
    coveredPrefixCount,
    complete: coveredPrefixCount > 0 || latest?.status === "succeeded",
    run: coveredPrefixCount > 0
      ? null
      : prefixActive
        ? toIoPublicRun(prefixActive)
        : latest?.status === "failed"
          ? toIoPublicRun(latest)
          : null,
  };
}

export async function requestIoPublicPreview(username: string): Promise<
  | ({ kind: "ready" } & IoPublicPreviewState)
  | { kind: "queued"; run: IoPublicRun; reused: boolean }
> {
  const state = await getIoPublicPreviewState(username);
  if (state.complete) return { kind: "ready", ...state };
  if (state.run && ["queued", "running"].includes(state.run.status)) {
    return { kind: "queued", run: state.run, reused: true };
  }

  const account = await getIoPgAccountByUsername(username);
  if (!account) throw new Error("Account profile is not available");
  const summary = await getIoCoveredPrefixSummary(account.account_id, PROVIDER);
  const unrelatedActive = await getActiveIoPgRunForUsername(username);
  if (unrelatedActive && !["prefix_preview", "prefix_initial", "prefix_extend"].includes(unrelatedActive.collection_mode)) {
    throw new Error("The free preview will begin after the current request finishes.");
  }
  try {
    const run = await createIoPgRun({
      accountId: account.account_id,
      username: account.username,
      requestedByUserId: null,
      provider: PROVIDER,
      collectionMode: "prefix_preview",
      targetCount: IO_PUBLIC_PREVIEW_TARGET,
      requestedStartAt: summary && summary.frontier.frontierAt !== summary.frontier.startsAt
        ? summary.frontier.frontierAt
        : null,
    });
    return { kind: "queued", run: toIoPublicRun(run), reused: false };
  } catch (error) {
    const active = await getActiveIoPgRunForUsername(username);
    if (!active || !["prefix_preview", "prefix_initial", "prefix_extend"].includes(active.collection_mode)) {
      throw error;
    }
    return { kind: "queued", run: toIoPublicRun(active), reused: true };
  }
}

export async function getIoPublicPreviewRun(id: string): Promise<IoPublicRun | null> {
  const run = await getIoPgRun(id);
  if (!run || !["prefix_preview", "prefix_initial", "prefix_extend"].includes(run.collection_mode)) {
    return null;
  }
  return toIoPublicRun(run);
}
