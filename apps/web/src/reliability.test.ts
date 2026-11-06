import assert from "node:assert/strict";
import { test } from "node:test";
import { previewRecordCount } from "./buyerDisplay.js";
import { ExpirationTime, type ExecuteBatchReturnType } from "@arkiv-network/sdk";
import { discoveryView } from "./discoveryState.js";
import { isValidDeliveryTransactionHash } from "./deliveryRecovery.js";
import { formatPublisherReference, loadPublisherReferences, publisherReferencesStorageKey, savePublisherReferences, type PublisherReference, type PublisherSetup } from "./publisherReferences.js";
import { buildPublisherCreateOperations, canResumeWhitechainSetup, hasConfirmedPublisherBatch, publishAndPersistPublisherBatch, PublisherBatchResultError } from "./publisherArkiv.js";
import { DatasetManifest, DatasetRecord, PublisherProfile } from "./publisherArkiv.js";

test("discovery view distinguishes loading, errors, successful empty results, and results", () => {
  assert.equal(discoveryView("loading", 0), "loading");
  assert.equal(discoveryView("error", 0), "error");
  assert.equal(discoveryView("success", 0), "empty");
  assert.equal(discoveryView("success", 1), "results");
  assert.equal(discoveryView("error", 1), "results"); // Keep previously loaded data visible during a failed refresh.
});

test("publisher references persist per dataset without accepting record payload fields", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  const owner = "0xAbC";
  const datasetId = `0x${"11".repeat(32)}` as `0x${string}`;
  const entityKey = `0x${"22".repeat(32)}`;
  const txHash = `0x${"33".repeat(32)}`;
  const reference = { kind: "Profile" as const, entityKey, transactionHash: txHash };

  assert.equal(savePublisherReferences(owner, { datasetId, references: [reference] }, storage), true);
  const datasetB = `0x${"44".repeat(32)}` as `0x${string}`;
  const referenceB = { kind: "Arkiv batch" as const, transactionHash: `0x${"55".repeat(32)}` };
  assert.equal(savePublisherReferences(owner, { datasetId: datasetB, references: [referenceB] }, storage), true);
  assert.deepEqual(loadPublisherReferences("0xaBc", storage), [
    { datasetId, references: [reference] },
    { datasetId: datasetB, references: [referenceB] },
  ]);
  assert.equal(formatPublisherReference(reference), `Profile ${entityKey} (${txHash})`);
  assert.equal(values.get(publisherReferencesStorageKey(owner))?.includes("payload"), false);
  assert.equal(savePublisherReferences(owner, { datasetId, references: [{ ...reference, payload: { secret: "not allowed" } } as never] }, storage), false);
});

test("publisher reference v1 storage migrates to the multi-dataset format", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) };
  const owner = "0xAbC";
  const datasetId = `0x${"11".repeat(32)}`;
  const reference = { kind: "Manifest", entityKey: `0x${"22".repeat(32)}` };
  values.set(`querymint:publisher-references:v1:${owner.toLowerCase()}`, JSON.stringify({ version: 1, datasetId, references: [reference] }));
  assert.deepEqual(loadPublisherReferences(owner, storage), [{ datasetId, references: [reference] }]);
  assert.equal(values.get(publisherReferencesStorageKey(owner))?.includes('"version":2'), true);
});

test("Arkiv create operations batch profile, manifest, and multiple records in receipt order", () => {
  const ops = buildPublisherCreateOperations({
    owner: "0x1111111111111111111111111111111111111111", payoutAddress: "0x2222222222222222222222222222222222222222",
    displayName: "Publisher", datasetId: `0x${"33".repeat(32)}`, category: "defi", title: "Dataset",
    pricePerRecord: 1_000_000n, maxRecordsPerQuery: 20,
    records: ["a", "b"].map((label) => ({ label, preview: `${label} preview`, contentHash: `0x${label === "a" ? "44" : "55"}`.padEnd(66, "0") as `0x${string}`, payloadHash: `0x${"66".repeat(32)}`, encryptedPayload: "0x1234" })),
    expiration: ExpirationTime.fromDays(30),
  });
  assert.equal(ops.length, 4);
  assert.deepEqual(ops.slice(0, 2).map((operation) => operation.schema), [PublisherProfile, DatasetManifest]);
  assert.equal(ops[2]!.schema, DatasetRecord);
  assert.equal(ops[3]!.schema, DatasetRecord);
});

test("one confirmed Arkiv batch persists all returned keys once and enables Whitechain resume", async () => {
  const ids = Array.from({ length: 4 }, (_, i) => `0x${String(i + 1).repeat(64)}` as `0x${string}`);
  const txHash = `0x${"ab".repeat(32)}` as `0x${string}`;
  const result = { txHash, createdEntities: ids, patchedEntities: [], deletedEntities: [], extendedEntities: [], ownershipChanges: [] } satisfies ExecuteBatchReturnType;
  let submitCount = 0;
  let persistCount = 0;
  let persisted: PublisherReference[] = [];
  const setup: PublisherSetup = {
    publisher: "0x1111111111111111111111111111111111111111", payoutAddress: "0x2222222222222222222222222222222222222222",
    coordinator: "0x3333333333333333333333333333333333333333", title: "Dataset", category: "defi",
    pricePerRecord: "1000000", maxRecordsPerQuery: 20, maxPayoutPerQuery: "20000000", publisherSignatureThreshold: "0",
    datasetExpiresAt: "1900000000", coordinatorGrantExpiresAt: "1800000000",
  };
  const batch = await publishAndPersistPublisherBatch(async () => { submitCount++; return result; }, 2, (confirmed) => {
    persistCount++;
    persisted = confirmed.references;
  });
  assert.equal(submitCount, 1);
  assert.equal(persistCount, 1);
  assert.equal(batch.references[0]?.kind, "Arkiv batch");
  assert.deepEqual(batch.references.slice(1).map((reference) => reference.entityKey), ids);
  assert.equal(hasConfirmedPublisherBatch(persisted), true);
  assert.equal(canResumeWhitechainSetup({ setup, references: persisted }), true);

  // Simulate a Whitechain failure after Arkiv confirmation: persisted Arkiv refs remain resumable.
  assert.throws(() => { throw new Error("Whitechain setup failed"); }, /Whitechain setup failed/);
  assert.equal(submitCount, 1, "resume uses the saved refs and never reissues the Arkiv batch");
  const authorized = [...persisted, { kind: "Coordinator grant" as const, transactionHash: txHash }];
  assert.equal(canResumeWhitechainSetup({ setup, references: authorized }), false);
  assert.equal(canResumeWhitechainSetup({ setup, references: [...authorized, { kind: "Coordinator revocation", transactionHash: txHash }] }), true);
  assert.equal(canResumeWhitechainSetup({ setup, references: [...persisted, { kind: "Coordinator revocation" as const, transactionHash: txHash }, { kind: "Coordinator grant" as const, transactionHash: txHash }] }), false);
});

test("batch failures do not persist keys, and incomplete confirmed results block blind resubmission", async () => {
  let persistCount = 0;
  await assert.rejects(publishAndPersistPublisherBatch(async () => { throw new Error("wallet rejected"); }, 2, () => { persistCount++; }), /wallet rejected/);
  assert.equal(persistCount, 0);

  const txHash = `0x${"cd".repeat(32)}` as `0x${string}`;
  await assert.rejects(submitBadBatch(), PublisherBatchResultError);
  async function submitBadBatch() {
    return publishAndPersistPublisherBatch(async () => ({ txHash, createdEntities: [], patchedEntities: [], deletedEntities: [], extendedEntities: [], ownershipChanges: [] }), 2, () => { persistCount++; });
  }
  assert.equal(persistCount, 0);
  assert.equal(canResumeWhitechainSetup({ setup: {}, references: [{ kind: "Arkiv batch", transactionHash: txHash, status: "reconciliation required" }] }), false);
});

test("delivery recovery accepts only a complete 66-character transaction hash", () => {
  const hash = `0x${"aB".repeat(32)}`;
  assert.equal(hash.length, 66);
  assert.equal(isValidDeliveryTransactionHash(hash), true);
  assert.equal(isValidDeliveryTransactionHash(` ${hash} `), true);
  assert.equal(isValidDeliveryTransactionHash(hash.slice(0, 65)), false);
  assert.equal(isValidDeliveryTransactionHash(`${hash}0`), false);
  assert.equal(isValidDeliveryTransactionHash(`0x${"g".repeat(64)}`), false);
});

test("quote preview count stays separate from the total matched record count", () => {
  assert.equal(previewRecordCount(4), 4);
  assert.equal(previewRecordCount(17), 4);
  assert.equal(previewRecordCount(0), 0);
  assert.equal(previewRecordCount(3, 2), 2);
});
