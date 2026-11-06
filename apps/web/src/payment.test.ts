import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from "viem";
import { createQueryMint, type QueryMintQuote } from "@querymint/sdk";

const buyer = "0x1111111111111111111111111111111111111111" as const;
const publisher = "0x2222222222222222222222222222222222222222" as const;
const coordinator = "0x3333333333333333333333333333333333333333" as const;
const settlement = "0x4444444444444444444444444444444444444444" as const;
const datasetId = `0x${"55".repeat(32)}` as const;
const queryId = `0x${"66".repeat(32)}` as const;
const resultRoot = `0x${"77".repeat(32)}` as const;
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

function makeHarness(options: { allowance?: bigint; failFirstSettlement?: boolean; expired?: boolean; invalidPolicy?: boolean } = {}) {
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
  const manifest = {
    queryId, buyer, coordinator, token: "0xcedfb56113143d55b2358b8cfbb0deb5ad2f55a7", totalAmount: 1_000_000n,
    deadline: 1_000n, resultRoot, allocations: [{ publisher, datasetId, publisherNonce: 0n, policyNonce: 0n, grantNonce: 0n,
      recordCount: 1, recordHashes: [`0x${"99".repeat(32)}`], payoutAmount: 1_000_000n, publisherSignature: "0x" }], coordinatorSignature: "0x",
  } as any;
  const quote = { quoteId: queryId, manifest, settlementAddress: settlement, records: [], breakdown: [] } as QueryMintQuote;
  const sdk = createQueryMint({ apiUrl: "http://coordinator", settlementAddress: settlement, walletClient, publicClient,
    fetch: async (_input, init) => init?.method === "POST"
      ? (deliveryRequests++, new Response(JSON.stringify({ queryId, transactionHash: settlementHash2, records: [{ id: "r1" }], blockNumber: "123" }), { status: 200 }))
      : new Response(JSON.stringify({ manifest: { ...manifest, totalAmount: "1000000", deadline: "1000", allocations: manifest.allocations.map((a: any) => ({ ...a, publisherNonce: "0", policyNonce: "0", grantNonce: "0", payoutAmount: "1000000" })) }, approvalsMissing: [] }), { status: 200 }),
    onPaymentStep: (step) => stages.push({ stage: step.stage, status: step.status }),
  });
  return { sdk, quote, calls, stages, get signedDelivery() { return signedDelivery; }, get deliveryRequests() { return deliveryRequests; } };
}

test("exact approval confirms before settlement and delivery follows confirmed receipt", async () => {
  const h = makeHarness();
  const result = await h.sdk.pay({ quote: h.quote });
  assert.deepEqual(h.calls, ["approve", "settle"]);
  assert.equal(result.records.length, 1);
  assert.equal(h.signedDelivery, true);
  assert.equal(h.deliveryRequests, 1);
  assert.ok(h.stages.some((s) => s.stage === "approval" && s.status === "confirmed"));
  assert.ok(h.stages.some((s) => s.stage === "settlement" && s.status === "confirmed"));
});

test("approval remains confirmed when settlement reverts and retry does not approve again", async () => {
  const h = makeHarness({ failFirstSettlement: true });
  await assert.rejects(h.sdk.pay({ quote: h.quote }), /Settlement transaction failed/);
  assert.ok(h.stages.some((s) => s.stage === "approval" && s.status === "confirmed"));
  assert.ok(h.stages.some((s) => s.stage === "settlement" && s.status === "failed"));
  const result = await h.sdk.pay({ quote: h.quote });
  assert.equal(result.records.length, 1);
  assert.deepEqual(h.calls, ["approve", "settle", "settle"]);
});

test("sufficient existing allowance skips approval", async () => {
  const h = makeHarness({ allowance: 1_000_000n });
  await h.sdk.pay({ quote: h.quote });
  assert.deepEqual(h.calls, ["settle"]);
  assert.ok(h.stages.some((s) => s.stage === "approval" && s.status === "skipped"));
});

test("expired or changed authorization is rejected before any transaction", async () => {
  const h = makeHarness({ expired: true });
  await assert.rejects(h.sdk.pay({ quote: h.quote }), /expired/i);
  assert.deepEqual(h.calls, []);
  const changed = makeHarness({ invalidPolicy: true });
  await assert.rejects(changed.sdk.pay({ quote: changed.quote }), /authorization changed/i);
  assert.deepEqual(changed.calls, []);
});

test("delivery is not requested if settlement receipt fails", async () => {
  const h = makeHarness({ failFirstSettlement: true });
  await assert.rejects(h.sdk.pay({ quote: h.quote }));
  assert.equal(h.calls.includes("settle"), true);
  assert.ok(!h.stages.some((s) => s.stage === "settlement" && s.status === "confirmed"));
});

test("delivery recovery requests buyer authorization after validating a successful receipt", async () => {
  const h = makeHarness();
  const result = await h.sdk.deliver({ transactionHash: settlementHash2 });
  assert.equal(result.records.length, 1);
  assert.equal(h.signedDelivery, true);
  assert.equal(h.deliveryRequests, 1);
  assert.deepEqual(h.calls, [], "recovery must not submit approval or settlement transactions");
});
