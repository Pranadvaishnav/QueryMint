import { defineSchema, addr, bytes, key, str, u256 } from "@arkiv-network/sdk/schema";
import type { CreateEntityParameters, ExecuteBatchReturnType } from "@arkiv-network/sdk";
import type { Address, Hash, Hex } from "viem";
import type { PublisherReference } from "./publisherReferences";

// These definitions deliberately match the coordinator's verified v1 schemas.
export const PublisherProfile = defineSchema("querymint.publisher.v1", {
  wallet: addr().indexed(), status: str().indexed(), displayName: str(), payoutAddress: addr(),
});
export const DatasetManifest = defineSchema("querymint.dataset.v1", {
  datasetId: key().indexed(), publisher: addr().indexed(), category: str().indexed(), status: str().indexed(),
  title: str(), description: str(), schemaVersion: str(), pricePerRecord: u256(), maxRecordsPerQuery: u256(),
});
export const DatasetRecord = defineSchema("querymint.record.v1", {
  datasetId: key().indexed(), category: str().indexed(), contentHash: key().indexed(), payloadHash: key(),
  label: str().indexed(), preview: str(), encryptedPayload: bytes(),
});

export interface EncryptedPublisherRecord {
  label: string;
  preview: string;
  contentHash: Hex;
  payloadHash: Hex;
  encryptedPayload: Hex;
}

export interface PublisherBatchInput {
  owner: Address;
  payoutAddress: Address;
  displayName: string;
  datasetId: Hex;
  category: string;
  title: string;
  pricePerRecord: bigint;
  maxRecordsPerQuery: number;
  records: readonly EncryptedPublisherRecord[];
  expiration: import("@arkiv-network/sdk").Expiry;
}

export type PublisherCreateOperations = readonly [
  CreateEntityParameters<typeof PublisherProfile>,
  CreateEntityParameters<typeof DatasetManifest>,
  ...CreateEntityParameters<typeof DatasetRecord>[],
];

/** Creates are deliberately ordered so receipt keys map to profile, manifest, then records. */
export function buildPublisherCreateOperations(input: PublisherBatchInput): PublisherCreateOperations {
  if (!input.records.length || input.records.length > 50) throw new Error("A publisher batch must contain 1–50 records.");
  return [
    { schema: PublisherProfile, expiration: input.expiration, values: {
      wallet: addr(input.owner), status: "active", displayName: input.displayName, payoutAddress: addr(input.payoutAddress),
    } },
    { schema: DatasetManifest, expiration: input.expiration, values: {
      datasetId: key(input.datasetId), publisher: addr(input.owner), category: input.category, status: "active",
      title: input.title, description: "Publisher supplied dataset.", schemaVersion: "querymint.record.v1",
      pricePerRecord: u256(input.pricePerRecord), maxRecordsPerQuery: u256(BigInt(input.maxRecordsPerQuery)),
    } },
    ...input.records.map((record) => ({ schema: DatasetRecord, expiration: input.expiration, values: {
      datasetId: key(input.datasetId), category: input.category, contentHash: key(record.contentHash),
      payloadHash: key(record.payloadHash), label: record.label, preview: record.preview,
      encryptedPayload: bytes(record.encryptedPayload),
    } })),
  ] as PublisherCreateOperations;
}

export class PublisherBatchResultError extends Error {
  constructor(readonly transactionHash: Hash, message: string) {
    super(message);
    this.name = "PublisherBatchResultError";
  }
}

/** Execute once, then map the SDK's receipt-ordered entity keys to the create-operation order. */
export async function submitPublisherBatch(
  submit: () => Promise<ExecuteBatchReturnType>,
  recordCount: number,
): Promise<{ transactionHash: Hash; references: PublisherReference[] }> {
  const result = await submit();
  const expected = recordCount + 2;
  if (result.createdEntities.length !== expected) {
    throw new PublisherBatchResultError(result.txHash, `Arkiv confirmed batch ${result.txHash}, but returned ${result.createdEntities.length} of ${expected} entity keys. Do not submit this batch again; reconcile it using the transaction.`);
  }
  if (!result.createdEntities.every((entityKey) => /^0x[0-9a-f]{64}$/i.test(entityKey))) {
    throw new PublisherBatchResultError(result.txHash, `Arkiv confirmed batch ${result.txHash}, but returned an invalid entity key. Do not submit this batch again; reconcile it using the transaction.`);
  }
  const [profile, manifest, ...records] = result.createdEntities;
  return {
    transactionHash: result.txHash,
    references: [
      { kind: "Arkiv batch", transactionHash: result.txHash },
      { kind: "Profile", entityKey: profile!, transactionHash: result.txHash },
      { kind: "Manifest", entityKey: manifest!, transactionHash: result.txHash },
      ...records.map((entityKey) => ({ kind: "Record" as const, entityKey, transactionHash: result.txHash })),
    ],
  };
}

/** Persistence callback runs only after executeBatch resolves with a receipt-checked key list. */
export async function publishAndPersistPublisherBatch(
  submit: () => Promise<ExecuteBatchReturnType>,
  recordCount: number,
  persist: (batch: { transactionHash: Hash; references: PublisherReference[] }) => void,
): Promise<{ transactionHash: Hash; references: PublisherReference[] }> {
  const batch = await submitPublisherBatch(submit, recordCount);
  persist(batch);
  return batch;
}

export function hasConfirmedPublisherBatch(references: readonly PublisherReference[]): boolean {
  const batch = references.find((reference) => reference.kind === "Arkiv batch" && reference.transactionHash && !reference.status);
  return !!batch && references.some((reference) => reference.kind === "Profile" && reference.entityKey && reference.transactionHash === batch.transactionHash) &&
    references.some((reference) => reference.kind === "Manifest" && reference.entityKey && reference.transactionHash === batch.transactionHash);
}

export function canResumeWhitechainSetup(bundle: { setup?: unknown; references: readonly PublisherReference[] }): boolean {
  const grantIndex = bundle.references.map((reference) => reference.kind).lastIndexOf("Coordinator grant");
  const revokeIndex = bundle.references.map((reference) => reference.kind).lastIndexOf("Coordinator revocation");
  const latestGrant = grantIndex >= 0 ? bundle.references[grantIndex] : undefined;
  const grantIsFinal = !!latestGrant && (latestGrant.status === undefined || latestGrant.status === "already present");
  const wasRevoked = revokeIndex > grantIndex;
  return !!bundle.setup && hasConfirmedPublisherBatch(bundle.references) && (!grantIsFinal || wasRevoked);
}
