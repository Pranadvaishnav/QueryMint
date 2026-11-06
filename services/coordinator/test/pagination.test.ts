import assert from "node:assert/strict";
import { test } from "node:test";
import type { Hex } from "viem";
import { collectArkivPages } from "../src/arkiv/pagination.js";
import { withArkivReadRetry } from "../src/arkiv/retry.js";

const entity = (n: number) => ({ $key: `0x${n.toString(16).padStart(64, "0")}` as Hex, value: n });

test("keyset pagination spans pages and returns a complete ordered result", async () => {
  const items = [entity(1), entity(2), entity(3), entity(4), entity(5)];
  const cursors: Array<Hex | undefined> = [];
  const result = await collectArkivPages(async (cursor) => {
    cursors.push(cursor);
    const after = cursor ? items.findIndex((item) => item.$key === cursor) + 1 : 0;
    return items.slice(after, after + 2);
  }, { pageSize: 2, maxPages: 5 });
  assert.deepEqual(result.entities, items);
  assert.equal(result.complete, true);
  assert.equal(result.pagesScanned, 3);
  assert.deepEqual(cursors, [undefined, items[1]!.$key, items[3]!.$key]);
});

test("a full bounded pagination cap cannot be mislabeled complete", async () => {
  const result = await collectArkivPages(async (cursor) => cursor ? [entity(3), entity(4)] : [entity(1), entity(2)], { pageSize: 2, maxPages: 2 });
  assert.equal(result.entities.length, 4);
  assert.equal(result.complete, false);
});

test("transient failure on a later page is retried without returning a partial result", async () => {
  let secondPageAttempts = 0;
  const result = await collectArkivPages(async (cursor) => {
    if (!cursor) return [entity(1), entity(2)];
    return withArkivReadRetry(async () => {
      secondPageAttempts++;
      if (secondPageAttempts === 1) throw Object.assign(new Error("429 rate limited"), { status: 429 });
      return [entity(3)];
    }, { baseDelayMs: 0, sleep: async () => {} });
  }, { pageSize: 2, maxPages: 3 });
  assert.equal(secondPageAttempts, 2);
  assert.equal(result.complete, true);
  assert.deepEqual(result.entities.map((item) => item.value), [1, 2, 3]);
});

test("repeated or out-of-order entity keys fail pagination explicitly", async () => {
  await assert.rejects(collectArkivPages(async (cursor) => cursor ? [entity(1)] : [entity(2), entity(1)], { pageSize: 2, maxPages: 2 }), /repeated or out-of-order/);
});
