import assert from "node:assert/strict";
import { computeIoCoverageFrontier } from "../src/lib/io/pg-cache";

const createdAt = "2024-01-01T00:00:00.000Z";

const joined = computeIoCoverageFrontier(createdAt, [
  { startAt: "2024-01-01T00:00:00Z", endAt: "2024-01-03T00:00:00Z" },
  { startAt: "2024-01-03T00:00:00Z", endAt: "2024-01-05T00:00:00Z" },
  { startAt: "2024-01-02T00:00:00Z", endAt: "2024-01-04T00:00:00Z" },
]);
assert.equal(joined?.frontierAt, "2024-01-05T00:00:00.000Z");

const gap = computeIoCoverageFrontier(createdAt, [
  { startAt: "2024-01-01T00:00:00Z", endAt: "2024-01-02T00:00:00Z" },
  { startAt: "2024-01-03T00:00:00Z", endAt: "2024-01-04T00:00:00Z" },
]);
assert.equal(gap?.frontierAt, "2024-01-02T00:00:00.000Z");

const noInitialCoverage = computeIoCoverageFrontier(createdAt, [
  { startAt: "2024-01-02T00:00:00Z", endAt: "2024-01-03T00:00:00Z" },
]);
assert.equal(noInitialCoverage?.frontierAt, createdAt);
assert.equal(noInitialCoverage?.completeWindowCount, 0);

assert.equal(computeIoCoverageFrontier("not-a-date", []), null);
console.log("io coverage frontier checks passed");
