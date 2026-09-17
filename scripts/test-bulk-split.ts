import assert from "node:assert/strict";
import { chooseBulkSplitPoint } from "../src/lib/excavateBulk";

const start = new Date("2020-01-01T00:00:00.000Z");
const end = new Date("2020-05-01T00:00:00.000Z");

const densitySplit = chooseBulkSplitPoint(
  start,
  end,
  new Date("2020-04-01T00:00:00.000Z"),
);
assert.equal(densitySplit?.method, "density");
assert.equal(densitySplit?.point.toISOString(), "2020-01-19T00:00:00.000Z");
assert.ok(densitySplit!.point > start && densitySplit!.point < end);

const midpointSplit = chooseBulkSplitPoint(start, end);
assert.equal(midpointSplit?.method, "half");
assert.ok(midpointSplit!.point > start && midpointSplit!.point < end);

assert.equal(
  chooseBulkSplitPoint(new Date(0), new Date(1)),
  null,
);

console.log("bulk split helper: PASS");
