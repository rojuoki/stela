import assert from "node:assert/strict";
import { subtractIoCoverage, validateIoRange } from "../src/lib/io/range-service";

const range = validateIoRange("2026-01-01T00:00:00Z", "2026-01-10T00:00:00Z");
assert.deepEqual(
  subtractIoCoverage(range, [
    { startAt: "2026-01-02T00:00:00Z", endAt: "2026-01-04T00:00:00Z" },
    { startAt: "2026-01-06T00:00:00Z", endAt: "2026-01-10T00:00:00Z" },
  ]),
  [
    { startAt: "2026-01-01T00:00:00.000Z", endAt: "2026-01-02T00:00:00.000Z" },
    { startAt: "2026-01-04T00:00:00.000Z", endAt: "2026-01-06T00:00:00.000Z" },
  ],
);
assert.throws(
  () => validateIoRange("2026-01-01T00:00:00Z", "2026-03-01T00:00:00Z"),
  /cannot exceed/,
);
console.log("io range planning checks passed");
