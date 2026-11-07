import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createQueryMint, type QueryMintQuote } from "@querymint/sdk";
import { hashAllocations, hashResultRoot, queryManifestTypes, type Allocation } from "@querymint/shared";

const buyer = "0x1111111111111111111111111111111111111111" as const;
const publisher = "0x2222222222222222222222222222222222222222" as const;
const coordinatorAccount = privateKeyToAccount(`0x${"33".repeat(32)}` as const);
const coordinator = coordinatorAccount.address;
const settlement = "0x4444444444444444444444444444444444444444" as const;
const datasetId = `0x${"55".repeat(32)}` as const;
const queryId = `0x${"66".repeat(32)}` as const;
const recordHash = `0x${"99".repeat(32)}` as const;
const allocation = { publisher, datasetId, publisherNonce: 0n, policyNonce: 0n, grantNonce: 0n,
  recordCount: 1, recordHashes: [recordHash], payoutAmount: 1_000_000n, publisherSignature: "0x" as const } satisfies Allocation;
const resultRoot = hashResultRoot([allocation]);
const digest = `0x${"88".repeat(32)}` as const;
const approvalHash = `0x${"aa".repeat(32)}` as const;
const settlementHash1 = `0x${"bb".repeat(32)}` as const;
const settlementHash2 = `0x${"cc".repeat(32)}` as const;
const querySettled = parseAbiItem("event QuerySettled(bytes32 indexed queryId,address indexed buyer,address indexed coordinator,uint256 totalAmount,bytes32 resultRoot,bytes32 manifestDigest)");
const receipt = {
  status: "success", blockNumber: 123n, logs: [{
    address: settlement,
    topics: encodeEventTopics({ abi: [querySettled], eventName: "QuerySettled", args: { queryId, buyer, coordinator } }),
    data: encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }], [1_000_000n, resultRoot, digest]),
  }],
} as any;

async function makeHarness(options: { allowance?: bigint; failFirstSettlement?: boolean; expired?: boolean; invalidPolicy?: boolean; badDelivery?: boolean; wrongPublicChain?: boolean; invalidSignature?: boolean } = {}) {
  let allowance = options.allowance ?? 0n;
  const calls: string[] = [];
  const stages: Array<{ stage: string; status: string }> = [];
  let signedDelivery = false;
  let deliveryRequests = 0;
  let settlementWrites = 0;
  const walletClient = {
    account: { address: buyer }, chain: { id: 1874 },
    getChainId: async () => 1874,
    writeContract: async ({ functionName }: { functionName: string }) => {
      calls.push(functionName);
      if (functionName === "approve") { allowance = 1_000_000n; return approvalHash; }
      settlementWrites++;
      return settlementWrites === 1 ? settlementHash1 : settlementHash2;
    },
    signTypedData: async () => { signedDelivery = true; return `0x${"11".repeat(65)}`; },
  } as any;
  const publicClient = {
    getChainId: async () => options.wrongPublicChain ? 1 : 1874,
    getBlock: async () => ({ timestamp: options.expired ? 2_000n : 100n }),
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "settledQueries") return false;
      if (functionName === "allowance") return allowance;
      if (functionName === "publishers") return [publisher, 0n, true];
      if (functionName === "datasetPublisher") return publisher;
      if (functionName === "datasetPolicies") return [1_000_000n, 10_000_000n, 0n, 20, 1_900n, options.invalidPolicy ? 1n : 0n, true];
      if (functionName === "coordinatorGrants") return [1_800n, 0n, true];
      throw new Error(`Unexpected contract read ${functionName}`);
    },
    waitForTransactionReceipt: async ({ hash }: { hash: string }) => {
      if (hash === approvalHash) return { status: "success" };
      if (options.failFirstSettlement && hash === settlementHash1) return { status: "reverted" };
      return receipt;
    },
    getTransactionReceipt: async () => receipt,
  } as any;
  const domain = { name: "QueryMint" as const, version: "1" as const, chainId: 1874 as const, verifyingContract: settlement };
  const unsignedManifest = {
    queryId, buyer, coordinator, token: "0xcedfb56113143d55b2358b8cfbb0deb5ad2f55a7" as const, totalAmount: 1_000_000n,
    deadline: 1_000n, resultRoot, allocations: [allocation],
  };
  const coordinatorSignature = await coordinatorAccount.signTypedData({ domain, types: queryManifestTypes, primaryType: "QueryManifest",
    message: { ...unsignedManifest, allocationsHash: hashAllocations(domain, unsignedManifest.allocations) } });
  const manifest = { ...unsignedManifest, coordinatorSignature };
  const refreshedManifest = options.invalidSignature ? { ...manifest, coordinatorSignature: `0x${"ff".repeat(65)}` } : manifest;
  const quote = { quoteId: queryId, manifest, settlementAddress: settlement,
    records: [{ publisher, datasetId, recordHash, preview: "preview" }], totalMatchingRecords: 1, eligibleRecords: 1, searchComplete: true,
    breakdown: [{ publisher, datasetId, recordCount: 1, pricePerRecord: "1000000", payoutAmount: "1000000" }], publisherApprovalRequests: [] } as QueryMintQuote;
  const sdk = createQueryMint({ apiUrl: "http://coordinator", settlementAddress: settlement, walletClient, publicClient,
    fetch: async (_input, init) => init?.method === "POST"
      ? (deliveryRequests++, new Response(JSON.stringify({ queryId: options.badDelivery ? `0x${"00".repeat(32)}` : queryId,
        transactionHash: settlementWrites === 1 ? settlementHash1 : settlementHash2, records: [{ publisher, datasetId, recordHash, payload: { value: "licensed" } }], blockNumber: "123" }), { status: 200 }))
      : new Response(JSON.stringify({ quoteId: queryId, manifest: { ...refreshedManifest, totalAmount: "1000000", deadline: "1000", allocations: refreshedManifest.allocations.map((a: any) => ({ ...a, publisherNonce: "0", policyNonce: "0", grantNonce: "0", payoutAmount: "1000000" })) }, approvalsMissing: [] }), { status: 200 }),
    onPaymentStep: (step) => stages.push({ stage: step.stage, status: step.status }),
  });
  return { sdk, quote, calls, stages, get signedDelivery() { return signedDelivery; }, get deliveryRequests() { return deliveryRequests; } };
}

test("exact approval confirms before settlement and delivery follows confirmed receipt", async () => {
  const h = await makeHarness();
  const result = await h.sdk.pay({ quote: h.quote });
  assert.deepEqual(h.calls, ["approve", "settle"]);
  assert.equal(result.records.length, 1);
  assert.equal(h.signedDelivery, true);
  assert.equal(h.deliveryRequests, 1);
  assert.ok(h.stages.some((s) => s.stage === "approval" && s.status === "confirmed"));
  assert.ok(h.stages.some((s) => s.stage === "settlement" && s.status === "confirmed"));
});

test("approval remains confirmed when settlement reverts and retry does not approve again", async () => {
  const h = await makeHarness({ failFirstSettlement: true });
  await assert.rejects(h.sdk.pay({ quote: h.quote }), /Settlement transaction failed/);
  assert.ok(h.stages.some((s) => s.stage === "approval" && s.status === "confirmed"));
  assert.ok(h.stages.some((s) => s.stage === "settlement" && s.status === "failed"));
  const result = await h.sdk.pay({ quote: h.quote });
  assert.equal(result.records.length, 1);
  assert.deepEqual(h.calls, ["approve", "settle", "settle"]);
});

test("sufficient existing allowance skips approval", async () => {
  const h = await makeHarness({ allowance: 1_000_000n });
  await h.sdk.pay({ quote: h.quote });
  assert.deepEqual(h.calls, ["settle"]);
  assert.ok(h.stages.some((s) => s.stage === "approval" && s.status === "skipped"));
});

test("expired or changed authorization is rejected before any transaction", async () => {
  const h = await makeHarness({ expired: true });
  await assert.rejects(h.sdk.pay({ quote: h.quote }), /expired/i);
  assert.deepEqual(h.calls, []);
  const changed = await makeHarness({ invalidPolicy: true });
  await assert.rejects(changed.sdk.pay({ quote: changed.quote }), /authorization changed/i);
  assert.deepEqual(changed.calls, []);
});

test("payment rejects a public client pointed at another chain before any transaction", async () => {
  const h = await makeHarness({ wrongPublicChain: true });
  await assert.rejects(h.sdk.pay({ quote: h.quote }), /Whitechain Sepolia/);
  assert.deepEqual(h.calls, []);
});

test("payment rejects a bad coordinator signature before any transaction", async () => {
  const h = await makeHarness({ invalidSignature: true });
  await assert.rejects(h.sdk.pay({ quote: h.quote }), /coordinator signature/);
  assert.deepEqual(h.calls, []);
});

test("delivery is not requested if settlement receipt fails", async () => {
  const h = await makeHarness({ failFirstSettlement: true });
  await assert.rejects(h.sdk.pay({ quote: h.quote }));
  assert.equal(h.calls.includes("settle"), true);
  assert.ok(!h.stages.some((s) => s.stage === "settlement" && s.status === "confirmed"));
});

test("delivery recovery requests buyer authorization after validating a successful receipt", async () => {
  const h = await makeHarness();
  const result = await h.sdk.deliver({ transactionHash: settlementHash2 });
  assert.equal(result.records.length, 1);
  assert.equal(h.signedDelivery, true);
  assert.equal(h.deliveryRequests, 1);
  assert.deepEqual(h.calls, [], "recovery must not submit approval or settlement transactions");
});

test("delivery rejects a coordinator response for a different query", async () => {
  const h = await makeHarness({ badDelivery: true });
  await assert.rejects(h.sdk.deliver({ transactionHash: settlementHash2 }), /Invalid QueryMint delivery response/);
  assert.equal(h.deliveryRequests, 1);
  assert.deepEqual(h.calls, [], "delivery recovery must not submit payment transactions");
});

test("quote rejects malformed successful JSON instead of coercing missing fields", async () => {
  const sdk = createQueryMint({ apiUrl: "http://coordinator", settlementAddress: settlement,
    walletClient: { account: { address: buyer } } as any, publicClient: {} as any,
    fetch: async () => new Response(JSON.stringify({ quoteId: queryId, manifest: {} }), { status: 201 }) });
  await assert.rejects(sdk.quote({ where: { category: "defi" }, limit: 5 }), /Invalid QueryMint response/);
});
