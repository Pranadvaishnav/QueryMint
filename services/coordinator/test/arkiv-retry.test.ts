import assert from "node:assert/strict";
import { test } from "node:test";
import { withArkivReadRetry } from "../src/arkiv/retry.js";

test("Arkiv read retries HTTP 429 and succeeds within the attempt cap", async () => {
  let attempts = 0;
  const result = await withArkivReadRetry(async () => {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error("HTTP request failed. Status: 429"), { status: 429 });
    return "ok";
  }, { sleep: async () => {} });
  assert.equal(result, "ok");
  assert.equal(attempts, 2);
});

test("Arkiv read stops after the bounded retries for HTTP 5xx", async () => {
  let attempts = 0;
  await assert.rejects(withArkivReadRetry(async () => {
    attempts++;
    throw Object.assign(new Error("upstream unavailable"), { statusCode: 503 });
  }, { sleep: async () => {} }), /upstream unavailable/);
  assert.equal(attempts, 3);
});

test("Arkiv read does not retry permanent client errors", async () => {
  let attempts = 0;
  await assert.rejects(withArkivReadRetry(async () => {
    attempts++;
    throw Object.assign(new Error("invalid query"), { status: 400 });
  }, { sleep: async () => {} }), /invalid query/);
  assert.equal(attempts, 1);
});
