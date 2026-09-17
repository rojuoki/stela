import { getIoPgAccountByUsername, getIoCoveredPrefixSummary } from "./pg-cache";
import {
  createIoPgRun,
  getActiveIoPgRunForUserAndUsername,
  getActiveIoPgRunForUsername,
  type CreateIoPgRunInput,
  type IoPgRun,
} from "./pg-runs";
import { getIoUnlockBoundary } from "./pg-users";
import { planIoPrefixExtension, IO_PREFIX_BLOCK_SIZE } from "./prefix-planning";

export type IoPrefixRequestResult =
  | { kind: "queued"; run: IoPgRun; reused: boolean; shared: boolean };

async function queueAcquisitionOrReuse(
  input: CreateIoPgRunInput,
  requestingUserId: string,
): Promise<IoPrefixRequestResult> {
  try {
    const run = await createIoPgRun(input);
    return { kind: "queued", run, reused: false, shared: false };
  } catch (error) {
    const active = await getActiveIoPgRunForUsername(input.username);
    if (!active) throw error;
    return {
      kind: "queued",
      run: active,
      reused: true,
      shared: active.requested_by_user_id !== requestingUserId,
    };
  }
}

/**
 * One authenticated entry point for initial prefix Unlock and +1000 Extend.
 * The provider is intentionally fixed for the first product surface; fallback
 * policy is an explicit later decision, never an accidental retry behavior.
 */
export async function requestIoPrefixUnlock(input: {
  userId: string;
  username: string;
  provider?: "twitterapi_io";
}): Promise<IoPrefixRequestResult> {
  const provider = input.provider ?? "twitterapi_io";
  const account = await getIoPgAccountByUsername(input.username);
  const ownActive = await getActiveIoPgRunForUserAndUsername(input.userId, input.username);
  if (ownActive) return { kind: "queued", run: ownActive, reused: true, shared: false };
  const active = await getActiveIoPgRunForUsername(input.username);
  if (active) {
    return {
      kind: "queued",
      run: active,
      reused: true,
      shared: active.requested_by_user_id !== input.userId,
    };
  }

  if (!account) {
    return queueAcquisitionOrReuse({
      username: input.username,
      requestedByUserId: input.userId,
      provider,
      collectionMode: "prefix_initial",
      targetCount: IO_PREFIX_BLOCK_SIZE,
      baseBoundary: 0,
      targetBoundary: IO_PREFIX_BLOCK_SIZE,
    }, input.userId);
  }

  const currentBoundary = await getIoUnlockBoundary(input.userId, account.account_id);
  const summary = await getIoCoveredPrefixSummary(account.account_id, provider);
  // A known account with no proven cache gets a fresh initial acquisition. A
  // user who already has access never falls back to this path silently.
  if (!summary || summary.coveredPostCount === 0) {
    if (currentBoundary > 0) {
      throw new Error("Account coverage no longer supports the current unlock boundary");
    }
    return queueAcquisitionOrReuse({
      accountId: account.account_id,
      username: account.username,
      requestedByUserId: input.userId,
      provider,
      collectionMode: "prefix_initial",
      targetCount: IO_PREFIX_BLOCK_SIZE,
      baseBoundary: 0,
      targetBoundary: IO_PREFIX_BLOCK_SIZE,
    }, input.userId);
  }

  const plan = await planIoPrefixExtension(input.userId, account.account_id, provider);
  if (plan.strategy === "cache-only") {
    const run = await createIoPgRun({
      accountId: account.account_id,
      username: account.username,
      requestedByUserId: input.userId,
      provider,
      collectionMode: "prefix_grant",
      targetCount: IO_PREFIX_BLOCK_SIZE,
      baseBoundary: plan.baseBoundary,
      targetBoundary: plan.targetBoundary,
    });
    return { kind: "queued", run, reused: true, shared: false };
  }

  return queueAcquisitionOrReuse({
    accountId: account.account_id,
    username: account.username,
    requestedByUserId: input.userId,
    provider,
    collectionMode: "prefix_extend",
    targetCount: plan.acquisitionTargetCount,
    baseBoundary: plan.baseBoundary,
    targetBoundary: plan.targetBoundary,
    requestedStartAt: plan.collectStartAt,
  }, input.userId);
}
