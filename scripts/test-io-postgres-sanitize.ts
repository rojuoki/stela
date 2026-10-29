import assert from "node:assert/strict";
import { sanitizeIoPostgresText, stringifyIoPostgresJson } from "../src/lib/io/postgres-sanitize";

assert.equal(
  sanitizeIoPostgresText("before\u0000\u0005after\nkept\tspace"),
  "beforeafter\nkept\tspace",
);

const serialized = stringifyIoPostgresJson({
  text: "legacy\u0000post\u0005",
  nested: ["safe", { value: "line\nkept" }],
});
assert.deepEqual(JSON.parse(serialized), {
  text: "legacypost",
  nested: ["safe", { value: "line\nkept" }],
});
assert.equal(serialized.includes("\\u0000"), false);

console.log("IO PostgreSQL sanitization tests passed");
