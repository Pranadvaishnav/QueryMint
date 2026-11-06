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

function client(rowList: any[], state: { owner?: Address; active?: boolean; expiry?: bigint; grantExpiry?: bigint } = {}) {
  const query = {
    from() { return this; }, where() { return this; }, orderBy() { return this; }, limit() { return this; },
    async fetch() { return { entities: rowList }; },
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

async function query(rowList: any[], state: Parameters<typeof client>[1] = {}) {
  const clients = client(rowList, state);
  return queryAuthorizedRecords({ arkivClient: clients.arkivClient as any, whitechainClient: clients.whitechainClient, settlementAddress, coordinator, category: "defi", maxRecords: 50, encryptionKey });
}

test("queries encrypted Arkiv record after owner, authorization, and hash checks", async () => {
  const row = await rowFor({ value: 10 });
  const result = await query([row]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0]?.payload, { value: 10 });
  assert.equal(result[0]?.publisher, publisher);
  assert.equal(result[0]?.pricePerRecord, 1_000_000n);
});

test("rejects Arkiv entity whose owner differs from registered dataset publisher", async () => {
  const other = "0x00000000000000000000000000000000000000b2" as Address;
  const row = await rowFor({ value: 10 }, { owner: other });
  assert.equal((await query([row])).length, 0);
});

test("rejects revoked coordinator grants", async () => {
  const row = await rowFor({ value: 10 });
  assert.equal((await query([row], { active: false })).length, 0);
});

test("rejects expired grants and datasets", async () => {
  const row = await rowFor({ value: 10 });
  assert.equal((await query([row], { grantExpiry: 999n })).length, 0);
  assert.equal((await query([row], { expiry: 999n })).length, 0);
});

test("deduplicates records by plaintext content hash", async () => {
  const rowA = await rowFor({ value: 10 });
  const rowB = { ...rowA, $key: `0x${"02".repeat(32)}` as Hex };
  const result = await query([rowA, rowB]);
  assert.equal(result.length, 1);
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
