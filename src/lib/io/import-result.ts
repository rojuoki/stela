import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { computeIoCoverageFrontier, type IoCoverageInterval } from "./coverage-frontier";
import { getIoDatabase } from "./db";
import {
  createIoRun,
  insertCoverageWindow,
  updateIoRun,
  upsertIoAccount,
  upsertIoPost,
  withIoTransaction,
} from "./repository";
import type { AcquisitionProvider } from "./providers";

type JsonRecord = Record<string, unknown>;

interface AcceptedWindow extends IoCoverageInterval {
  status: "complete";
  source: JsonRecord;
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function rows(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function completeWindow(row: JsonRecord): AcceptedWindow | null {
  const startAt = text(row.start);
  const endAt = text(row.end);
  const sourceStatus = text(row.status);
  if (!startAt || !endAt || (sourceStatus !== "RESOLVED" && sourceStatus !== "COMPLETE")) {
    return null;
  }
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return null;
  return { startAt, endAt, status: "complete", source: row };
}

function timestampIsInWindows(createdAt: string, windows: readonly AcceptedWindow[]): boolean {
  const value = Date.parse(createdAt);
  return Number.isFinite(value) && windows.some((window) =>
    value >= Date.parse(window.startAt) && value < Date.parse(window.endAt),
  );
}

/**
 * A prefix extension may only bring in windows attached to the current proven
 * frontier. Later islands are deliberately discarded: they confuse prefix
 * planning and must be acquired later through the missing interval.
 */
function connectedPrefixExtensionWindows(input: {
  accountId: string;
  provider: string;
  requestedStartAt: string | null;
  incoming: JsonRecord[];
}): { windows: AcceptedWindow[]; rejection: string | null } {
  if (!input.requestedStartAt) {
    return { windows: [], rejection: "prefix_extend result has no collect_start" };
  }
  const account = getIoDatabase()
    .prepare("SELECT created_at FROM accounts WHERE account_id = ?")
    .get(input.accountId) as { created_at: string | null } | undefined;
  if (!account?.created_at) {
    return { windows: [], rejection: "prefix_extend account has no existing coverage baseline" };
  }
  const existing = getIoDatabase().prepare(
    `SELECT cw.start_at AS startAt, cw.end_at AS endAt
     FROM coverage_windows cw
     JOIN acquisition_runs run ON run.id = cw.run_id
     WHERE cw.account_id = ? AND run.provider = ? AND cw.status = 'complete'
     ORDER BY cw.start_at ASC, cw.end_at ASC`,
  ).all(input.accountId, input.provider) as unknown as IoCoverageInterval[];
  const existingFrontier = computeIoCoverageFrontier(account.created_at, existing);
  if (!existingFrontier) {
    return { windows: [], rejection: "prefix_extend existing coverage frontier is invalid" };
  }
  if (Date.parse(input.requestedStartAt) !== Date.parse(existingFrontier.frontierAt)) {
    return {
      windows: [],
      rejection: `prefix_extend collect_start does not join current frontier (${existingFrontier.frontierAt})`,
    };
  }

  let frontier = Date.parse(existingFrontier.frontierAt);
  const accepted: AcceptedWindow[] = [];
  for (const window of input.incoming.map(completeWindow).filter((row): row is AcceptedWindow => !!row)
    .sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt))) {
    const start = Date.parse(window.startAt);
    const end = Date.parse(window.endAt);
    if (end <= frontier || start > frontier) continue;
    accepted.push(window);
    frontier = Math.max(frontier, end);
  }
  return { windows: accepted, rejection: null };
}

export interface ImportedAcquisitionResult {
  runId: string;
  username: string;
  accountId: string;
  postCount: number;
  candidateCount: number;
}

function detectProvider(
  payload: JsonRecord,
  override?: AcquisitionProvider,
): AcquisitionProvider {
  if (override) return override;
  if (text(payload.provider) === "twscrape" || text(payload.twscrape_version)) {
    return "twscrape";
  }
  return "twitterapi_io";
}

export function importAcquisitionResult(
  inputPath: string,
  existingRunId?: string,
  providerOverride?: AcquisitionProvider,
  options: { progressOnly?: boolean } = {},
): ImportedAcquisitionResult {
  const absolutePath = path.resolve(inputPath);
  const payload = record(JSON.parse(fs.readFileSync(absolutePath, "utf8")));
  const profile = record(payload.profile);
  const result = record(payload.result);
  const metrics = record(payload.metrics);
  const config = record(payload.config);
  const provider = detectProvider(payload, providerOverride);
  const collectionMode = text(config.collection_mode) || "oldest_n";
  const requestedStartAt = text(config.collect_start);
  const username = (text(payload.username) || text(profile.username) || "").toLowerCase();
  const accountId = text(profile.account_id) || text(profile.id);
  if (!username || !accountId) {
    throw new Error("Result JSON is missing username or profile.account_id");
  }

  const runId = existingRunId || randomUUID();
  if (!existingRunId) {
    createIoRun({
      id: runId,
      username,
      provider,
      collectionMode,
      targetCount: number(config.target_count) || null,
      requestedStartAt,
      outputPath: absolutePath,
    });
  }

  const candidates = rows(payload.candidate_posts).length
    ? rows(payload.candidate_posts)
    : rows(payload.posts);
  const now = new Date().toISOString();
  const payloadWindows = rows(payload.windows);
  const prefixExtension = collectionMode === "prefix_extend";
  const connected = prefixExtension
    ? connectedPrefixExtensionWindows({
      accountId,
      provider,
      requestedStartAt,
      incoming: payloadWindows,
    })
    : null;
  const acceptedWindows = connected?.windows || [];
  let importedCandidateCount = 0;

  withIoTransaction(() => {
    upsertIoAccount({
      accountId,
      username,
      displayName: text(profile.display_name),
      avatarUrl: text(profile.avatar_url),
      coverUrl: text(profile.cover_url),
      description: text(profile.description),
      createdAt: text(profile.created_at),
      protected: Boolean(profile.protected),
      followersCount: number(profile.followers_count),
      followingCount: number(profile.following_count),
      statusesCount: number(profile.statuses_count),
      fetchedAt: now,
    });

    if (connected?.rejection) {
      // A disconnected prefix extension has no reusable acquisition value.
      // Unlike an operational worker failure, keep neither artifacts nor a
      // run-history row: the next request must plan the missing gap instead.
      getIoDatabase().prepare("DELETE FROM acquisition_runs WHERE id = ?").run(runId);
      return;
    }

    for (const post of candidates) {
      const postId = text(post.post_id) || text(post.id);
      const createdAt = text(post.created_at) || text(post.date);
      if (!postId || !createdAt) continue;
      if (prefixExtension && !timestampIsInWindows(createdAt, acceptedWindows)) continue;
      upsertIoPost({
        postId,
        accountId,
        authorUsername: text(post.author_username) || username,
        createdAt,
        fullText: text(post.text) || text(post.full_text) || "",
        url: text(post.url),
        language: text(post.language),
        media: Array.isArray(post.media) ? post.media : [],
        mentions: Array.isArray(post.mentions)
          ? post.mentions.filter((item): item is string => typeof item === "string")
          : [],
        likeCount: number(post.like_count),
        retweetCount: number(post.retweet_count),
        replyCount: number(post.reply_count),
        quoteCount: number(post.quote_count),
        viewCount: number(post.view_count),
        conversationId: text(post.conversation_id),
        inReplyToPostId: text(post.in_reply_to_post_id) || text(post.in_reply_to_tweet_id),
        inReplyToUserId: text(post.in_reply_to_user_id),
        inReplyToUsername: text(post.in_reply_to_username),
        provider: text(post.provider) || provider,
        sourceRunId: runId,
        coverageState:
          post.seen_in_resolved_window || post.seen_in_complete_result
            ? "covered"
            : "candidate",
        candidateSightings: number(post.candidate_sightings) || 1,
        fetchedAt: now,
      });
      importedCandidateCount += 1;
    }

    const windowsToImport = prefixExtension
      ? acceptedWindows.map((window) => window.source)
      : payloadWindows;
    for (const window of windowsToImport) {
      const startAt = text(window.start);
      const endAt = text(window.end);
      if (!startAt || !endAt) continue;
      const sourceStatus = text(window.status);
      const status =
        sourceStatus === "RESOLVED" || sourceStatus === "COMPLETE"
          ? "complete"
          : sourceStatus === "PARTIAL"
            ? "partial"
            : "unknown";
      insertCoverageWindow({
        runId,
        accountId,
        startAt,
        endAt,
        status,
        resolutionBasis: text(window.resolution_basis),
        terminationReason: text(window.termination_reason),
        requestCount: number(window.requests),
        pageCount: number(window.pages),
        uniqueCount: number(window.unique_post_count),
      });
    }

    updateIoRun(runId, {
      account_id: accountId,
      status: options.progressOnly
        ? "running"
        : text(result.status) === "INCOMPLETE"
          ? "failed"
          : "succeeded",
      progress_message:
        text(result.progress_message) || text(result.status) || "Imported",
      request_count: number(metrics.total_requests ?? metrics.total_request_calls),
      page_count: number(metrics.total_pages),
      unique_count: number(result.unique_post_count),
      candidate_count: candidates.length,
      duplicate_count: number(metrics.duplicate_sightings),
      output_path: absolutePath,
      error_message: options.progressOnly ? null : text(result.error),
      started_at: existingRunId ? undefined : now,
      finished_at: options.progressOnly ? undefined : now,
    });
  });

  return {
    runId,
    username,
    accountId,
    postCount: connected?.rejection ? 0 : number(result.unique_post_count),
    candidateCount: importedCandidateCount,
  };
}

export function importAcquisitionProgress(
  inputPath: string,
  existingRunId: string,
  providerOverride?: AcquisitionProvider,
): ImportedAcquisitionResult {
  return importAcquisitionResult(
    inputPath,
    existingRunId,
    providerOverride,
    { progressOnly: true },
  );
}

// Keep the existing CLI/import call site compatible while the prototype moves
// to provider-neutral naming.
export function importTwitterApiIoResult(
  inputPath: string,
  existingRunId?: string,
): ImportedAcquisitionResult {
  return importAcquisitionResult(inputPath, existingRunId, "twitterapi_io");
}
