import assert from "node:assert/strict";
import { buildIoPrefixExtensionPlan } from "../src/lib/io/prefix-planning";

const cacheOnly = buildIoPrefixExtensionPlan({
  userId: "user-1", accountId: "account-1", provider: "twitterapi_io",
  currentBoundary: 1000, availableBoundary: 2500,
  frontierAt: "2024-01-20T00:00:00Z",
});
assert.equal(cacheOnly.targetBoundary, 2000);
assert.equal(cacheOnly.strategy, "cache-only");
assert.equal(cacheOnly.collectStartAt, null);

const acquisition = buildIoPrefixExtensionPlan({
  userId: "user-1", accountId: "account-1", provider: "twitterapi_io",
  currentBoundary: 1000, availableBoundary: 1300,
  frontierAt: "2024-01-20T00:00:00Z",
});
assert.equal(acquisition.targetBoundary, 2000);
assert.equal(acquisition.missingCount, 700);
assert.equal(acquisition.acquisitionTargetCount, 700);
assert.equal(acquisition.collectStartAt, "2024-01-20T00:00:00Z");
console.log("io prefix extension planner checks passed");
