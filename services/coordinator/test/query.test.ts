import assert from "node:assert/strict";
import { test } from "node:test";
import { bytesToHex, type Address, type Hex } from "viem";
import { encryptPayload, contentHash, encryptedPayloadHash, stableJson } from "../src/arkiv/encryption.js";
import { queryAuthorizedRecords } from "../src/arkiv/query.js";

const publisher = "0x00000000000000000000000000000000000000a1" as Address;
const coordinator = "0x00000000000000000000000000000000000000c1" as Address;
const settlementAddress = "0x0000000000000000000000000000000000001874" as Address;
const datasetId = `0x${"ab".repeat(32)}` as Hex;
const encryptionKey = `0x${"33".repeat(32)}` as Hex;

async function rowFor(payload: unknown, overrides: { owner?: Address; payloadHash?: Hex } = {}) {
  const plaintext = stableJson(payload);
  const encrypted = encryptPayload(encryptionKey, plaintext);
  return {
    $key: `0x${"01".repeat(32)}` as Hex,
    $owner: overrides.owner ?? publisher,
    $expiresAt: 0n,
    datasetId: { value: datasetId },
    category: { value: "defi" },
    contentHash: { value: contentHash(plaintext) },
    payloadHash: { value: overrides.payloadHash ?? encryptedPayloadHash(encrypted) },
    label: { value: "demo" }, preview: { value: "Preview" }, encryptedPayload: { value: bytesToHex(encrypted) },
  };
}

function client(rowPages: any[][], state: { owner?: Address; active?: boolean; expiry?: bigint; grantExpiry?: bigint } = {}) {
  let pageIndex = 0;
  const query = {
    from() { return this; }, where() { return this; }, orderBy() { return this; }, limit() { return this; },
    async fetch() { return { entities: rowPages[pageIndex++] ?? [] }; },
  };
  const arkivClient = { select() { return query; } };
  const whitechainClient = {
    async getBlockNumber() { return 1n; },
    async getBlock() { return { timestamp: 1_000n }; },
    async readContract(args: any) {
      if (args.functionName === "datasetPublisher") return state.owner ?? publisher;
      if (args.functionName === "datasetPolicies") return [1_000_000n, 50_000_000n, 0n, 50, state.expiry ?? 5_000n, 1n, state.active ?? true];
      if (args.functionName === "coordinatorGrants") return [state.grantExpiry ?? 4_000n, 2n, state.active ?? true];
      if (args.functionName === "publishers") return [publisher, 3n, true];
      throw new Error(`Unexpected read ${args.functionName}`);
    },
  };
  return { arkivClient, whitechainClient: whitechainClient as any };
}

async function query(rowList: any[] | any[][], state: Parameters<typeof client>[1] = {}, options: { pageSize?: number; maxPages?: number } = {}) {
  const pages = rowList.length && Array.isArray(rowList[0]) ? rowList as any[][] : [rowList as any[], []];
  const clients = client(pages, state);
  return queryAuthorizedRecords({ arkivClient: clients.arkivClient as any, whitechainClient: clients.whitechainClient, settlementAddress, coordinator, category: "defi", maxRecords: 50, encryptionKey, ...options });
}

test("queries encrypted Arkiv record after owner, authorization, and hash checks", async () => {
  const row = await rowFor({ value: 10 });
  const result = await query([row]);
  assert.equal(result.records.length, 1);
  assert.deepEqual(result.records[0]?.payload, { value: 10 });
  assert.equal(result.records[0]?.publisher, publisher);
  assert.equal(result.records[0]?.pricePerRecord, 1_000_000n);
  assert.equal(result.complete, true);
  assert.equal(result.totalMatching, 1);
});

test("two independent publishers decrypt back to their original content hashes", async () => {
  const secondPublisher = "0x00000000000000000000000000000000000000b2" as Address;
  const supplied = [
    { publisher, payload: { owner: "publisher-a", rows: [1, 2] } },
    { publisher: secondPublisher, payload: { owner: "publisher-b", rows: [3, 4] } },
  ];
  for (const item of supplied) {
    const plaintext = stableJson(item.payload);
    const encrypted = encryptPayload(encryptionKey, plaintext);
    const record = (await import("../src/arkiv/encryption.js")).decryptPayload(encryptionKey, bytesToHex(encrypted));
    assert.deepEqual(JSON.parse(record), item.payload);
    assert.equal(contentHash(record), contentHash(stableJson(item.payload)));
  }
});

test("rejects Arkiv entity whose owner differs from registered dataset publisher", async () => {
  const other = "0x00000000000000000000000000000000000000b2" as Address;
  const row = await rowFor({ value: 10 }, { owner: other });
  assert.equal((await query([row])).records.length, 0);
});

test("rejects revoked coordinator grants", async () => {
  const row = await rowFor({ value: 10 });
  assert.equal((await query([row], { active: false })).records.length, 0);
});

test("rejects expired grants and datasets", async () => {
  const row = await rowFor({ value: 10 });
  assert.equal((await query([row], { grantExpiry: 999n })).records.length, 0);
  assert.equal((await query([row], { expiry: 999n })).records.length, 0);
});

test("rejects duplicate content hashes within a dataset instead of silently dropping one", async () => {
  const rowA = await rowFor({ value: 10 });
  const rowB = { ...rowA, $key: `0x${"02".repeat(32)}` as Hex };
  await assert.rejects(query([rowA, rowB]), /Duplicate content hash/);
});

test("record scanning follows multiple Arkiv pages and returns deterministic dataset/hash order", async () => {
  const lowDataset = await rowFor({ value: 10 });
  const highDataset = { ...await rowFor({ value: 20 }), $key: `0x${"02".repeat(32)}` as Hex, datasetId: { value: `0x${"cd".repeat(32)}` as Hex } };
  const result = await query([[lowDataset, highDataset], []], {}, { pageSize: 2 });
  assert.equal(result.complete, true);
  assert.equal(result.pagesScanned, 2);
  assert.deepEqual(result.records.map((record) => record.datasetId), [lowDataset.datasetId.value, highDataset.datasetId.value]);
});

test("a full record scan safety cap is reported as incomplete", async () => {
  const rowA = await rowFor({ value: 10 });
  const rowB = { ...await rowFor({ value: 20 }), $key: `0x${"02".repeat(32)}` as Hex };
  const result = await query([[rowA], [rowB]], {}, { pageSize: 1, maxPages: 1 });
  assert.equal(result.complete, false);
  assert.equal(result.pagesScanned, 1);
  assert.equal(result.totalMatching, 1);
});

test("rejects duplicate content hashes shared across datasets", async () => {
  const rowA = await rowFor({ shared: true });
  const rowB = { ...await rowFor({ shared: true }), $key: `0x${"02".repeat(32)}` as Hex, datasetId: { value: `0x${"cd".repeat(32)}` as Hex } };
  await assert.rejects(query([rowA, rowB]), /Duplicate content hash/);
});

test("rejects invalid encrypted payload hash", async () => {
  const row = await rowFor({ value: 10 }, { payloadHash: `0x${"ff".repeat(32)}` as Hex });
  await assert.rejects(query([row]), /Payload hash mismatch/);
});

test("rejects invalid plaintext content hash", async () => {
  const row = await rowFor({ value: 10 });
  row.contentHash.value = `0x${"ff".repeat(32)}`;
  await assert.rejects(query([row]), /Content hash mismatch/);
});
