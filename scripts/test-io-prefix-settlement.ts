import assert from "node:assert/strict";
import { settleIoPrefixExtension } from "../src/lib/io/prefix-settlement";

const full = settleIoPrefixExtension({
  plannedBaseBoundary: 1000, previousBoundary: 1000,
  targetBoundary: 2000, availableBoundary: 2200,
});
assert.deepEqual(
  { final: full.finalBoundary, granted: full.grantedCount, kind: full.kind },
  { final: 2000, granted: 1000, kind: "full" },
);

// Account has reached the present: only 237 additional covered posts exist.
// This must settle at 1237, rather than fail or invent a 2000-post entitlement.
const exhausted = settleIoPrefixExtension({
  plannedBaseBoundary: 1000, previousBoundary: 1000,
  targetBoundary: 2000, availableBoundary: 1237,
});
assert.deepEqual(
  { final: exhausted.finalBoundary, granted: exhausted.grantedCount, kind: exhausted.kind },
  { final: 1237, granted: 237, kind: "partial" },
);

const concurrent = settleIoPrefixExtension({
  plannedBaseBoundary: 1000, previousBoundary: 1500,
  targetBoundary: 2000, availableBoundary: 1237,
});
assert.equal(concurrent.finalBoundary, 1500);
assert.equal(concurrent.grantedCount, 0);
assert.equal(concurrent.kind, "no-progress");

const empty = settleIoPrefixExtension({
  plannedBaseBoundary: 0, previousBoundary: 0,
  targetBoundary: 1000, availableBoundary: 0,
});
assert.equal(empty.finalBoundary, 0);
assert.equal(empty.grantedCount, 0);
assert.equal(empty.kind, "no-progress");

console.log("io prefix settlement checks passed");
