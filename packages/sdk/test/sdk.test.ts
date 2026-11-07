import assert from "node:assert/strict";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { hashAllocations, hashResultRoot, queryManifestTypes, WHITECHAIN_USDT, type Allocation } from "@querymint/shared";
import { createQueryMint } from "../dist/index.js";

const buyer = privateKeyToAccount(`0x${"11".repeat(32)}` as const);
const publisher = privateKeyToAccount(`0x${"22".repeat(32)}` as const);
const coordinator = privateKeyToAccount(`0x${"33".repeat(32)}` as const);
const settlementAddress = "0x4444444444444444444444444444444444444444" as const;
const queryId = `0x${"55".repeat(32)}` as const;
const datasetId = `0x${"66".repeat(32)}` as const;
const recordHash = `0x${"77".repeat(32)}` as const;

async function responseFixture(overrides: { signature?: string; previewRecordHash?: string } = {}) {
  const allocation: Allocation = { publisher: publisher.address, datasetId, publisherNonce: 2n, policyNonce: 3n, grantNonce: 4n,
    recordCount: 1, recordHashes: [recordHash], payoutAmount: 1_500_000n, publisherSignature: "0x" };
  const domain = { name: "QueryMint" as const, version: "1" as const, chainId: 1874 as const, verifyingContract: settlementAddress };
  const unsignedManifest = { queryId, buyer: buyer.address, coordinator: coordinator.address, token: WHITECHAIN_USDT,
    totalAmount: 1_500_000n, deadline: 1_800_000_000n, resultRoot: hashResultRoot([allocation]), allocations: [allocation] };
  const signature = await coordinator.signTypedData({ domain, types: queryManifestTypes, primaryType: "QueryManifest",
    message: { ...unsignedManifest, allocationsHash: hashAllocations(domain, [allocation]) } });
  const manifest = { ...unsignedManifest, coordinatorSignature: overrides.signature ?? signature };
  return {
    quoteId: queryId,
    settlementAddress,
    manifest: { ...manifest, totalAmount: manifest.totalAmount.toString(), deadline: manifest.deadline.toString(),
      allocations: manifest.allocations.map((item) => ({ ...item, publisherNonce: item.publisherNonce.toString(), policyNonce: item.policyNonce.toString(),
        grantNonce: item.grantNonce.toString(), payoutAmount: item.payoutAmount.toString() })) },
    records: [{ publisher: publisher.address, datasetId, recordHash: overrides.previewRecordHash ?? recordHash, preview: "Synthetic preview", label: "Test record" }],
    totalMatchingRecords: 1,
    eligibleRecords: 1,
    searchComplete: true,
    breakdown: [{ publisher: publisher.address, datasetId, recordCount: 1, pricePerRecord: "1500000", payoutAmount: "1500000" }],
    publisherApprovalRequests: [],
  };
}

function sdkFor(payload: unknown, requestBody: { buyer?: string } = {}) {
  const client = createQueryMint({ apiUrl: "https://coordinator.example", settlementAddress,
    walletClient: { account: { address: buyer.address } } as never,
    publicClient: {} as never,
    fetch: async (_input, init) => {
      Object.assign(requestBody, JSON.parse(String(init?.body)) as { buyer: string });
      return new Response(JSON.stringify(payload), { status: 201, headers: { "content-type": "application/json" } });
    },
  });
  return client;
}

test("public SDK quote method validates and revives a coordinator-signed response", async () => {
  const body: { buyer?: string } = {};
  const quote = await sdkFor(await responseFixture(), body).quote({ where: { category: "defi" }, limit: 1 });
  assert.equal(body.buyer?.toLowerCase(), buyer.address.toLowerCase());
  assert.equal(quote.manifest.totalAmount, 1_500_000n);
  assert.equal(quote.manifest.allocations[0]?.payoutAmount, 1_500_000n);
  assert.equal(quote.records.length, 1);
});

test("public SDK quote method rejects a malformed coordinator signature", async () => {
  const payload = await responseFixture({ signature: `0x${"00".repeat(65)}` });
  await assert.rejects(sdkFor(payload).quote({ where: { category: "defi" } }), /coordinator signature/);
});

test("public SDK quote method rejects a preview not represented in the signed manifest", async () => {
  const payload = await responseFixture({ previewRecordHash: `0x${"88".repeat(32)}` });
  await assert.rejects(sdkFor(payload).quote({ where: { category: "defi" } }), /preview does not match signed manifest/);
});
