const REFERENCE_KINDS = ["Profile", "Manifest", "Record", "Arkiv batch", "Publisher registration", "Publisher payout update", "Dataset policy", "Coordinator grant", "Coordinator revocation"] as const;
export type PublisherReferenceKind = typeof REFERENCE_KINDS[number];

export interface PublisherReference {
  kind: PublisherReferenceKind;
  entityKey?: string;
  transactionHash?: string;
  status?: "already present" | "submitted" | "failed" | "reconciliation required";
}

/** Public, non-secret inputs needed to resume Whitechain setup after an Arkiv batch. */
export interface PublisherSetup {
  publisher: `0x${string}`;
  payoutAddress: `0x${string}`;
  coordinator: `0x${string}`;
  title: string;
  category: string;
  pricePerRecord: string;
  maxRecordsPerQuery: number;
  maxPayoutPerQuery: string;
  publisherSignatureThreshold: string;
  datasetExpiresAt: string;
  coordinatorGrantExpiresAt: string;
}

export interface StoredPublisherReferences {
  datasetId: `0x${string}`;
  references: PublisherReference[];
  setup?: PublisherSetup;
}

type StoragePort = Pick<Storage, "getItem" | "setItem">;
const DATASET_ID = /^0x[0-9a-f]{64}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const ENTITY_KEY = /^0x[0-9a-f]{2,128}$/i;
const TRANSACTION_HASH = /^0x[0-9a-f]{64}$/i;

export function publisherReferencesStorageKey(owner: string): string {
  return `querymint:publisher-references:v2:${owner.toLowerCase()}`;
}

function isReference(value: unknown): value is PublisherReference {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !["kind", "entityKey", "transactionHash", "status"].includes(key))) return false;
  if (!REFERENCE_KINDS.includes(item.kind as PublisherReferenceKind)) return false;
  if (item.entityKey !== undefined && (typeof item.entityKey !== "string" || !ENTITY_KEY.test(item.entityKey))) return false;
  if (item.transactionHash !== undefined && (typeof item.transactionHash !== "string" || !TRANSACTION_HASH.test(item.transactionHash))) return false;
  const whitechainKind = ["Publisher registration", "Publisher payout update", "Dataset policy", "Coordinator grant", "Coordinator revocation"].includes(item.kind as string);
  if (item.status !== undefined && !((whitechainKind && ["already present", "submitted", "failed"].includes(item.status as string)) ||
      (item.kind === "Arkiv batch" && item.status === "reconciliation required"))) return false;
  return item.entityKey !== undefined || item.transactionHash !== undefined || item.status !== undefined;
}

function isSetup(value: unknown): value is PublisherSetup {
  if (!value || typeof value !== "object") return false;
  const setup = value as Record<string, unknown>;
  if (Object.keys(setup).some((key) => !["publisher", "payoutAddress", "coordinator", "title", "category", "pricePerRecord", "maxRecordsPerQuery", "maxPayoutPerQuery", "publisherSignatureThreshold", "datasetExpiresAt", "coordinatorGrantExpiresAt"].includes(key))) return false;
  return ADDRESS.test(String(setup.publisher)) && ADDRESS.test(String(setup.payoutAddress)) && ADDRESS.test(String(setup.coordinator)) &&
    typeof setup.title === "string" && typeof setup.category === "string" &&
    typeof setup.pricePerRecord === "string" && /^\d+$/.test(setup.pricePerRecord) &&
    Number.isSafeInteger(setup.maxRecordsPerQuery) && Number(setup.maxRecordsPerQuery) >= 1 && Number(setup.maxRecordsPerQuery) <= 50 &&
    typeof setup.maxPayoutPerQuery === "string" && /^\d+$/.test(setup.maxPayoutPerQuery) &&
    typeof setup.publisherSignatureThreshold === "string" && /^\d+$/.test(setup.publisherSignatureThreshold) &&
    typeof setup.datasetExpiresAt === "string" && /^\d+$/.test(setup.datasetExpiresAt) &&
    typeof setup.coordinatorGrantExpiresAt === "string" && /^\d+$/.test(setup.coordinatorGrantExpiresAt);
}

function isStoredBundle(value: unknown): value is StoredPublisherReferences {
  if (!value || typeof value !== "object") return false;
  const bundle = value as Record<string, unknown>;
  if (Object.keys(bundle).some((key) => !["datasetId", "references", "setup"].includes(key))) return false;
  if (typeof bundle.datasetId !== "string" || !DATASET_ID.test(bundle.datasetId) ||
      !Array.isArray(bundle.references) || !bundle.references.every(isReference)) return false;
  return bundle.setup === undefined || isSetup(bundle.setup);
}

/** Loads the v2 multi-dataset format and migrates the earlier single-dataset record in place. */
export function loadPublisherReferences(owner: string, storage?: StoragePort): StoredPublisherReferences[] {
  try {
    const target = storage ?? localStorage;
    const raw = target.getItem(publisherReferencesStorageKey(owner));
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return [];
      const record = parsed as Record<string, unknown>;
      if (record.version !== 2 || !Array.isArray(record.datasets) || !record.datasets.every(isStoredBundle)) return [];
      return record.datasets;
    }

    const legacyKey = `querymint:publisher-references:v1:${owner.toLowerCase()}`;
    const legacyRaw = target.getItem(legacyKey);
    if (!legacyRaw) return [];
    const legacy: unknown = JSON.parse(legacyRaw);
    if (!legacy || typeof legacy !== "object") return [];
    const record = legacy as Record<string, unknown>;
    if (record.version !== 1 || !isStoredBundle({ datasetId: record.datasetId, references: record.references })) return [];
    const migrated = [{ datasetId: record.datasetId as `0x${string}`, references: record.references as PublisherReference[] }];
    target.setItem(publisherReferencesStorageKey(owner), JSON.stringify({ version: 2, datasets: migrated }));
    return migrated;
  } catch {
    return [];
  }
}

/** Upserts only public entity/transaction references and policy metadata, never record data or keys. */
export function savePublisherReferences(
  owner: string,
  value: StoredPublisherReferences,
  storage?: StoragePort,
): boolean {
  if (!isStoredBundle(value)) return false;
  const target = storage ?? localStorage;
  try {
    const all = loadPublisherReferences(owner, target);
    const references = value.references.map(({ kind, entityKey, transactionHash, status }) => ({
      kind,
      ...(entityKey ? { entityKey } : {}),
      ...(transactionHash ? { transactionHash } : {}),
      ...(status ? { status } : {}),
    }));
    const setup = value.setup ? {
      publisher: value.setup.publisher, payoutAddress: value.setup.payoutAddress, coordinator: value.setup.coordinator,
      title: value.setup.title, category: value.setup.category, pricePerRecord: value.setup.pricePerRecord,
      maxRecordsPerQuery: value.setup.maxRecordsPerQuery, maxPayoutPerQuery: value.setup.maxPayoutPerQuery,
      publisherSignatureThreshold: value.setup.publisherSignatureThreshold, datasetExpiresAt: value.setup.datasetExpiresAt,
      coordinatorGrantExpiresAt: value.setup.coordinatorGrantExpiresAt,
    } : undefined;
    const next: StoredPublisherReferences = { datasetId: value.datasetId, references, ...(setup ? { setup } : {}) };
    const index = all.findIndex((bundle) => bundle.datasetId.toLowerCase() === value.datasetId.toLowerCase());
    if (index < 0) all.push(next);
    else all[index] = next;
    target.setItem(publisherReferencesStorageKey(owner), JSON.stringify({ version: 2, datasets: all }));
    return true;
  } catch {
    return false;
  }
}

export function formatPublisherReference(reference: PublisherReference): string {
  const entity = reference.entityKey ? ` ${reference.entityKey}` : "";
  const transaction = reference.transactionHash ? ` (${reference.transactionHash})` : reference.status ? ` (${reference.status})` : "";
  return `${reference.kind}${entity}${transaction}`;
}
