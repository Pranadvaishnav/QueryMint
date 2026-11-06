import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { encodeAbiParameters, encodeEventTopics, parseAbiItem, recoverAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hashQueryManifest, publisherApprovalTypes, type Allocation } from "@querymint/shared";
import { createQueryMint } from "../../../packages/sdk/src/index.js";
import { createCoordinatorApp } from "../src/api.js";
import type { VerifiedRecord } from "../src/arkiv/query.js";

const settlementAddress = "0x0000000000000000000000000000000000001874" as Address;
const coordinator = privateKeyToAccount(`0x${"11".repeat(32)}` as Hex);
const buyer = privateKeyToAccount(`0x${"22".repeat(32)}` as Hex).address;
const querySettledEvent = parseAbiItem("event QuerySettled(bytes32 indexed queryId,address indexed buyer,address indexed coordinator,uint256 totalAmount,bytes32 resultRoot,bytes32 manifestDigest)");

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

function fixture(records: VerifiedRecord[]) {
  const states = new Map(records.map((row) => [row.datasetId.toLowerCase(), row]));
  let settled = false;
  let receiptLogs: any[] = [];
  let logs: any[] = [];
  const client = {
    async getBlockNumber() { return 100n; },
    async getBlock() { return { timestamp: 1_000n }; },
    async readContract(args: any) {
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
        const row = records.find((item) => item.publisher.toLowerCase() === args.args[0].toLowerCase())!;
        return [row.publisher, row.publisherNonce, true];
      }
      if (args.functionName === "settledQueries") return settled;
      throw new Error(`Unexpected read ${args.functionName}`);
    },
    async getLogs() { return logs; },
    async getTransactionReceipt() { return { status: "success", blockNumber: 101n, logs: receiptLogs }; },
    async getTransaction() { return { from: buyer, to: settlementAddress }; },
  };
  const app = createCoordinatorApp({
    arkivClient: {}, whitechainClient: client as any, settlementAddress, coordinatorAccount: coordinator,
    encryptionKey: `0x${"33".repeat(32)}` as Hex, deploymentBlock: 0n, now: () => 1_000_000,
    queryRecords: async () => records,
  });
  return { app, setSettled: (value: boolean) => { settled = value; }, setReceiptLogs: (value: any[]) => { receiptLogs = value; }, setLogs: (value: any[]) => { logs = value; } };
}

async function requestApp(app: ReturnType<typeof createCoordinatorApp>, path: string, init?: RequestInit) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  try { return await fetch(`http://127.0.0.1:${address.port}${path}`, init); }
  finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

const quoteBody = () => JSON.stringify({ buyer, where: { category: "defi" }, limit: 20 });
const postJson = (body: string) => ({ method: "POST", headers: { "content-type": "application/json" }, body });

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

test("coordinator exposes a local health route", async () => {
  const response = await requestApp(fixture([makeRecord(0)]).app, "/health");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
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
  const response = await requestApp(state.app, `/query/${quote.quoteId}/deliver`, postJson(JSON.stringify({ transactionHash: `0x${"44".repeat(32)}`, buyer })));
  assert.equal(response.status, 403);
});

test("settled delivery succeeds and duplicate delivery is idempotent", async () => {
  const state = fixture([makeRecord(0)]);
  const quoteResponse = await requestApp(state.app, "/query/quote", postJson(quoteBody()));
  const quote: any = await quoteResponse.json();
  const topics = encodeEventTopics({ abi: [querySettledEvent], eventName: "QuerySettled", args: { queryId: quote.quoteId, buyer, coordinator: coordinator.address } });
  const data = encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }], [BigInt(quote.manifest.totalAmount), quote.manifest.resultRoot, `0x${"00".repeat(32)}`]);
  state.setReceiptLogs([{ address: settlementAddress, topics, data }]);
  state.setSettled(true);
  const body = JSON.stringify({ transactionHash: `0x${"44".repeat(32)}`, buyer });
  const first = await requestApp(state.app, `/query/${quote.quoteId}/deliver`, postJson(body));
  assert.equal(first.status, 200);
  const firstResult: any = await first.json();
  assert.equal(firstResult.records[0].payload.secret, "payload-0");
  assert.equal(firstResult.duplicateRequest, false);
  const second = await requestApp(state.app, `/query/${quote.quoteId}/deliver`, postJson(body));
  assert.equal(second.status, 200);
  assert.equal((await second.json() as any).duplicateRequest, true);
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
