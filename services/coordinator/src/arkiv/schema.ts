import { addr, bytes, defineSchema, key, str, u256 } from "@arkiv-network/sdk/schema";

export const PublisherProfile = defineSchema("querymint.publisher.v1", {
  wallet: addr().indexed(),
  status: str().indexed(),
  displayName: str(),
  payoutAddress: addr(),
});

export const DatasetManifest = defineSchema("querymint.dataset.v1", {
  datasetId: key().indexed(),
  publisher: addr().indexed(),
  category: str().indexed(),
  status: str().indexed(),
  title: str(),
  description: str(),
  schemaVersion: str(),
  pricePerRecord: u256(),
  maxRecordsPerQuery: u256(),
});

export const DatasetRecord = defineSchema("querymint.record.v1", {
  datasetId: key().indexed(),
  category: str().indexed(),
  contentHash: key().indexed(),
  payloadHash: key(),
  label: str().indexed(),
  preview: str(),
  encryptedPayload: bytes(),
});

export const QueryReceipt = defineSchema("querymint.receipt.v1", {
  queryId: key().indexed(),
  manifestHash: key().indexed(),
  status: str().indexed(),
  settlementTxHash: key().optional(),
  resultRoot: key(),
  totalAmount: u256(),
  allocationSummary: bytes(),
});
