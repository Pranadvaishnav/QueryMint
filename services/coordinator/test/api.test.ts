import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { decodeEventLog, decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, hexToBytes, keccak256, parseAbiItem, recoverAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hashQueryManifest, hashResultRoot, publisherApprovalTypes, type Allocation } from "@querymint/shared";
import { createQueryMint } from "../../../packages/sdk/src/index.js";
import { createCoordinatorApp, settlementCallAbi } from "../src/api.js";
import type { VerifiedRecord } from "../src/arkiv/query.js";
import { contentHash, decryptPayload, encryptPayload, encryptedPayloadHash, stableJson } from "../src/arkiv/encryption.js";
import { PublisherProfile, DatasetManifest } from "../src/arkiv/schema.js";

const settlementAddress = "0x0000000000000000000000000000000000001874" as Address;
const coordinator = privateKeyToAccount(`0x${"11".repeat(32)}` as Hex);
const buyerAccount = privateKeyToAccount(`0x${"22".repeat(32)}` as Hex);
const buyer = buyerAccount.address;
const deliveryTypes = { DeliveryAuthorization: [
  { name: "queryId", type: "bytes32" }, { name: "transactionHash", type: "bytes32" }, { name: "buyer", type: "address" },
] } as const;
const querySettledEvent = parseAbiItem("event QuerySettled(bytes32 indexed queryId,address indexed buyer,address indexed coordinator,uint256 totalAmount,bytes32 resultRoot,bytes32 manifestDigest)");
const allocationPaidEvent = parseAbiItem("event AllocationPaid(bytes32 indexed queryId,bytes32 indexed datasetId,address indexed publisher,address payout,uint256 amount,uint32 recordCount)");
const erc20TransferEvent = parseAbiItem("event Transfer(address indexed from,address indexed to,uint256 value)");

function makeRecord(index: number): VerifiedRecord {
  const publisher = privateKeyToAccount(`0x${String(index + 100).padStart(64, "0")}` as Hex);
  const hash = `0x${(index + 1).toString(16).padStart(64, "0")}` as Hex;
  const datasetId = `0x${(index + 101).toString(16).padStart(64, "0")}` as Hex;
  return {
    entityKey: hash, datasetId, publisher: publisher.address, contentHash: hash,
    payloadHash: `0x${(index + 1001).toString(16).padStart(64, "0")}` as Hex,
    category: "defi", label: `record-${index}`, preview: "Synthetic preview", payload: { secret: `payload-${index}` },
    pricePerRecord: 1_000_000n, maxPayoutPerQuery: 50_000_000n, maxRecordsPerQuery: 50,
    publisherNonce: 1n, policyNonce: 1n, grantNonce: 1n, policyExpiresAt: 10_000n, grantExpiresAt: 9_000n,
    publisherSignatureThreshold: 0n,
  };
}

function stressRecords(publishers: number, datasetsPerPublisher: number, recordsPerDataset: number): VerifiedRecord[] {
  const records: VerifiedRecord[] = [];
  let ordinal = 0;
  for (let p = 0; p < publishers; p++) {
    const publisher = privateKeyToAccount(`0x${String(p + 100).padStart(64, "0")}` as Hex).address;
    for (let d = 0; d < datasetsPerPublisher; d++) {
      const datasetId = `0x${(0x100 + p * datasetsPerPublisher + d).toString(16).padStart(64, "0")}` as Hex;
      for (let r = 0; r < recordsPerDataset; r++) {
        const payload = { publisherIndex: p, datasetIndex: d, recordIndex: r, body: `test-p${p}-d${d}-r${r}` };
        const hash = contentHash(stableJson(payload));
        records.push({ ...makeRecord(p), entityKey: `0x${(++ordinal).toString(16).padStart(64, "0")}` as Hex,
          datasetId, publisher, contentHash: hash, payloadHash: `0x${(ordinal + 0x5000).toString(16).padStart(64, "0")}` as Hex,
          payload, label: `p${p}-d${d}-r${r}` });
      }
    }
  }
  return records;
}

function fixture(records: VerifiedRecord[], arkivClient: any = {}, queryManifestRecords?: ((manifest: any) => Promise<any[]>) | null, queryRecordsOverride?: (category: string, limit: number) => Promise<any>, corsOrigins?: string[], trustProxyHops = 0, rateLimitPerMinute = 10_000, failWhitechainAt?: string) {
  const states = new Map(records.map((row) => [row.datasetId.toLowerCase(), row]));
  const uniquePublishers = [...new Set(records.map((row) => row.publisher.toLowerCase()))];
  const publisherPayouts = new Map(uniquePublishers.map((address, index) => [address, `0x${(0xd000 + index).toString(16).padStart(40, "0")}` as Address]));
  let settled = false;
  let receiptLogs: any[] = [];
  let receiptStatus: "success" | "reverted" = "success";
  let transactionInput: Hex = "0x";
  let logs: any[] = [];
  const failWhitechainRead = (stage: string) => {
    if (failWhitechainAt === stage) throw Object.assign(new Error("upstream failed https://rpc.invalid/secret-access-key plaintext-marker"), { status: 503, code: "UPSTREAM_UNAVAILABLE" });
  };
  const client = {
    async getBlockNumber() { failWhitechainRead("latest_block"); return 100n; },
    async getBlock() { failWhitechainRead("latest_block"); return { timestamp: 1_000n }; },
    async readContract(args: any) {
      failWhitechainRead(args.functionName);
      if (args.functionName === "datasetPublisher") return states.get(args.args[0].toLowerCase())?.publisher ?? `0x${"00".repeat(20)}`;
      if (args.functionName === "datasetPolicies") {
        const row = states.get(args.args[0].toLowerCase())!;
        return [row.pricePerRecord, row.maxPayoutPerQuery, row.publisherSignatureThreshold, row.maxRecordsPerQuery, row.policyExpiresAt, row.policyNonce, true];
      }
      if (args.functionName === "coordinatorGrants") {
        const row = states.get(args.args[0].toLowerCase())!;
        return [row.grantExpiresAt, row.grantNonce, true];
      }
      if (args.functionName === "publishers") {
        const row = records.find((item) => item.publisher.toLowerCase() === args.args[0].toLowerCase());
        return [publisherPayouts.get(args.args[0].toLowerCase()) ?? row?.publisher ?? args.args[0], row?.publisherNonce ?? 0n, Boolean(row)];
      }
      if (args.functionName === "settledQueries") return settled;
      throw new Error(`Unexpected read ${args.functionName}`);
    },
    async getLogs() { return logs; },
    async getTransactionReceipt() { return { status: receiptStatus, blockNumber: 101n, logs: receiptLogs }; },
    async getTransaction() { return { from: buyer, to: settlementAddress, input: transactionInput }; },
  };
  const app = createCoordinatorApp({
    arkivClient, whitechainClient: client as any, settlementAddress, coordinatorAccount: coordinator,
    encryptionKey: `0x${"33".repeat(32)}` as Hex, deploymentBlock: 0n, now: () => 1_000_000,
    rateLimitPerMinute, // Keep the shared test IP below the production 60/min limit across fixture apps.
    ...(corsOrigins ? { corsOrigins } : {}),
    trustProxyHops,
    queryRecords: queryRecordsOverride ?? (async () => records),
    ...(queryManifestRecords === null ? {} : { queryManifestRecords: queryManifestRecords ?? (async (manifest: any) => records.filter((row) => manifest.allocations.some((allocation: any) => allocation.datasetId.toLowerCase() === row.datasetId.toLowerCase() && allocation.recordHashes.some((hash: string) => hash.toLowerCase() === row.contentHash.toLowerCase()))).map((row) => ({ publisher: row.publisher, datasetId: row.datasetId, recordHash: row.contentHash, payload: row.payload }))) }),
  });
  return { app, payoutFor: (publisher: Address) => publisherPayouts.get(publisher.toLowerCase()) ?? publisher,
    setSettled: (value: boolean) => { settled = value; }, setReceiptLogs: (value: any[]) => { receiptLogs = value; }, setReceiptStatus: (value: "success" | "reverted") => { receiptStatus = value; }, setTransactionInput: (value: Hex) => { transactionInput = value; }, setLogs: (value: any[]) => { logs = value; } };
}

function failingOrEmptyArkivClient(fetch: () => Promise<unknown>) {
  const builder = {
    from() { return this; },
    where() { return this; },
    orderBy() { return this; },
    limit() { return this; },
    fetch,
  };
  return { select() { return builder; } };
}

function arkivDiscoveryClient(records: VerifiedRecord[]) {
  const publishers = [...new Map(records.map((row) => [row.publisher.toLowerCase(), row.publisher])).values()];
  const datasets = [...new Map(records.map((row) => [row.datasetId.toLowerCase(), row])).values()];
  return { select() {
    let schema: unknown;
    const builder = { from(value: unknown) { schema = value; return this; }, where() { return this; }, orderBy() { return this; }, limit() { return this; },
      async fetch() {
        if (schema === PublisherProfile) return { entities: publishers.map((wallet, index) => ({ $key: `0x${(index + 1).toString(16).padStart(64, "0")}` as Hex,
          $owner: wallet, wallet: { value: wallet }, status: { value: "active" }, displayName: { value: `Publisher ${index + 1}` }, payoutAddress: { value: `0x${(0xd000 + index).toString(16).padStart(40, "0")}` } })) };
        return { entities: datasets.map((row, index) => ({ $key: `0x${(index + 101).toString(16).padStart(64, "0")}` as Hex,
          $owner: row.publisher, datasetId: { value: row.datasetId }, publisher: { value: row.publisher }, category: { value: row.category }, status: { value: "active" },
          title: { value: `Dataset ${index + 1}` }, description: { value: "Stress fixture" } })) };
      } };
    return builder;
  } };
}

async function requestApp(app: ReturnType<typeof createCoordinatorApp>, path: string, init?: RequestInit) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  try { return await fetch(`http://127.0.0.1:${address.port}${path}`, init); }
  finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

const quoteBody = (limit = 20) => JSON.stringify({ buyer, where: { category: "defi" }, limit });
const postJson = (body: string) => ({ method: "POST", headers: { "content-type": "application/json" }, body });
async function signedDeliveryBody(queryId: Hex, transactionHash: Hex, requestedBuyer: Address = buyer) {
  const buyerSignature = await buyerAccount.signTypedData({ domain: { name: "QueryMint", version: "1", chainId: 1874, verifyingContract: settlementAddress },
    types: deliveryTypes, primaryType: "DeliveryAuthorization", message: { queryId, transactionHash, buyer: requestedBuyer } });
  return JSON.stringify({ transactionHash, buyer: requestedBuyer, buyerSignature });
}
function settlementProof(quote: any, payoutFor: (publisher: Address) => Address = (publisher) => publisher) {
  const manifest = { ...quote.manifest, totalAmount: BigInt(quote.manifest.totalAmount), deadline: BigInt(quote.manifest.deadline), allocations: quote.manifest.allocations.map((allocation: any) => ({
    ...allocation, publisherNonce: BigInt(allocation.publisherNonce), policyNonce: BigInt(allocation.policyNonce), grantNonce: BigInt(allocation.grantNonce), payoutAmount: BigInt(allocation.payoutAmount),
  })) };
  const input = encodeFunctionData({ abi: settlementCallAbi, functionName: "settle", args: [manifest as any] });
  const digest = hashQueryManifest({ name: "QueryMint", version: "1", chainId: 1874, verifyingContract: settlementAddress }, manifest);
  const queryTopics = encodeEventTopics({ abi: [querySettledEvent], eventName: "QuerySettled", args: { queryId: quote.quoteId, buyer, coordinator: coordinator.address } });
  const logs: any[] = [{ address: settlementAddress, topics: queryTopics, data: encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }], [manifest.totalAmount, manifest.resultRoot, digest]) }];
  for (const allocation of manifest.allocations) {
    const topics = encodeEventTopics({ abi: [allocationPaidEvent], eventName: "AllocationPaid", args: { queryId: quote.quoteId, datasetId: allocation.datasetId, publisher: allocation.publisher } });
    const payout = payoutFor(allocation.publisher);
    const data = encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint32" }], [payout, allocation.payoutAmount, allocation.recordCount]);
    logs.push({ address: settlementAddress, topics, data });
    const transferTopics = encodeEventTopics({ abi: [erc20TransferEvent], eventName: "Transfer", args: { from: settlementAddress, to: payout } });
    logs.push({ address: "0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7", topics: transferTopics, data: encodeAbiParameters([{ type: "uint256" }], [allocation.payoutAmount]) });
  }
  return { input, logs };
}

test("quote from one publisher is signed and excludes licensed plaintext", async () => {
  const records = [makeRecord(0)];
  const response = await requestApp(fixture(records).app, "/query/quote", postJson(quoteBody()));
  assert.equal(response.status, 201);
  const quote: any = await response.json();
  assert.equal(quote.breakdown.length, 1);
  assert.equal(quote.manifest.totalAmount, "1000000");
  assert.equal(JSON.stringify(quote).includes("payload-0"), false);
  const allocations = quote.manifest.allocations.map((a: any) => ({ ...a, publisherNonce: BigInt(a.publisherNonce), policyNonce: BigInt(a.policyNonce), grantNonce: BigInt(a.grantNonce), payoutAmount: BigInt(a.payoutAmount) })) as Allocation[];
  const manifest = { ...quote.manifest, totalAmount: BigInt(quote.manifest.totalAmount), deadline: BigInt(quote.manifest.deadline), allocations };
  const digest = hashQueryManifest({ name: "QueryMint", version: "1", chainId: 1874, verifyingContract: settlementAddress }, manifest);
  assert.equal((await recoverAddress({ hash: digest, signature: manifest.coordinatorSignature })).toLowerCase(), coordinator.address.toLowerCase());
});

test("healthcheck responds and CORS allows each configured production origin only", async () => {
  const client = fixture([], {}, undefined, undefined, ["https://market.example", "https://demo.example"]).app;
  const first = await requestApp(client, "/health");
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true });
  for (const origin of ["https://market.example", "https://demo.example"]) {
    const preflight = await requestApp(client, "/query/quote", { method: "OPTIONS", headers: { origin } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
  }
  const rejected = await requestApp(client, "/query/quote", { method: "OPTIONS", headers: { origin: "https://untrusted.example" } });
  assert.equal(rejected.status, 403);
});

test("configured trusted Railway X-Real-IP separates rate-limit buckets", async () => {
  const app = fixture([], {}, undefined, undefined, undefined, 1, 1).app;
  const first = await requestApp(app, "/health", { headers: { "x-real-ip": "192.0.2.10" } });
  const limited = await requestApp(app, "/health", { headers: { "x-real-ip": "192.0.2.10" } });
  const separate = await requestApp(app, "/health", { headers: { "x-real-ip": "192.0.2.11" } });
  assert.equal(first.status, 200);
  assert.equal(limited.status, 429);
  assert.equal(separate.status, 200);
});

test("discovery failures log only safe metadata and retain the 503 response", async () => {
  const records = [makeRecord(0)];
  const arkivFailure = Object.assign(new Error("failure https://rpc.invalid/secret-access-key plaintext-marker"), { status: 503, code: "UPSTREAM_UNAVAILABLE" });
  const cases = [
    { route: "/publishers", stage: "arkiv_entity_query", app: fixture([], failingOrEmptyArkivClient(async () => { throw arkivFailure; })).app },
    { route: "/publishers", stage: "whitechain_publisher_registration_read", app: fixture(records, arkivDiscoveryClient(records), undefined, undefined, undefined, 0, 10_000, "publishers").app },
    { route: "/datasets", stage: "arkiv_entity_query", app: fixture([], failingOrEmptyArkivClient(async () => { throw arkivFailure; })).app },
    { route: "/datasets", stage: "whitechain_latest_block_read", app: fixture(records, arkivDiscoveryClient(records), undefined, undefined, undefined, 0, 10_000, "latest_block").app },
    { route: "/datasets", stage: "whitechain_dataset_owner_read", app: fixture(records, arkivDiscoveryClient(records), undefined, undefined, undefined, 0, 10_000, "datasetPublisher").app },
    { route: "/datasets", stage: "whitechain_dataset_policy_read", app: fixture(records, arkivDiscoveryClient(records), undefined, undefined, undefined, 0, 10_000, "datasetPolicies").app },
    { route: "/datasets", stage: "whitechain_coordinator_grant_read", app: fixture(records, arkivDiscoveryClient(records), undefined, undefined, undefined, 0, 10_000, "coordinatorGrants").app },
  ];

  for (const [index, scenario] of cases.entries()) {
    const logs: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { logs.push(String(args[0])); };
    let response: Response | undefined;
    try {
      response = await requestApp(scenario.app, scenario.route, { headers: { "x-railway-request-id": `railway-${index + 1}` } });
    } finally { console.error = originalError; }
    assert(response);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: `${scenario.route === "/publishers" ? "Publisher" : "Dataset"} discovery is temporarily unavailable. Retry shortly.`, code: "DISCOVERY_UNAVAILABLE", retryable: true });
    assert.equal(logs.length, 1);
    const logLine = logs[0] ?? "";
    const entry = JSON.parse(logLine);
    assert.equal(entry.event, "discovery_failed");
    assert.equal(entry.requestId, `railway-${index + 1}`);
    assert.equal(entry.route, scenario.route === "/publishers" ? "GET /publishers" : "GET /datasets");
    assert.equal(entry.stage, scenario.stage);
    assert.equal(entry.errorName, "Error");
    assert.equal(entry.status, 503);
    assert.equal(entry.code, "UPSTREAM_UNAVAILABLE");
    assert.equal(logLine.includes("secret-access-key"), false);
    assert.equal(logLine.includes("plaintext-marker"), false);
    assert.equal(logLine.includes("rpc.invalid"), false);
  }
});

test("publisher discovery retries a transient Arkiv 429 before returning an empty result", async () => {
  let attempts = 0;
  const arkivClient = failingOrEmptyArkivClient(async () => {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error("HTTP request failed. Status: 429"), { status: 429 });
    return { entities: [] };
  });
  const response = await requestApp(fixture([], arkivClient).app, "/publishers");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { publishers: [] });
  assert.equal(attempts, 2);
});

test("dataset discovery reports an unavailable index instead of a false empty result", async () => {
  let attempts = 0;
  const accessKey = "test-only-sensitive-key";
  const arkivClient = failingOrEmptyArkivClient(async () => {
    attempts++;
    throw Object.assign(new Error(`HTTP request failed. Status: 429 at https://rpc.example/${accessKey}`), { status: 429 });
  });
  const response = await requestApp(fixture([], arkivClient).app, "/datasets");
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.code, "DISCOVERY_UNAVAILABLE");
  assert.equal(body.retryable, true);
  assert.equal(body.error.includes(accessKey), false);
  assert.equal(attempts, 3);
});

test("coordinator exposes a local health route", async () => {
  const response = await requestApp(fixture([makeRecord(0)]).app, "/health");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("publisher encryption endpoint returns decryptable ciphertext and matching hashes", async () => {
  const payload = { z: 7, a: "publisher-record" };
  const response = await requestApp(fixture([]).app, "/publisher/encrypt-record", postJson(JSON.stringify({ payload })));
  assert.equal(response.status, 200);
  const result = await response.json() as { encryptedPayload: Hex; contentHash: Hex; payloadHash: Hex };
  const plaintext = stableJson(payload);
  assert.deepEqual(JSON.parse(decryptPayload(`0x${"33".repeat(32)}` as Hex, result.encryptedPayload)), payload);
  assert.equal(result.contentHash, contentHash(plaintext));
  assert.equal(result.payloadHash, keccak256(hexToBytes(result.encryptedPayload)));
});

test("buyer SDK reads a signed quote and revives integer fields", async () => {
  const app = fixture([makeRecord(0)]).app;
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  try {
    const sdk = createQueryMint({ apiUrl: `http://127.0.0.1:${address.port}`, settlementAddress,
      walletClient: { account: { address: buyer } } as any, publicClient: {} as any });
    const quote = await sdk.quote({ where: { category: "defi" }, limit: 5 });
    assert.equal(quote.manifest.buyer, buyer);
    assert.equal(typeof quote.manifest.totalAmount, "bigint");
    assert.equal(typeof quote.manifest.allocations[0]?.payoutAmount, "bigint");
    assert.equal(quote.records.length, 1);
    assert.equal(quote.totalMatchingRecords, 1);
    assert.equal(quote.eligibleRecords, 1);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test("quote aggregates two publishers and sums on-chain prices", async () => {
  const response = await requestApp(fixture([makeRecord(0), makeRecord(1)]).app, "/query/quote", postJson(quoteBody()));
  assert.equal(response.status, 201);
  const quote: any = await response.json();
  assert.equal(quote.breakdown.length, 2);
  assert.equal(quote.records.length, 2);
  assert.equal(quote.manifest.totalAmount, "2000000");
});

test("allocation and record ordering is deterministic regardless of Arkiv response order", async () => {
  const rows = [makeRecord(2), makeRecord(0), makeRecord(1)];
  const first = await requestApp(fixture(rows).app, "/query/quote", postJson(quoteBody(50)));
  const second = await requestApp(fixture([...rows].reverse()).app, "/query/quote", postJson(quoteBody(50)));
  const a: any = await first.json();
  const b: any = await second.json();
  assert.deepEqual(a.manifest.allocations.map((item: any) => [item.datasetId, item.recordHashes]), b.manifest.allocations.map((item: any) => [item.datasetId, item.recordHashes]));
  assert.deepEqual(a.records.map((item: any) => [item.datasetId, item.recordHash]), b.records.map((item: any) => [item.datasetId, item.recordHash]));
});

test("quote rejects expired or revoked coordinator authorization", async () => {
  const row = makeRecord(0);
  row.grantExpiresAt = 900n;
  const response = await requestApp(fixture([row]).app, "/query/quote", postJson(quoteBody()));
  assert.equal(response.status, 409);
});

test("quote rejects malformed buyer input", async () => {
  const response = await requestApp(fixture([makeRecord(0)]).app, "/query/quote", postJson(JSON.stringify({ buyer: "bad", where: { category: "defi" } })));
  assert.equal(response.status, 400);
});

test("quote rejects publisher maximum payout instead of omitting matching records", async () => {
  const row = makeRecord(0);
  row.maxPayoutPerQuery = 999_999n;
  const response = await requestApp(fixture([row]).app, "/query/quote", postJson(quoteBody()));
  assert.equal(response.status, 422);
});

test("exactly 10 dataset allocations remain quoteable", async () => {
  const response = await requestApp(fixture(Array.from({ length: 10 }, (_, index) => makeRecord(index))).app, "/query/quote", postJson(quoteBody(50)));
  assert.equal(response.status, 201);
  const quote: any = await response.json();
  assert.equal(quote.manifest.allocations.length, 10);
  assert.equal(quote.eligibleRecords, 10);
});

test("11 dataset allocations are rejected before a payable quote is produced", async () => {
  const response = await requestApp(fixture(Array.from({ length: 11 }, (_, index) => makeRecord(index))).app, "/query/quote", postJson(quoteBody(50)));
  assert.equal(response.status, 422);
  assert.equal((await response.json() as any).code, "QUERY_CAPACITY_EXCEEDED");
});

test("exactly 50 records are quoteable while 51 are rejected with deployed capacity", async () => {
  const grouped = Array.from({ length: 10 }, (_, group) => {
    const base = makeRecord(group);
    return Array.from({ length: 5 }, (_, item) => ({ ...base,
      entityKey: `0x${(group * 5 + item + 1).toString(16).padStart(64, "0")}` as Hex,
      contentHash: `0x${(group * 5 + item + 1001).toString(16).padStart(64, "0")}` as Hex,
      payloadHash: `0x${(group * 5 + item + 2001).toString(16).padStart(64, "0")}` as Hex,
    }));
  }).flat();
  const fifty = await requestApp(fixture(grouped).app, "/query/quote", postJson(quoteBody(50)));
  assert.equal(fifty.status, 201);
  const quote: any = await fifty.json();
  assert.equal(quote.totalMatchingRecords, 50);
  assert.equal(quote.eligibleRecords, 50);
  const extra = { ...grouped[0]!, entityKey: `0x${"ff".repeat(32)}` as Hex, contentHash: `0x${"ee".repeat(32)}` as Hex };
  const fiftyOne = await requestApp(fixture([...grouped, extra]).app, "/query/quote", postJson(quoteBody(50)));
  assert.equal(fiftyOne.status, 422);
  const body: any = await fiftyOne.json();
  assert.equal(body.code, "QUERY_CAPACITY_EXCEEDED");
  assert.equal(body.totalMatchingRecords, 51);
});

test("five publishers discover, quote, settle and recover ten unique records with distinct payouts", async () => {
  const records = stressRecords(5, 1, 2);
  const state = fixture(records, arkivDiscoveryClient(records));
  const publisherResponse = await requestApp(state.app, "/publishers");
  const datasetResponse = await requestApp(state.app, "/datasets");
  const discoveredPublishers: any = await publisherResponse.json();
  const discoveredDatasets: any = await datasetResponse.json();
  assert.equal(publisherResponse.status, 200);
  assert.equal(datasetResponse.status, 200);
  assert.equal(discoveredPublishers.publishers.length, 5);
  assert.equal(discoveredDatasets.datasets.length, 5);
  assert.equal(new Set(discoveredPublishers.publishers.map((item: any) => item.address.toLowerCase())).size, 5);

  const quoteResponse = await requestApp(state.app, "/query/quote", postJson(quoteBody(50)));
  assert.equal(quoteResponse.status, 201);
  const quote: any = await quoteResponse.json();
  assert.equal(quote.manifest.allocations.length, 5);
  assert.equal(quote.manifest.allocations.reduce((sum: number, item: any) => sum + item.recordCount, 0), 10);
  assert.equal(quote.records.length, 10);
  assert.equal(BigInt(quote.manifest.totalAmount), quote.manifest.allocations.reduce((sum: bigint, item: any) => sum + BigInt(item.payoutAmount), 0n));
  assert.equal(quote.manifest.resultRoot.toLowerCase(), hashResultRoot(quote.manifest.allocations.map((item: any) => ({ ...item,
    publisherNonce: BigInt(item.publisherNonce), policyNonce: BigInt(item.policyNonce), grantNonce: BigInt(item.grantNonce), payoutAmount: BigInt(item.payoutAmount) }))).toLowerCase());
  for (const allocation of quote.manifest.allocations) {
    const source = records.find((row) => row.datasetId.toLowerCase() === allocation.datasetId.toLowerCase())!;
    assert.equal(allocation.publisher.toLowerCase(), source.publisher.toLowerCase());
    assert.deepEqual([...allocation.recordHashes].sort(), records.filter((row) => row.datasetId === source.datasetId).map((row) => row.contentHash).sort());
    assert.equal(BigInt(allocation.payoutAmount), BigInt(allocation.recordCount) * source.pricePerRecord);
    assert.ok(state.payoutFor(allocation.publisher) !== "0x0000000000000000000000000000000000000000");
  }
  assert.equal(new Set(quote.manifest.allocations.map((item: any) => state.payoutFor(item.publisher).toLowerCase())).size, 5);
  const proof = settlementProof(quote, state.payoutFor);
  const decoded = decodeFunctionData({ abi: settlementCallAbi, data: proof.input });
  assert.equal(decoded.functionName, "settle");
  assert.equal(decoded.args[0].resultRoot.toLowerCase(), quote.manifest.resultRoot.toLowerCase());
  const paidEvents = proof.logs.flatMap((entry: any) => {
    try { const event = decodeEventLog({ abi: [allocationPaidEvent], data: entry.data, topics: entry.topics }); return event.eventName === "AllocationPaid" ? [event.args] : []; } catch { return []; }
  });
  assert.equal(paidEvents.length, 5);
  const tokenTransfers = proof.logs.flatMap((entry: any) => {
    try { const event = decodeEventLog({ abi: [erc20TransferEvent], data: entry.data, topics: entry.topics }); return event.eventName === "Transfer" && event.args.from.toLowerCase() === settlementAddress.toLowerCase() ? [event.args] : []; } catch { return []; }
  });
  assert.equal(tokenTransfers.length, 5);
  assert.equal(new Set(tokenTransfers.map((item: any) => item.to.toLowerCase())).size, 5);
  assert.equal(tokenTransfers.reduce((sum: bigint, item: any) => sum + item.value, 0n), BigInt(quote.manifest.totalAmount));
  for (const allocation of quote.manifest.allocations) {
    const event: any = paidEvents.find((item: any) => item.datasetId.toLowerCase() === allocation.datasetId.toLowerCase());
    assert.equal(event.publisher.toLowerCase(), allocation.publisher.toLowerCase());
    assert.equal(event.payout.toLowerCase(), state.payoutFor(allocation.publisher).toLowerCase());
    assert.equal(event.amount, BigInt(allocation.payoutAmount));
  }
  state.setTransactionInput(proof.input); state.setReceiptLogs(proof.logs); state.setSettled(true);
  const txHash = `0x${"ab".repeat(32)}` as Hex;
  const delivery = await requestApp(state.app, `/query/${quote.quoteId}/deliver`, postJson(await signedDeliveryBody(quote.quoteId, txHash)));
  assert.equal(delivery.status, 200);
  const result: any = await delivery.json();
  assert.equal(result.records.length, 10);
  assert.equal(new Set(result.records.map((row: any) => `${row.datasetId}:${row.recordHash}`)).size, 10);
  assert.deepEqual(result.records.map((row: any) => row.payload).sort((a: any, b: any) => a.body.localeCompare(b.body)), records.map((row) => row.payload).sort((a: any, b: any) => String((a as any).body).localeCompare(String((b as any).body))));

  const permutedState = fixture([...records].reverse());
  const permutedQuote: any = await (await requestApp(permutedState.app, "/query/quote", postJson(quoteBody(50)))).json();
  assert.deepEqual(permutedQuote.manifest.allocations.map((item: any) => [item.datasetId, item.recordHashes]), quote.manifest.allocations.map((item: any) => [item.datasetId, item.recordHashes]));
});

test("maximum query capacity constructs and recovers 10 allocations and 50 records", async () => {
  const records = stressRecords(5, 2, 5);
  const state = fixture(records);
  const quoteResponse = await requestApp(state.app, "/query/quote", postJson(quoteBody(50)));
  assert.equal(quoteResponse.status, 201);
  const quote: any = await quoteResponse.json();
  assert.equal(quote.manifest.allocations.length, 10);
  assert.equal(quote.manifest.allocations.reduce((sum: number, item: any) => sum + item.recordCount, 0), 50);
  assert.equal(quote.records.length, 50);
  assert.equal(BigInt(quote.manifest.totalAmount), quote.manifest.allocations.reduce((sum: bigint, item: any) => sum + BigInt(item.payoutAmount), 0n));
  assert.deepEqual(quote.manifest.allocations.map((item: any) => item.datasetId), [...quote.manifest.allocations.map((item: any) => item.datasetId)].sort((a: string, b: string) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
  for (const allocation of quote.manifest.allocations) {
    assert.equal(allocation.recordHashes.length, 5);
    assert.deepEqual(allocation.recordHashes, [...allocation.recordHashes].sort((a: string, b: string) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
    assert.equal(BigInt(allocation.payoutAmount), BigInt(allocation.recordCount) * 1_000_000n);
  }
  const proof = settlementProof(quote, state.payoutFor);
  const decoded = decodeFunctionData({ abi: settlementCallAbi, data: proof.input });
  assert.equal(decoded.functionName, "settle");
  assert.equal(decoded.args[0].allocations.length, 10);
  assert.equal(decoded.args[0].allocations.reduce((sum, item) => sum + item.recordHashes.length, 0), 50);
  state.setTransactionInput(proof.input); state.setReceiptLogs(proof.logs); state.setSettled(true);
  const txHash = `0x${"ac".repeat(32)}` as Hex;
  const delivery = await requestApp(state.app, `/query/${quote.quoteId}/deliver`, postJson(await signedDeliveryBody(quote.quoteId, txHash)));
  assert.equal(delivery.status, 200);
  const result: any = await delivery.json();
  assert.equal(result.records.length, 50);
  assert.equal(new Set(result.records.map((row: any) => row.recordHash.toLowerCase())).size, 50);
  assert.deepEqual(result.records.map((row: any) => row.recordHash).sort(), quote.manifest.allocations.flatMap((item: any) => item.recordHashes).sort());
});

test("a buyer result limit reports complete matches separately from payable records", async () => {
  const base = makeRecord(0);
  const records = Array.from({ length: 25 }, (_, index) => ({ ...base,
    entityKey: `0x${(index + 1).toString(16).padStart(64, "0")}` as Hex,
    contentHash: `0x${(index + 1001).toString(16).padStart(64, "0")}` as Hex,
    payloadHash: `0x${(index + 2001).toString(16).padStart(64, "0")}` as Hex,
  }));
  const response = await requestApp(fixture(records).app, "/query/quote", postJson(quoteBody(20)));
  assert.equal(response.status, 201);
  const quote: any = await response.json();
  assert.equal(quote.totalMatchingRecords, 25);
  assert.equal(quote.eligibleRecords, 20);
  assert.equal(quote.records.length, 20);
});

test("one publisher can receive separate allocations for multiple datasets", async () => {
  const first = makeRecord(0);
  const second = { ...makeRecord(1), publisher: first.publisher, datasetId: `0x${"ee".repeat(32)}` as Hex };
  const response = await requestApp(fixture([first, second]).app, "/query/quote", postJson(quoteBody(50)));
  assert.equal(response.status, 201);
  const quote: any = await response.json();
  assert.equal(quote.manifest.allocations.length, 2);
  assert.equal(quote.manifest.allocations[0].publisher, quote.manifest.allocations[1].publisher);
  assert.notEqual(quote.manifest.allocations[0].datasetId, quote.manifest.allocations[1].datasetId);
});

test("duplicate content hashes within or across datasets reject quote construction", async () => {
  const first = makeRecord(0);
  const sameDataset = { ...first, entityKey: `0x${"aa".repeat(32)}` as Hex };
  const sameDatasetResponse = await requestApp(fixture([first, sameDataset]).app, "/query/quote", postJson(quoteBody(50)));
  assert.equal(sameDatasetResponse.status, 422);
  assert.equal((await sameDatasetResponse.json() as any).code, "DUPLICATE_CONTENT_HASH");
  const otherDataset = { ...makeRecord(1), contentHash: first.contentHash };
  const crossDatasetResponse = await requestApp(fixture([first, otherDataset]).app, "/query/quote", postJson(quoteBody(50)));
  assert.equal(crossDatasetResponse.status, 422);
  assert.equal((await crossDatasetResponse.json() as any).code, "DUPLICATE_CONTENT_HASH");
});

test("an incomplete record scan never produces a payable quote", async () => {
  const records = [makeRecord(0)];
  const app = fixture(records, {}, undefined, async () => ({ records, totalMatching: 101, complete: false, pagesScanned: 20 })).app;
  const response = await requestApp(app, "/query/quote", postJson(quoteBody(50)));
  assert.equal(response.status, 503);
  assert.equal((await response.json() as any).code, "INCOMPLETE_RESULTS");
});

test("publisher and dataset discovery paginate past the first 100 Arkiv entities", async () => {
  const wrongOwner = "0x00000000000000000000000000000000000000ff" as Address;
  const profileRows = Array.from({ length: 101 }, (_, index) => ({ $key: `0x${(index + 1).toString(16).padStart(64, "0")}` as Hex,
    $owner: wrongOwner, wallet: { value: buyer }, status: { value: "active" }, displayName: { value: `p${index}` }, payoutAddress: { value: buyer } }));
  const datasetRows = Array.from({ length: 101 }, (_, index) => ({ $key: `0x${(index + 1).toString(16).padStart(64, "0")}` as Hex,
    $owner: wrongOwner, datasetId: { value: `0x${(index + 1).toString(16).padStart(64, "0")}` }, publisher: { value: buyer }, category: { value: "defi" }, status: { value: "active" }, title: { value: "d" }, description: { value: "d" } }));
  const calls = new Map<any, number>();
  const arkiv = { select() { let schema: any; const builder = {
    from(value: any) { schema = value; return this; }, where() { return this; }, orderBy() { return this; }, limit() { return this; },
    async fetch() { const rows = schema === PublisherProfile ? profileRows : datasetRows; const offset = calls.get(schema) ?? 0; calls.set(schema, offset + 1); return { entities: rows.slice(offset * 100, (offset + 1) * 100) }; },
  }; return builder; } };
  const app = fixture([], arkiv).app;
  const publishers = await requestApp(app, "/publishers");
  const datasets = await requestApp(app, "/datasets");
  assert.equal(publishers.status, 200);
  assert.equal(datasets.status, 200);
  assert.deepEqual(await publishers.json(), { publishers: [] });
  assert.deepEqual(await datasets.json(), { datasets: [] });
  assert.equal(calls.get(PublisherProfile), 2);
  assert.equal(calls.get(DatasetManifest), 2);
});

test("discovery page-cap exhaustion returns an explicit incomplete result, not an empty list", async () => {
  const wrongOwner = "0x00000000000000000000000000000000000000ff" as Address;
  let page = 0;
  const arkiv = { select() { const builder = {
    from() { return this; }, where() { return this; }, orderBy() { return this; }, limit() { return this; },
    async fetch() { const index = page++ * 100; return { entities: Array.from({ length: 100 }, (_, offset) => ({ $key: `0x${(index + offset + 1).toString(16).padStart(64, "0")}` as Hex,
      $owner: wrongOwner, wallet: { value: buyer }, status: { value: "active" }, displayName: { value: "profile" }, payoutAddress: { value: buyer } })) }; },
  }; return builder; } };
  const response = await requestApp(fixture([], arkiv).app, "/publishers");
  assert.equal(response.status, 503);
  assert.equal((await response.json() as any).code, "INCOMPLETE_RESULTS");
  assert.equal(page, 20);
});

test("high value quote requires and verifies publisher typed-data approval", async () => {
  const row = makeRecord(0);
  row.publisherSignatureThreshold = 1_000_000n;
  const state = fixture([row]);
  const quoteResponse = await requestApp(state.app, "/query/quote", postJson(quoteBody()));
  assert.equal(quoteResponse.status, 201);
  const quote: any = await quoteResponse.json();
  assert.equal(quote.publisherApprovalRequests.length, 1);
  const request = quote.publisherApprovalRequests[0];
  const message = {
    ...request.message,
    publisherNonce: BigInt(request.message.publisherNonce), policyNonce: BigInt(request.message.policyNonce),
    grantNonce: BigInt(request.message.grantNonce), payoutAmount: BigInt(request.message.payoutAmount), deadline: BigInt(request.message.deadline),
  };
  const publisherAccount = privateKeyToAccount(`0x${String(100).padStart(64, "0")}` as Hex);
  const signature = await publisherAccount.signTypedData({ domain: request.domain as any, types: publisherApprovalTypes, primaryType: "PublisherApproval", message: message as any });
  const submission = await requestApp(state.app, `/query/${quote.quoteId}/publisher-approval`, postJson(JSON.stringify({ datasetId: request.datasetId, signature })));
  assert.equal(submission.status, 200);
  const refreshed = await requestApp(state.app, `/query/${quote.quoteId}/quote`);
  const result: any = await refreshed.json();
  assert.equal(result.approvalsMissing.length, 0);
  assert.equal(result.manifest.allocations[0].publisherSignature, signature);
});

test("delivery before a matching settlement is rejected", async () => {
  const state = fixture([makeRecord(0)]);
  const quoteResponse = await requestApp(state.app, "/query/quote", postJson(quoteBody()));
  const quote: any = await quoteResponse.json();
  const txHash = `0x${"44".repeat(32)}` as Hex;
  const response = await requestApp(state.app, `/query/${quote.quoteId}/deliver`, postJson(await signedDeliveryBody(quote.quoteId, txHash)));
  assert.equal(response.status, 403);
});

test("settled delivery succeeds and duplicate delivery is idempotent", async () => {
  const state = fixture([makeRecord(0)]);
  const quoteResponse = await requestApp(state.app, "/query/quote", postJson(quoteBody()));
  const quote: any = await quoteResponse.json();
  const proof = settlementProof(quote);
  state.setTransactionInput(proof.input); state.setReceiptLogs(proof.logs);
  state.setSettled(true);
  const txHash = `0x${"44".repeat(32)}` as Hex;
  const body = await signedDeliveryBody(quote.quoteId, txHash);
  const first = await requestApp(state.app, `/query/${quote.quoteId}/deliver`, postJson(body));
  assert.equal(first.status, 200);
  const firstResult: any = await first.json();
  assert.equal(firstResult.records[0].payload.secret, "payload-0");
  assert.equal(firstResult.duplicateRequest, false);
  const second = await requestApp(state.app, `/query/${quote.quoteId}/deliver`, postJson(body));
  assert.equal(second.status, 200);
  assert.equal((await second.json() as any).duplicateRequest, true);
});

test("settled delivery can recover after coordinator quote-cache restart", async () => {
  const records = [makeRecord(0), makeRecord(1)];
  const original = fixture(records);
  const quoteResponse = await requestApp(original.app, "/query/quote", postJson(quoteBody()));
  const quote: any = await quoteResponse.json();
  const proof = settlementProof(quote);
  const restarted = fixture(records);
  restarted.setTransactionInput(proof.input); restarted.setReceiptLogs(proof.logs); restarted.setSettled(true);
  const txHash = `0x${"44".repeat(32)}` as Hex;
  const response = await requestApp(restarted.app, `/query/${quote.quoteId}/deliver`, postJson(await signedDeliveryBody(quote.quoteId, txHash)));
  assert.equal(response.status, 200);
  const result: any = await response.json();
  assert.equal(result.records.length, 2);
  assert.deepEqual(result.records.map((row: any) => row.recordHash).sort(), quote.manifest.allocations.flatMap((row: any) => row.recordHashes).sort());
});

test("quote and in-memory publisher approval are unavailable after restart before settlement", async () => {
  const row = { ...makeRecord(0), publisherSignatureThreshold: 1_000_000n };
  const original = fixture([row]);
  const quote: any = await (await requestApp(original.app, "/query/quote", postJson(quoteBody()))).json();
  assert.equal(quote.publisherApprovalRequests.length, 1);
  const approval = quote.publisherApprovalRequests[0];
  const message = { ...approval.message, publisherNonce: BigInt(approval.message.publisherNonce), policyNonce: BigInt(approval.message.policyNonce),
    grantNonce: BigInt(approval.message.grantNonce), payoutAmount: BigInt(approval.message.payoutAmount), deadline: BigInt(approval.message.deadline) };
  const publisherAccount = privateKeyToAccount(`0x${String(100).padStart(64, "0")}` as Hex);
  const signature = await publisherAccount.signTypedData({ domain: approval.domain as any, types: publisherApprovalTypes, primaryType: "PublisherApproval", message: message as any });
  const approved = await requestApp(original.app, `/query/${quote.quoteId}/publisher-approval`, postJson(JSON.stringify({ datasetId: approval.datasetId, signature })));
  assert.equal(approved.status, 200);
  const restarted = fixture([row]);
  const response = await requestApp(restarted.app, `/query/${quote.quoteId}/quote`);
  assert.equal(response.status, 404);
  assert.match((await response.json() as any).error, /unknown or expired/i);
});

test("delivery rejects a reverted settlement even when the request is otherwise valid", async () => {
  const state = fixture([makeRecord(0)]);
  const quote: any = await (await requestApp(state.app, "/query/quote", postJson(quoteBody()))).json();
  const proof = settlementProof(quote); state.setTransactionInput(proof.input); state.setReceiptLogs(proof.logs); state.setReceiptStatus("reverted"); state.setSettled(true);
  const txHash = `0x${"44".repeat(32)}` as Hex;
  const response = await requestApp(state.app, `/query/${quote.quoteId}/deliver`, postJson(await signedDeliveryBody(quote.quoteId, txHash)));
  assert.equal(response.status, 403);
});

test("delivery rejects a successful unrelated transaction with non-settlement calldata", async () => {
  const state = fixture([makeRecord(0)]);
  const quote: any = await (await requestApp(state.app, "/query/quote", postJson(quoteBody()))).json();
  state.setSettled(true);
  const txHash = `0x${"44".repeat(32)}` as Hex;
  const response = await requestApp(state.app, `/query/${quote.quoteId}/deliver`, postJson(await signedDeliveryBody(quote.quoteId, txHash)));
  assert.equal(response.status, 403);
  assert.match((await response.json() as any).error, /calldata is invalid/i);
});

test("delivery rejects a buyer identity mismatch", async () => {
  const state = fixture([makeRecord(0)]);
  const quote: any = await (await requestApp(state.app, "/query/quote", postJson(quoteBody()))).json();
  const txHash = `0x${"44".repeat(32)}` as Hex;
  const response = await requestApp(state.app, `/query/${quote.quoteId}/deliver`, postJson(await signedDeliveryBody(quote.quoteId, txHash, coordinator.address)));
  assert.equal(response.status, 403);
});

test("delivery rejects unsigned callers even when they know the buyer and settlement transaction", async () => {
  const state = fixture([makeRecord(0)]);
  const quote: any = await (await requestApp(state.app, "/query/quote", postJson(quoteBody()))).json();
  const response = await requestApp(state.app, `/query/${quote.quoteId}/deliver`, postJson(JSON.stringify({ transactionHash: `0x${"44".repeat(32)}`, buyer })));
  assert.equal(response.status, 400);
});

test("delivery rejects a signature for a different settlement transaction hash", async () => {
  const state = fixture([makeRecord(0)]);
  const quote: any = await (await requestApp(state.app, "/query/quote", postJson(quoteBody()))).json();
  const txHash = `0x${"44".repeat(32)}` as Hex;
  const body = await signedDeliveryBody(quote.quoteId, `0x${"55".repeat(32)}` as Hex);
  const response = await requestApp(state.app, `/query/${quote.quoteId}/deliver`, postJson(body));
  assert.equal(response.status, 403);
});

test("delivery rejects a payout event that differs from the signed allocation", async () => {
  const state = fixture([makeRecord(0)]);
  const quote: any = await (await requestApp(state.app, "/query/quote", postJson(quoteBody()))).json();
  const proof = settlementProof(quote);
  proof.logs[0] = proof.logs[0];
  proof.logs[1] = { ...proof.logs[1], data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint32" }], [makeRecord(0).publisher, 2_000_000n, 1]) };
  state.setTransactionInput(proof.input); state.setReceiptLogs(proof.logs); state.setSettled(true);
  const txHash = `0x${"44".repeat(32)}` as Hex;
  const response = await requestApp(state.app, `/query/${quote.quoteId}/deliver`, postJson(await signedDeliveryBody(quote.quoteId, txHash)));
  assert.equal(response.status, 403);
});

test("delivery rejects a receipt with a missing publisher payout event", async () => {
  const state = fixture([makeRecord(0)]);
  const quote: any = await (await requestApp(state.app, "/query/quote", postJson(quoteBody()))).json();
  const proof = settlementProof(quote);
  state.setTransactionInput(proof.input); state.setReceiptLogs(proof.logs.filter((entry: any) => {
    if (entry.address?.toLowerCase() !== settlementAddress.toLowerCase()) return true;
    try { return decodeEventLog({ abi: [allocationPaidEvent], data: entry.data, topics: entry.topics }).eventName !== "AllocationPaid"; } catch { return true; }
  })); state.setSettled(true);
  const txHash = `0x${"44".repeat(32)}` as Hex;
  const response = await requestApp(state.app, `/query/${quote.quoteId}/deliver`, postJson(await signedDeliveryBody(quote.quoteId, txHash)));
  assert.equal(response.status, 403);
});

test("delivery rejects ambiguous Arkiv records even when only one duplicate has the expected owner", async () => {
  const publisher = makeRecord(0).publisher;
  const payload = { secret: "arkiv-owned-record" };
  const serialized = stableJson(payload);
  const hash = contentHash(serialized);
  const encrypted = encryptPayload(`0x${"33".repeat(32)}` as Hex, serialized);
  const row = { ...makeRecord(0), contentHash: hash, payload };
  const entity = (owner: Address) => ({ $owner: owner, datasetId: { value: row.datasetId }, contentHash: { value: hash },
    payloadHash: { value: encryptedPayloadHash(encrypted) }, encryptedPayload: { value: `0x${Buffer.from(encrypted).toString("hex")}` } });
  const builder = { from() { return this; }, where() { return this; }, limit() { return this; }, async fetch() { return { entities: [entity(publisher), entity(coordinator.address)] }; } };
  const state = fixture([row], { select() { return builder; } }, null, async () => [row]);
  const quote: any = await (await requestApp(state.app, "/query/quote", postJson(quoteBody()))).json();
  const proof = settlementProof(quote); state.setTransactionInput(proof.input); state.setReceiptLogs(proof.logs); state.setSettled(true);
  const txHash = `0x${"44".repeat(32)}` as Hex;
  const response = await requestApp(state.app, `/query/${quote.quoteId}/deliver`, postJson(await signedDeliveryBody(quote.quoteId, txHash)));
  assert.equal(response.status, 403);
  assert.match((await response.json() as any).error, /duplicated/i);
});

test("delivery rejects missing or altered record hashes and counts", async () => {
  const row = makeRecord(0);
  const state = fixture([row], {}, async () => []);
  const quote: any = await (await requestApp(state.app, "/query/quote", postJson(quoteBody()))).json();
  const proof = settlementProof(quote); state.setTransactionInput(proof.input); state.setReceiptLogs(proof.logs); state.setSettled(true);
  const txHash = `0x${"44".repeat(32)}` as Hex;
  const response = await requestApp(state.app, `/query/${quote.quoteId}/deliver`, postJson(await signedDeliveryBody(quote.quoteId, txHash)));
  assert.equal(response.status, 403);
});

test("delivery rejects a returned record whose content hash is not in the manifest", async () => {
  const row = makeRecord(0);
  const state = fixture([row], {}, async () => [{ publisher: row.publisher, datasetId: row.datasetId, recordHash: `0x${"ff".repeat(32)}`, payload: row.payload }]);
  const quote: any = await (await requestApp(state.app, "/query/quote", postJson(quoteBody()))).json();
  const proof = settlementProof(quote); state.setTransactionInput(proof.input); state.setReceiptLogs(proof.logs); state.setSettled(true);
  const txHash = `0x${"44".repeat(32)}` as Hex;
  const response = await requestApp(state.app, `/query/${quote.quoteId}/deliver`, postJson(await signedDeliveryBody(quote.quoteId, txHash)));
  assert.equal(response.status, 403);
});

test("publisher earnings are summed from AllocationPaid logs", async () => {
  const row = makeRecord(0);
  const state = fixture([row]);
  state.setLogs([{ args: { queryId: `0x${"55".repeat(32)}`, datasetId: row.datasetId, publisher: row.publisher,
    payout: row.publisher, amount: 1_250_000n, recordCount: 1 }, transactionHash: `0x${"66".repeat(32)}`, blockNumber: 101n }]);
  const response = await requestApp(state.app, `/publishers/${row.publisher}/earnings`);
  assert.equal(response.status, 200);
  const result: any = await response.json();
  assert.equal(result.totalAmount, "1250000");
  assert.equal(result.settlements.length, 1);
});
