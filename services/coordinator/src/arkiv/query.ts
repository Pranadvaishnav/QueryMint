import type { PublicArkivClient } from "@arkiv-network/sdk";
import { and, asc, eq, gt } from "@arkiv-network/sdk/query";
import { key } from "@arkiv-network/sdk/schema";
import { type Address, type Hex, keccak256, hexToBytes, toBytes, type PublicClient } from "viem";
import { decryptPayload, stableJson } from "./encryption.js";
import { DatasetRecord } from "./schema.js";

export const settlementReadAbi = [
  {
    type: "function",
    name: "datasetPublisher",
    stateMutability: "view",
    inputs: [{ name: "datasetId", type: "bytes32" }],
    outputs: [{ name: "publisher", type: "address" }],
  },
  {
    type: "function",
    name: "datasetPolicies",
    stateMutability: "view",
    inputs: [{ name: "datasetId", type: "bytes32" }],
    outputs: [
      { name: "pricePerRecord", type: "uint128" },
      { name: "maxPayoutPerQuery", type: "uint128" },
      { name: "publisherSignatureThreshold", type: "uint128" },
      { name: "maxRecordsPerQuery", type: "uint32" },
      { name: "expiresAt", type: "uint64" },
      { name: "nonce", type: "uint64" },
      { name: "active", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "coordinatorGrants",
    stateMutability: "view",
    inputs: [
      { name: "datasetId", type: "bytes32" },
      { name: "coordinator", type: "address" },
    ],
    outputs: [
      { name: "expiresAt", type: "uint64" },
      { name: "nonce", type: "uint64" },
      { name: "active", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "publishers",
    stateMutability: "view",
    inputs: [{ name: "publisher", type: "address" }],
    outputs: [
      { name: "payout", type: "address" },
      { name: "nonce", type: "uint64" },
      { name: "registered", type: "bool" },
    ],
  },
] as const;

export interface VerifiedRecord {
  entityKey: Hex;
  datasetId: Hex;
  publisher: Address;
  contentHash: Hex;
  payloadHash: Hex;
  category: string;
  label: string;
  preview: string;
  payload: unknown;
  pricePerRecord: bigint;
  maxPayoutPerQuery: bigint;
  maxRecordsPerQuery: number;
  publisherNonce: bigint;
  policyNonce: bigint;
  grantNonce: bigint;
  policyExpiresAt: bigint;
  grantExpiresAt: bigint;
  publisherSignatureThreshold: bigint;
}

export interface QueryArkivRecordsOptions {
  arkivClient: PublicArkivClient;
  whitechainClient: PublicClient;
  settlementAddress: Address;
  coordinator: Address;
  category: string;
  maxRecords: number;
  encryptionKey: Hex;
  pageSize?: number;
}

export async function queryAuthorizedRecords(options: QueryArkivRecordsOptions): Promise<VerifiedRecord[]> {
  const { arkivClient, whitechainClient, settlementAddress, coordinator, category, encryptionKey } = options;
  const maxRecords = Math.min(Math.max(options.maxRecords, 1), 1000);
  const pageSize = Math.min(Math.max(options.pageSize ?? 100, 1), 100);
  const seen = new Set<string>();
  const records: VerifiedRecord[] = [];
  let cursor: Hex | undefined;
  let pageCount = 0;

  while (records.length < maxRecords && pageCount < 20) {
    const predicate = cursor
      ? and(eq("category", category), gt("$key", key(cursor)))
      : eq("category", category);
    const query = arkivClient
      .select({
        $key: true,
        $owner: true,
        $expiresAt: true,
        datasetId: true,
        category: true,
        contentHash: true,
        payloadHash: true,
        label: true,
        preview: true,
        encryptedPayload: true,
      })
      .from(DatasetRecord, { onMismatch: "throw" });

    const page = await query.where(predicate).orderBy(asc("$key")).limit(pageSize).fetch();
    pageCount++;
    if (page.entities.length === 0) break;

    const block = await whitechainClient.getBlock({ blockNumber: await whitechainClient.getBlockNumber() });
    for (const row of page.entities) {
      cursor = row.$key;
      const datasetId = row.datasetId.value;
      const [publisher, policy, grant] = await Promise.all([
        whitechainClient.readContract({ address: settlementAddress, abi: settlementReadAbi, functionName: "datasetPublisher", args: [datasetId] }),
        whitechainClient.readContract({ address: settlementAddress, abi: settlementReadAbi, functionName: "datasetPolicies", args: [datasetId] }),
        whitechainClient.readContract({ address: settlementAddress, abi: settlementReadAbi, functionName: "coordinatorGrants", args: [datasetId, coordinator] }),
      ]);
      const [payout, publisherNonce, publisherRegistered] = await whitechainClient.readContract({
        address: settlementAddress,
        abi: settlementReadAbi,
        functionName: "publishers",
        args: [publisher],
      });
      const [pricePerRecord, maxPayoutPerQuery, publisherSignatureThreshold, maxRecordsPerQuery, policyExpiry, policyNonce, policyActive] = policy;
      const [grantExpiry, grantNonce, grantActive] = grant;
      if (
        !publisherRegistered ||
        !policyActive ||
        !grantActive ||
        block.timestamp >= policyExpiry ||
        block.timestamp >= grantExpiry ||
        publisher.toLowerCase() !== row.$owner.toLowerCase() ||
        payout === "0x0000000000000000000000000000000000000000"
      ) continue;

      const encryptedPayload = row.encryptedPayload.value;
      const computedPayloadHash = keccak256(hexToBytes(encryptedPayload));
      if (computedPayloadHash.toLowerCase() !== row.payloadHash.value.toLowerCase()) {
        throw new Error(`Payload hash mismatch for Arkiv entity ${row.$key}`);
      }
      const plaintext = decryptPayload(encryptionKey, encryptedPayload);
      const computedContentHash = keccak256(toBytes(stableJson(JSON.parse(plaintext))));
      if (computedContentHash.toLowerCase() !== row.contentHash.value.toLowerCase()) {
        throw new Error(`Content hash mismatch for Arkiv entity ${row.$key}`);
      }
      if (seen.has(row.contentHash.value.toLowerCase())) continue;
      seen.add(row.contentHash.value.toLowerCase());
      records.push({
        entityKey: row.$key,
        datasetId,
        publisher,
        contentHash: row.contentHash.value,
        payloadHash: row.payloadHash.value,
        category: row.category.value,
        label: row.label.value,
        preview: row.preview.value,
        payload: JSON.parse(plaintext) as unknown,
        pricePerRecord,
        maxPayoutPerQuery,
        maxRecordsPerQuery,
        publisherNonce,
        policyNonce,
        grantNonce,
        policyExpiresAt: policyExpiry,
        grantExpiresAt: grantExpiry,
        publisherSignatureThreshold,
      });
      if (records.length >= maxRecords) break;
    }
  }
  return records;
}
