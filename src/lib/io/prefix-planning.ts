import { getIoCoveredPrefixSummary } from "./pg-cache";
import { getIoUnlockBoundary } from "./pg-users";

export const IO_PREFIX_BLOCK_SIZE = 1000;

export interface IoPrefixExtensionPlan {
  userId: string;
  accountId: string;
  provider: string;
  baseBoundary: number;
  targetBoundary: number;
  availableBoundary: number;
  missingCount: number;
  strategy: "cache-only" | "acquisition";
  collectStartAt: string | null;
  acquisitionTargetCount: number;
}

export function buildIoPrefixExtensionPlan(input: {
  userId: string;
  accountId: string;
  provider: string;
  currentBoundary: number;
  availableBoundary: number;
  frontierAt: string;
  blockSize?: number;
}): IoPrefixExtensionPlan {
  const blockSize = input.blockSize ?? IO_PREFIX_BLOCK_SIZE;
  if (!Number.isInteger(input.currentBoundary) || input.currentBoundary < 0) {
    throw new Error("Current unlock boundary must be a non-negative integer");
  }
  if (!Number.isInteger(input.availableBoundary) || input.availableBoundary < 0) {
    throw new Error("Available covered boundary must be a non-negative integer");
  }
  if (!Number.isInteger(blockSize) || blockSize <= 0) {
    throw new Error("Prefix block size must be a positive integer");
  }
  if (!Number.isFinite(Date.parse(input.frontierAt))) {
    throw new Error("Coverage frontier must be a valid timestamp");
  }

  const targetBoundary = input.currentBoundary + blockSize;
  const missingCount = Math.max(0, targetBoundary - input.availableBoundary);
  const strategy = missingCount === 0 ? "cache-only" : "acquisition";
  return {
    userId: input.userId,
    accountId: input.accountId,
    provider: input.provider,
    baseBoundary: input.currentBoundary,
    targetBoundary,
    availableBoundary: input.availableBoundary,
    missingCount,
    strategy,
    collectStartAt: strategy === "acquisition" ? input.frontierAt : null,
    acquisitionTargetCount: missingCount,
  };
}

/** Plans a +1000 request from user entitlement and proven shared coverage. */
export async function planIoPrefixExtension(
  userId: string,
  accountId: string,
  provider: string,
): Promise<IoPrefixExtensionPlan> {
  const [currentBoundary, summary] = await Promise.all([
    getIoUnlockBoundary(userId, accountId),
    getIoCoveredPrefixSummary(accountId, provider),
  ]);
  if (!summary) {
    throw new Error("Account creation time or complete coverage is not available");
  }
  return buildIoPrefixExtensionPlan({
    userId,
    accountId,
    provider,
    currentBoundary,
    availableBoundary: summary.coveredPostCount,
    frontierAt: summary.frontier.frontierAt,
  });
}
