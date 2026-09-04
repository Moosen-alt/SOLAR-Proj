// ONE TRANSIENT BLIP COST A WHOLE PORTAL, AND LOOKED LIKE A REGRESSION.
//
// On the final sweep of 2026-09-04, Gilbert's single planner call came back
//
//   {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}
//
// after 1455ms. The run recorded ZERO fills on a form whose eight fillable fields it had
// already extracted, and the portal dropped from reached_review to reached_form. It read as
// a regression from that day's engine work — the expensive way to be wrong — and it was an
// upstream overload with no retry behind it.
//
// The client is built with maxRetries:5, and the SDK does retry 429/5xx. But every call in
// the provider is a .stream(): the HTTP request SUCCEEDS and the overload arrives later as
// an event inside the stream, so the SDK has nothing left to retry. The wrapper around it
// had nothing either.
//
// This test is mostly about what must NOT be retried. Retrying a bad key or a malformed
// request burns a portal's budget to reach the same answer three times more slowly, and on
// a sweep of eleven portals that is the difference between a slow run and no run.
//
// Browser-free, no network. Run: tsx backend/test/llmTransientRetry.test.ts
import assert from "node:assert/strict";
import { isTransientLlmError } from "../src/llm";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

check("THE REGRESSION: an in-stream overload is retryable", () => {
  // Verbatim from Gilbert's llm-calls.json.
  assert.equal(isTransientLlmError(new Error('{"type":"error","error":{"details":null,"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011CeiFgtbLdxTCebK7Q9eTC"}')), true);
});

check("...as are the rest of the failures a retry can actually fix", () => {
  for (const m of [
    "rate_limit_error: number of requests has exceeded your rate limit",
    "529 Service Overloaded",
    "500 Internal Server Error",
    "Request timed out",
    "read ECONNRESET",
    "socket hang up",
    "fetch failed",
    "stream ended unexpectedly",
  ]) {
    assert.equal(isTransientLlmError(new Error(m)), true, `not retried: ${m}`);
  }
});

check("...and by status code, when the SDK gives one", () => {
  for (const status of [408, 409, 429, 500, 502, 503, 529]) {
    assert.equal(isTransientLlmError(Object.assign(new Error("x"), { status })), true, `not retried: ${status}`);
  }
});

// ---------------------------------------------------------------------------
// The expensive direction: retrying what will never succeed.
// ---------------------------------------------------------------------------
check("a bad API key is NOT retried — it fails the same way every time", () => {
  assert.equal(isTransientLlmError(new Error("authentication_error: invalid x-api-key")), false);
  assert.equal(isTransientLlmError(Object.assign(new Error("unauthorized"), { status: 401 })), false);
});

check("a malformed request is NOT retried", () => {
  assert.equal(isTransientLlmError(new Error("invalid_request_error: max_tokens is too large")), false);
  assert.equal(isTransientLlmError(Object.assign(new Error("invalid_request_error"), { status: 400 })), false);
});

check("a permission or not-found failure is NOT retried", () => {
  assert.equal(isTransientLlmError(Object.assign(new Error("permission denied"), { status: 403 })), false);
  assert.equal(isTransientLlmError(Object.assign(new Error("model not_found"), { status: 404 })), false);
});

check("...even when the message also contains a retryable-looking word", () => {
  // "invalid_request" wins over the "500" sitting in a field name. The precedence is
  // deliberate: a request that is wrong is wrong however long you wait.
  assert.equal(isTransientLlmError(new Error("invalid_request_error: max_tokens 500000 exceeds the limit")), false);
});

check("garbage input does not throw and does not retry", () => {
  assert.equal(isTransientLlmError(undefined), false);
  assert.equal(isTransientLlmError(null), false);
  assert.equal(isTransientLlmError({}), false);
  assert.equal(isTransientLlmError("plain string"), false);
});

if (failures) { console.error(`\n${failures} llm-transient-retry check(s) FAILED.`); process.exit(1); }
console.log("\nAll llm-transient-retry checks passed.");
process.exit(0);
