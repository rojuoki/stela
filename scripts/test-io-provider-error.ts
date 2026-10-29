import assert from "node:assert/strict";
import { classifyIoProviderFailure } from "../src/lib/io/provider-error";

assert.deepEqual(
  classifyIoProviderFailure('HTTP 402: {"message":"Credits is not enough.Please recharge"}'),
  {
    code: "provider_credit_exhausted",
    message: "The external data provider has no remaining credit. Confirmed posts were saved.",
  },
);
assert.deepEqual(classifyIoProviderFailure("window could not resolve"), {
  code: "runner_incomplete",
  message: "window could not resolve",
});

console.log("IO provider error classification tests passed");
