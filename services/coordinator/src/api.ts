import express, { type Express, type Request, type Response } from "express";
import {
  hashAllocations,
  hashPublisherApproval,
  hashRecordHashes,
  hashQueryManifest,
  hashResultRoot,
  queryManifestTypes,
  publisherApprovalTypes,
  WHITECHAIN_USDT,
  type Allocation,
  type QueryManifest,
} from "@querymint/shared";
import {
  type Address,
  isAddress,
  decodeEventLog,
  decodeFunctionData,
  recoverAddress,
  recoverTypedDataAddress,
  parseAbiItem,
  hexToBytes,
  type Hex,
  type PublicClient,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { DuplicateContentHashError, queryAuthorizedRecords, type QueryRecordScanResult, type VerifiedRecord } from "./arkiv/query.js";
import { PublisherProfile, DatasetManifest, DatasetRecord } from "./arkiv/schema.js";
import { contentHash, decryptPayload, encryptPayload, encryptedPayloadHash, stableJson } from "./arkiv/encryption.js";
import { eq, and, asc, gt } from "@arkiv-network/sdk/query";
import { key } from "@arkiv-network/sdk/schema";
import { withArkivReadRetry } from "./arkiv/retry.js";
import { collectArkivPages } from "./arkiv/pagination.js";

const MAX_SETTLEMENT_ALLOCATIONS = 10;
const MAX_SETTLEMENT_RECORDS = 50;
const DISCOVERY_PAGE_SIZE = 100;
const DISCOVERY_MAX_PAGES = 20;

class IncompleteArkivScanError extends Error {
  readonly code = "INCOMPLETE_RESULTS";
  constructor(readonly observed: number, readonly pages: number, readonly resource = "record") {
    super(`Arkiv ${resource} search reached its ${pages}-page safety limit after observing ${observed} entities; results may be incomplete. Narrow the query and retry.`);
  }
}

type DiscoveryStage = "arkiv_entity_query" | "whitechain_latest_block_read" | "whitechain_publisher_registration_read" |
  "whitechain_dataset_owner_read" | "whitechain_dataset_policy_read" | "whitechain_coordinator_grant_read";

class DiscoveryStageError extends Error {
  constructor(readonly stage: DiscoveryStage, readonly original: unknown) {
    super("Discovery dependency failed");
  }
}

async function withDiscoveryStage<T>(stage: DiscoveryStage, operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) { throw new DiscoveryStageError(stage, error); }
}

function safeDiscoveryErrorMetadata(error: unknown) {
  const source = error instanceof DiscoveryStageError ? error.original : error;
  const errorName = source instanceof Error ? source.name : "UnknownError";
  const name = /^[A-Za-z0-9_$.-]{1,64}$/.test(errorName) ? errorName : "Error";
  const metadata: { errorName: string; status?: number; code?: string } = { errorName: name };
  let current = source;
  for (let depth = 0; current && typeof current === "object" && depth < 5; depth++) {
    const record = current as { status?: unknown; statusCode?: unknown; code?: unknown; cause?: unknown };
    const status = typeof record.status === "number" ? record.status : record.statusCode;
    if (metadata.status === undefined && typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) metadata.status = status;
    if (metadata.code === undefined && typeof record.code === "string" && /^[A-Z0-9_]{1,32}$/.test(record.code)) metadata.code = record.code;
    current = record.cause;
  }
  return metadata;
}

function safeRequestId(req: Request): string {
  const value = req.get("x-railway-request-id");
  return value && /^[A-Za-z0-9._-]{1,128}$/.test(value) ? value : "unknown";
}

class DeliveryVerificationError extends Error {}

const querySettledEvent = parseAbiItem(
  "event QuerySettled(bytes32 indexed queryId,address indexed buyer,address indexed coordinator,uint256 totalAmount,bytes32 resultRoot,bytes32 manifestDigest)",
);
const allocationPaidEvent = parseAbiItem(
  "event AllocationPaid(bytes32 indexed queryId,bytes32 indexed datasetId,address indexed publisher,address payout,uint256 amount,uint32 recordCount)",
);
const erc20TransferEvent = parseAbiItem("event Transfer(address indexed from,address indexed to,uint256 value)");
const deliveryAuthorizationTypes = { DeliveryAuthorization: [
  { name: "queryId", type: "bytes32" }, { name: "transactionHash", type: "bytes32" }, { name: "buyer", type: "address" },
] } as const;
export const settlementCallAbi = [{ type: "function", name: "settle", stateMutability: "nonpayable", inputs: [{ name: "manifest", type: "tuple", components: [
  { name: "queryId", type: "bytes32" }, { name: "buyer", type: "address" }, { name: "coordinator", type: "address" },
  { name: "token", type: "address" }, { name: "totalAmount", type: "uint128" }, { name: "deadline", type: "uint64" },
  { name: "resultRoot", type: "bytes32" }, { name: "allocations", type: "tuple[]", components: [
    { name: "publisher", type: "address" }, { name: "datasetId", type: "bytes32" }, { name: "publisherNonce", type: "uint64" },
    { name: "policyNonce", type: "uint64" }, { name: "grantNonce", type: "uint64" }, { name: "recordCount", type: "uint32" },
    { name: "recordHashes", type: "bytes32[]" }, { name: "payoutAmount", type: "uint128" }, { name: "publisherSignature", type: "bytes" },
  ]}, { name: "coordinatorSignature", type: "bytes" },
]}], outputs: [] }] as const;

export const settlementApiAbi = [
  { type: "function", name: "settledQueries", stateMutability: "view", inputs: [{ name: "queryId", type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "datasetPublisher", stateMutability: "view", inputs: [{ name: "datasetId", type: "bytes32" }], outputs: [{ type: "address" }] },
  { type: "function", name: "datasetPolicies", stateMutability: "view", inputs: [{ name: "datasetId", type: "bytes32" }], outputs: [
    { name: "pricePerRecord", type: "uint128" }, { name: "maxPayoutPerQuery", type: "uint128" }, { name: "publisherSignatureThreshold", type: "uint128" },
    { name: "maxRecordsPerQuery", type: "uint32" }, { name: "expiresAt", type: "uint64" }, { name: "nonce", type: "uint64" }, { name: "active", type: "bool" },
  ]},
  { type: "function", name: "coordinatorGrants", stateMutability: "view", inputs: [{ name: "datasetId", type: "bytes32" }, { name: "coordinator", type: "address" }], outputs: [
    { name: "expiresAt", type: "uint64" }, { name: "nonce", type: "uint64" }, { name: "active", type: "bool" },
  ]},
  { type: "function", name: "publishers", stateMutability: "view", inputs: [{ name: "publisher", type: "address" }], outputs: [
    { name: "payout", type: "address" }, { name: "nonce", type: "uint64" }, { name: "registered", type: "bool" },
  ]},
] as const;

export interface CoordinatorDependencies {
  arkivClient: any;
  whitechainClient: PublicClient;
  settlementAddress: Address;
  coordinatorAccount: PrivateKeyAccount;
  encryptionKey: Hex;
  deploymentBlock?: bigint;
  quoteTtlSeconds?: number;
  rateLimitPerMinute?: number;
  now?: () => number;
  queryRecords?: (category: string, limit: number) => Promise<QueryRecordScanResult | VerifiedRecord[]>;
  queryManifestRecords?: (manifest: QueryManifest) => Promise<Array<{ publisher: Address; datasetId: Hex; recordHash: Hex; payload: unknown }>>;
  corsOrigin?: string;
  corsOrigins?: string[];
  trustProxyHops?: number;
}

interface StoredQuote {
  manifest: QueryManifest;
  expiresAt: number;
  records: Array<{ publisher: Address; datasetId: Hex; recordHash: Hex; preview: string; label: string }>;
  publisherApprovalsRequired: Set<string>;
  delivered?: { txHash: Hex; buyer: Address; records: unknown[] };
}

const rateBuckets = new Map<string, { start: number; count: number }>();

function badRequest(res: Response, message: string): void { res.status(400).json({ error: message }); }
function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Request failed";
  // RPC errors can contain the full request URL; Rabdi access keys live in that URL's path.
  return message.replace(/https?:\/\/[^\s)]+/gi, "upstream service");
}
function isBytes32(value: unknown): value is Hex { return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value); }
function isCanonicalSignature(value: unknown): value is Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(value)) return false;
  const s = BigInt(`0x${value.slice(66, 130)}`);
  const v = value.slice(130, 132).toLowerCase();
  return s > 0n && s <= 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n && (v === "1b" || v === "1c");
}
function serializeAllocation(allocation: Allocation) {
  return { ...allocation, publisherNonce: allocation.publisherNonce.toString(), policyNonce: allocation.policyNonce.toString(), grantNonce: allocation.grantNonce.toString(), payoutAmount: allocation.payoutAmount.toString() };
}
function serializeManifest(manifest: QueryManifest) {
  return {
    ...manifest,
    totalAmount: manifest.totalAmount.toString(),
    deadline: manifest.deadline.toString(),
    allocations: manifest.allocations.map(serializeAllocation),
  };
}
function reviveManifest(value: any): QueryManifest {
  return {
    ...value,
    totalAmount: BigInt(value.totalAmount),
    deadline: BigInt(value.deadline),
    allocations: value.allocations.map((allocation: any) => ({
      ...allocation,
      publisherNonce: BigInt(allocation.publisherNonce), policyNonce: BigInt(allocation.policyNonce),
      grantNonce: BigInt(allocation.grantNonce), payoutAmount: BigInt(allocation.payoutAmount),
    })),
  } as QueryManifest;
}

export function createCoordinatorApp(deps: CoordinatorDependencies): Express {
  const quoteStore = new Map<string, StoredQuote>();
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", deps.trustProxyHops ?? 0);
  app.use(express.json({ limit: "32kb", strict: true }));
  const allowedOrigins = new Set(deps.corsOrigins ?? (deps.corsOrigin ? [deps.corsOrigin] : []));
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }
    if (req.method === "OPTIONS") { res.sendStatus(origin && allowedOrigins.has(origin) ? 204 : 403); return; }
    next();
  });
  app.use((req, res, next) => {
    const now = Date.now();
    const railwayClientIp = deps.trustProxyHops ? req.headers["x-real-ip"] : undefined;
    const clientIp = typeof railwayClientIp === "string" && isIP(railwayClientIp) ? railwayClientIp : req.ip;
    const key = clientIp ?? "unknown";
    const bucket = rateBuckets.get(key);
    if (!bucket || now - bucket.start >= 60_000) rateBuckets.set(key, { start: now, count: 1 });
    else if (++bucket.count > (deps.rateLimitPerMinute ?? 60)) { res.status(429).json({ error: "Rate limit exceeded" }); return; }
    if (rateBuckets.size > 5_000) for (const [ip, value] of rateBuckets) if (now - value.start >= 60_000) rateBuckets.delete(ip);
    next();
  });
  app.get("/health", (_req, res) => res.json({ ok: true }));

  // The browser never receives the coordinator's symmetric encryption key. The
  // publisher wallet still signs the Arkiv entity that contains this ciphertext.
  app.post("/publisher/encrypt-record", (req, res) => {
    try {
      const payload = req.body?.payload;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return badRequest(res, "payload must be a JSON object");
      const plaintext = stableJson(payload);
      if (Buffer.byteLength(plaintext, "utf8") > 16_384) return res.status(413).json({ error: "record payload exceeds 16 KB" });
      const encrypted = encryptPayload(deps.encryptionKey, plaintext);
      return res.json({ encryptedPayload: `0x${Buffer.from(encrypted).toString("hex")}`, contentHash: contentHash(plaintext), payloadHash: encryptedPayloadHash(encrypted) });
    } catch (error) { return res.status(400).json({ error: safeError(error) }); }
  });

  const getRecords = deps.queryRecords ?? ((category: string, limit: number) => queryAuthorizedRecords({
    arkivClient: deps.arkivClient,
    whitechainClient: deps.whitechainClient,
    settlementAddress: deps.settlementAddress,
    coordinator: deps.coordinatorAccount.address,
    category,
    maxRecords: limit,
    encryptionKey: deps.encryptionKey,
  }));

  const getManifestRecords = deps.queryManifestRecords ?? (async (manifest: QueryManifest) => {
    const delivered: Array<{ publisher: Address; datasetId: Hex; recordHash: Hex; payload: unknown }> = [];
    for (const allocation of manifest.allocations) for (const recordHash of allocation.recordHashes) {
      const query = deps.arkivClient.select({ $key: true, $owner: true, datasetId: true, contentHash: true, payloadHash: true, encryptedPayload: true })
        .from(DatasetRecord, { onMismatch: "throw" })
        .where(and(eq("datasetId", key(allocation.datasetId)), eq("contentHash", key(recordHash))))
        .limit(2);
      const page = await withArkivReadRetry(() => query.fetch()) as { entities: any[] };
      // A record hash and dataset ID must resolve to exactly one Arkiv entity.
      // Filtering by owner first could hide an ambiguous duplicate owned by a
      // different wallet and make the selected row appear uniquely valid.
      if (page.entities.length !== 1) throw new DeliveryVerificationError("Manifest record is missing or duplicated in Arkiv");
      const matches = page.entities.filter((row) => row.$owner.toLowerCase() === allocation.publisher.toLowerCase() &&
        row.datasetId.value.toLowerCase() === allocation.datasetId.toLowerCase() && row.contentHash.value.toLowerCase() === recordHash.toLowerCase());
      if (matches.length !== 1) throw new DeliveryVerificationError("Manifest record is missing, duplicated, or owned by another publisher");
      const row = matches[0];
      const encryptedPayload = row.encryptedPayload.value as Hex;
      if (encryptedPayloadHash(hexToBytes(encryptedPayload)).toLowerCase() !== row.payloadHash.value.toLowerCase()) throw new DeliveryVerificationError("Encrypted payload hash mismatch");
      const payload = JSON.parse(decryptPayload(deps.encryptionKey, encryptedPayload)) as unknown;
      if (contentHash(stableJson(payload)).toLowerCase() !== recordHash.toLowerCase()) throw new DeliveryVerificationError("Manifest content hash mismatch");
      delivered.push({ publisher: allocation.publisher, datasetId: allocation.datasetId, recordHash, payload });
    }
    return delivered;
  });

  const discoveryInFlight = new Map<string, Promise<unknown[]>>();
  function coalesceDiscovery(key: string, load: () => Promise<unknown[]>): Promise<unknown[]> {
    const existing = discoveryInFlight.get(key);
    if (existing) return existing;
    const current = load().finally(() => discoveryInFlight.delete(key));
    discoveryInFlight.set(key, current);
    return current;
  }

  function loadPublishers(): Promise<unknown[]> {
    return coalesceDiscovery("publishers", async () => {
      const paged = await withDiscoveryStage("arkiv_entity_query", () => collectArkivPages(async (cursor) => {
        const predicate = cursor ? and(eq("status", "active"), gt("$key", key(cursor))) : eq("status", "active");
        const query = deps.arkivClient.select({ $key: true, $owner: true, wallet: true, status: true, displayName: true, payoutAddress: true })
          .from(PublisherProfile, { onMismatch: "throw" });
        const page = await withArkivReadRetry(() => query.where(predicate).orderBy(asc("$key")).limit(DISCOVERY_PAGE_SIZE).fetch());
        return (page as { entities: Array<{ $key: Hex; [field: string]: any }> }).entities;
      }, { pageSize: DISCOVERY_PAGE_SIZE, maxPages: DISCOVERY_MAX_PAGES }));
      if (!paged.complete) throw new DiscoveryStageError("arkiv_entity_query", new IncompleteArkivScanError(paged.entities.length, paged.pagesScanned, "publisher discovery"));
      const results = [];
      const seenPublishers = new Set<string>();
      for (const row of paged.entities) {
        const owner = row.wallet.value as Address;
        if (row.$owner.toLowerCase() !== owner.toLowerCase() || row.status.value !== "active" || seenPublishers.has(owner.toLowerCase())) continue;
        const [payout, , registered] = await withDiscoveryStage("whitechain_publisher_registration_read", () =>
          deps.whitechainClient.readContract({ address: deps.settlementAddress, abi: settlementApiAbi, functionName: "publishers", args: [owner] }));
        if (!registered) continue;
        seenPublishers.add(owner.toLowerCase());
        results.push({ address: owner, displayName: row.displayName.value, payoutAddress: payout, entityKey: row.$key });
      }
      return results;
    });
  }
  function loadDatasets(datasetId?: Hex): Promise<unknown[]> {
    const flightKey = `datasets:${datasetId?.toLowerCase() ?? "all"}`;
    return coalesceDiscovery(flightKey, async () => {
      const predicate = datasetId ? and(eq("status", "active"), eq("datasetId", key(datasetId))) : eq("status", "active");
      const paged = await withDiscoveryStage("arkiv_entity_query", () => collectArkivPages(async (cursor) => {
        const pagePredicate = cursor ? and(predicate, gt("$key", key(cursor))) : predicate;
        const query = deps.arkivClient.select({ $key: true, $owner: true, datasetId: true, publisher: true, category: true, status: true, title: true, description: true })
          .from(DatasetManifest, { onMismatch: "throw" });
        const page = await withArkivReadRetry(() => query.where(pagePredicate).orderBy(asc("$key")).limit(DISCOVERY_PAGE_SIZE).fetch());
        return (page as { entities: Array<{ $key: Hex; [field: string]: any }> }).entities;
      }, { pageSize: DISCOVERY_PAGE_SIZE, maxPages: DISCOVERY_MAX_PAGES }));
      if (!paged.complete) throw new DiscoveryStageError("arkiv_entity_query", new IncompleteArkivScanError(paged.entities.length, paged.pagesScanned, "dataset discovery"));
      if (!paged.entities.length) return [];
      const block = await withDiscoveryStage("whitechain_latest_block_read", async () =>
        deps.whitechainClient.getBlock({ blockNumber: await deps.whitechainClient.getBlockNumber() }));
      const results = [];
      const seenDatasets = new Set<string>();
      for (const row of paged.entities) {
        const id = row.datasetId.value as Hex;
        const publisher = row.publisher.value as Address;
        if (row.$owner.toLowerCase() !== publisher.toLowerCase() || row.status.value !== "active" || seenDatasets.has(id.toLowerCase())) continue;
        const [onChainPublisher, policy, grant] = await Promise.all([
          withDiscoveryStage("whitechain_dataset_owner_read", () => deps.whitechainClient.readContract({ address: deps.settlementAddress, abi: settlementApiAbi, functionName: "datasetPublisher", args: [id] })),
          withDiscoveryStage("whitechain_dataset_policy_read", () => deps.whitechainClient.readContract({ address: deps.settlementAddress, abi: settlementApiAbi, functionName: "datasetPolicies", args: [id] })),
          withDiscoveryStage("whitechain_coordinator_grant_read", () => deps.whitechainClient.readContract({ address: deps.settlementAddress, abi: settlementApiAbi, functionName: "coordinatorGrants", args: [id, deps.coordinatorAccount.address] })),
        ]);
        if (onChainPublisher.toLowerCase() !== publisher.toLowerCase() || !policy[6] || !grant[2] || block.timestamp >= policy[4] || block.timestamp >= grant[0]) continue;
        seenDatasets.add(id.toLowerCase());
        results.push({ datasetId: id, publisher, category: row.category.value, title: row.title.value, description: row.description.value,
          pricePerRecord: policy[0].toString(), maxRecordsPerQuery: policy[3], maxPayoutPerQuery: policy[1].toString(), policyExpiresAt: policy[4].toString(),
          coordinator: deps.coordinatorAccount.address, coordinatorGrantExpiresAt: grant[0].toString() });
      }
      return results;
    });
  }

  const discoveryFailure = (req: Request, res: Response, route: string, resource: string, error: unknown) => {
    const stageError = error instanceof DiscoveryStageError ? error : undefined;
    const original = stageError?.original ?? error;
    const stage = stageError?.stage ?? "discovery_processing";
    const errorMetadata = safeDiscoveryErrorMetadata(error);
    const requestId = safeRequestId(req);
    console.error(JSON.stringify({ event: "discovery_failed", requestId, route, stage, ...errorMetadata }));
    // Public, structured fallback when deploy logs cannot be reached. Only fixed stage labels and sanitized metadata are exposed.
    res.setHeader("X-QueryMint-Discovery-Diagnostic", JSON.stringify({ requestId, stage, ...errorMetadata }));
    if (original instanceof IncompleteArkivScanError) return res.status(503).json({ error: original.message, code: original.code, retryable: true });
    return res.status(503).json({ error: `${resource} discovery is temporarily unavailable. Retry shortly.`, code: "DISCOVERY_UNAVAILABLE", retryable: true });
  };
  app.get("/publishers", async (req, res) => { try { res.json({ publishers: await loadPublishers() }); } catch (error) { discoveryFailure(req, res, "GET /publishers", "Publisher", error); } });
  app.get("/datasets", async (req, res) => { try { res.json({ datasets: await loadDatasets() }); } catch (error) { discoveryFailure(req, res, "GET /datasets", "Dataset", error); } });
  app.get("/datasets/:datasetId", async (req, res) => {
    if (!isBytes32(req.params.datasetId)) return badRequest(res, "datasetId must be bytes32");
    try { const items = await loadDatasets(req.params.datasetId as Hex); res.status(items.length ? 200 : 404).json(items[0] ?? { error: "Dataset not found or inactive" }); }
    catch (error) { discoveryFailure(req, res, "GET /datasets/:datasetId", "Dataset", error); }
  });

  app.post("/query/quote", async (req, res) => {
    const buyer = req.body?.buyer;
    const filters = req.body?.where;
    const category = filters?.category;
    const limit = req.body?.limit ?? 20;
    if (typeof buyer !== "string" || !isAddress(buyer)) return badRequest(res, "buyer must be an EVM address");
    if (!filters || typeof filters !== "object" || Array.isArray(filters) || Object.keys(filters).some((key) => key !== "category")) return badRequest(res, "Only the indexed category filter is currently supported");
    if (typeof category !== "string" || category.length < 1 || category.length > 64 || !/^[a-zA-Z0-9._-]+$/.test(category)) return badRequest(res, "where.category is invalid");
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return badRequest(res, "limit must be an integer from 1 to 1000");
    try {
      const scanResult = await getRecords(category, limit);
      const scan: QueryRecordScanResult = Array.isArray(scanResult)
        ? { records: scanResult, totalMatching: scanResult.length, complete: true, pagesScanned: 1 }
        : scanResult;
      if (!scan.complete) return res.status(503).json({ error: "Arkiv record search reached its bounded scan limit; results may be incomplete. Narrow the query and retry.", code: "INCOMPLETE_RESULTS", retryable: true, recordsObserved: scan.totalMatching, pagesScanned: scan.pagesScanned });
      if (scan.totalMatching > MAX_SETTLEMENT_RECORDS) return res.status(422).json({ error: `Query matched ${scan.totalMatching} authorized records; the deployed contract allows at most ${MAX_SETTLEMENT_RECORDS} records per settlement. Narrow the query.`, code: "QUERY_CAPACITY_EXCEEDED", maxRecords: MAX_SETTLEMENT_RECORDS, totalMatchingRecords: scan.totalMatching });
      const found = scan.records.slice(0, limit).sort((a, b) => BigInt(a.datasetId) < BigInt(b.datasetId) ? -1 : BigInt(a.datasetId) > BigInt(b.datasetId) ? 1 : BigInt(a.contentHash) < BigInt(b.contentHash) ? -1 : BigInt(a.contentHash) > BigInt(b.contentHash) ? 1 : 0);
      if (!found.length) return res.status(404).json({ error: "No authorized records matched this query" });
      const recordByHash = new Map<string, VerifiedRecord>();
      for (const row of found) {
        const hash = row.contentHash.toLowerCase();
        const previous = recordByHash.get(hash);
        if (previous) return res.status(422).json({ error: `Duplicate content hash appears in datasets ${previous.datasetId} and ${row.datasetId}; this query cannot be settled safely.`, code: "DUPLICATE_CONTENT_HASH", firstDatasetId: previous.datasetId, duplicateDatasetId: row.datasetId });
        recordByHash.set(hash, row);
      }
      const byDataset = new Map<string, VerifiedRecord[]>();
      for (const row of found) {
        const key = row.datasetId.toLowerCase();
        const list = byDataset.get(key) ?? [];
        list.push(row); byDataset.set(key, list);
      }
      const groups = [...byDataset.values()].sort((a, b) => BigInt(a[0]!.datasetId) < BigInt(b[0]!.datasetId) ? -1 : BigInt(a[0]!.datasetId) > BigInt(b[0]!.datasetId) ? 1 : 0);
      if (groups.length > MAX_SETTLEMENT_ALLOCATIONS) return res.status(422).json({ error: `Query requires ${groups.length} dataset allocations; the deployed contract allows at most ${MAX_SETTLEMENT_ALLOCATIONS}. Narrow the query or result limit.`, code: "QUERY_CAPACITY_EXCEEDED", maxAllocations: MAX_SETTLEMENT_ALLOCATIONS, totalAllocations: groups.length });
      const queryId = `0x${randomBytes(32).toString("hex")}` as Hex;
      const quoteBlock = await deps.whitechainClient.getBlock({ blockNumber: await deps.whitechainClient.getBlockNumber() });
      const now = deps.now ? BigInt(Math.floor(deps.now() / 1000)) : quoteBlock.timestamp;
      for (const [storedId, quote] of quoteStore) if (quote.expiresAt <= Number(now)) quoteStore.delete(storedId);
      if (quoteStore.size >= 10_000) return res.status(503).json({ error: "Quote capacity reached; try again shortly" });
      const ttlSeconds = deps.quoteTtlSeconds ?? 300;
      if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 1_800) return res.status(503).json({ error: "Coordinator quote TTL must be from 30 to 1800 seconds" });
      const ttl = BigInt(ttlSeconds);
      const allocations: Allocation[] = [];
      const previewRecords: StoredQuote["records"] = [];
      const publisherApprovalsRequired = new Set<string>();
      let deadline = now + ttl;
      for (const rows of groups) {
        const first = rows[0]!;
        const [onChainPublisher, policy, grant, publisherState] = await Promise.all([
          deps.whitechainClient.readContract({ address: deps.settlementAddress, abi: settlementApiAbi, functionName: "datasetPublisher", args: [first.datasetId] }),
          deps.whitechainClient.readContract({ address: deps.settlementAddress, abi: settlementApiAbi, functionName: "datasetPolicies", args: [first.datasetId] }),
          deps.whitechainClient.readContract({ address: deps.settlementAddress, abi: settlementApiAbi, functionName: "coordinatorGrants", args: [first.datasetId, deps.coordinatorAccount.address] }),
          deps.whitechainClient.readContract({ address: deps.settlementAddress, abi: settlementApiAbi, functionName: "publishers", args: [first.publisher] }),
        ]);
        const chainNow = (await deps.whitechainClient.getBlock({ blockNumber: await deps.whitechainClient.getBlockNumber() })).timestamp;
        if (onChainPublisher.toLowerCase() !== first.publisher.toLowerCase() || !publisherState[2] || !policy[6] || !grant[2] ||
          publisherState[1] !== first.publisherNonce || policy[5] !== first.policyNonce || grant[1] !== first.grantNonce ||
          chainNow >= policy[4] || chainNow >= grant[0] || policy[0] !== first.pricePerRecord ||
          policy[1] !== first.maxPayoutPerQuery || policy[3] !== first.maxRecordsPerQuery) {
          return res.status(409).json({ error: "Publisher policy or coordinator authorization changed; request a fresh quote" });
        }
        const hashes = rows.map((row) => row.contentHash).sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
        if (new Set(hashes.map((h) => h.toLowerCase())).size !== hashes.length) return res.status(422).json({ error: "Duplicate content hash in a dataset result; this query cannot be settled safely.", code: "DUPLICATE_CONTENT_HASH", datasetId: first.datasetId });
        const price = first.pricePerRecord;
        const payoutAmount = price * BigInt(rows.length);
        if (rows.length > first.maxRecordsPerQuery || payoutAmount > first.maxPayoutPerQuery) return res.status(422).json({ error: "Matching records exceed publisher query limits; narrow the query", code: "PUBLISHER_POLICY_CAPACITY_EXCEEDED", datasetId: first.datasetId });
        if (first.publisherSignatureThreshold !== 0n && payoutAmount >= first.publisherSignatureThreshold) publisherApprovalsRequired.add(first.datasetId.toLowerCase());
        deadline = [deadline, first.policyExpiresAt, first.grantExpiresAt].reduce((a, b) => a < b ? a : b);
        allocations.push({ publisher: first.publisher, datasetId: first.datasetId, publisherNonce: first.publisherNonce, policyNonce: first.policyNonce,
          grantNonce: first.grantNonce, recordCount: rows.length, recordHashes: hashes, payoutAmount, publisherSignature: "0x" });
        for (const row of rows) {
          previewRecords.push({ publisher: row.publisher, datasetId: row.datasetId, recordHash: row.contentHash, preview: row.preview, label: row.label });
        }
      }
      if (!allocations.length || deadline <= now) return res.status(422).json({ error: "No quoteable records remain under the current policy" });
      const totalAmount = allocations.reduce((sum, allocation) => sum + allocation.payoutAmount, 0n);
      if (totalAmount > (1n << 128n) - 1n) return res.status(422).json({ error: "Quote total exceeds contract range" });
      const manifest: QueryManifest = { queryId, buyer: buyer as Address, coordinator: deps.coordinatorAccount.address,
        token: WHITECHAIN_USDT, totalAmount, deadline, resultRoot: hashResultRoot(allocations), allocations, coordinatorSignature: "0x" };
      const domain = { name: "QueryMint" as const, version: "1" as const, chainId: 1874 as const, verifyingContract: deps.settlementAddress };
      const allocationsHash = hashAllocations(domain, allocations);
      manifest.coordinatorSignature = await deps.coordinatorAccount.signTypedData({ domain, types: queryManifestTypes, primaryType: "QueryManifest",
        message: { queryId, buyer: manifest.buyer, coordinator: manifest.coordinator, token: manifest.token, totalAmount, deadline, resultRoot: manifest.resultRoot, allocationsHash } });
      quoteStore.set(queryId.toLowerCase(), { manifest, expiresAt: Number(deadline), records: previewRecords, publisherApprovalsRequired });
      return res.status(201).json({ quoteId: queryId, manifest: serializeManifest(manifest), settlementAddress: deps.settlementAddress,
        records: previewRecords, totalMatchingRecords: scan.totalMatching, eligibleRecords: previewRecords.length, searchComplete: scan.complete,
        breakdown: allocations.map((a) => ({ publisher: a.publisher, datasetId: a.datasetId, recordCount: a.recordCount,
          pricePerRecord: (a.payoutAmount / BigInt(a.recordCount)).toString(), payoutAmount: a.payoutAmount.toString() })),
        publisherApprovalRequests: allocations.filter((a) => publisherApprovalsRequired.has(a.datasetId.toLowerCase())).map((a) => ({
          publisher: a.publisher, datasetId: a.datasetId, domain: { name: "QueryMint", version: "1", chainId: 1874, verifyingContract: deps.settlementAddress },
          types: publisherApprovalTypes, primaryType: "PublisherApproval", message: {
            queryId, publisher: a.publisher, datasetId: a.datasetId, publisherNonce: a.publisherNonce.toString(), policyNonce: a.policyNonce.toString(),
            grantNonce: a.grantNonce.toString(), recordCount: a.recordCount, recordHashesHash: hashRecordHashes(a.recordHashes),
            payoutAmount: a.payoutAmount.toString(), deadline: deadline.toString(),
          },
        })) });
    } catch (e) {
      if (e instanceof DuplicateContentHashError) return res.status(422).json({ error: e.message, code: e.code, firstDatasetId: e.firstDatasetId, duplicateDatasetId: e.duplicateDatasetId });
      if (e instanceof Error && (e as Error & { code?: string }).code === "INCOMPLETE_RESULTS") return res.status(503).json({ error: safeError(e), code: "INCOMPLETE_RESULTS", retryable: true });
      return res.status(503).json({ error: safeError(e), code: "QUERY_UNAVAILABLE", retryable: true });
    }
  });

  app.get("/query/:queryId/quote", async (req, res) => {
    const id = req.params.queryId as Hex;
    if (!isBytes32(id)) return badRequest(res, "queryId must be bytes32");
    const stored = quoteStore.get(id.toLowerCase());
    if (!stored) return res.status(404).json({ error: "Unknown or expired coordinator quote" });
    const currentTime = deps.now ? BigInt(Math.floor(deps.now() / 1000)) : (await deps.whitechainClient.getBlock({ blockNumber: await deps.whitechainClient.getBlockNumber() })).timestamp;
    if (stored.manifest.deadline <= currentTime) return res.status(410).json({ error: "Quote expired" });
    return res.json({ quoteId: id, manifest: serializeManifest(stored.manifest), approvalsRequired: [...stored.publisherApprovalsRequired],
      approvalsMissing: [...stored.publisherApprovalsRequired].filter((dataset) => !stored.manifest.allocations.find((a) => a.datasetId.toLowerCase() === dataset)?.publisherSignature ||
        stored.manifest.allocations.find((a) => a.datasetId.toLowerCase() === dataset)?.publisherSignature === "0x") });
  });

  app.post("/query/:queryId/publisher-approval", async (req, res) => {
    const id = req.params.queryId as Hex;
    const datasetId = req.body?.datasetId;
    const signature = req.body?.signature;
    if (!isBytes32(id) || !isBytes32(datasetId) || !isCanonicalSignature(signature)) return badRequest(res, "queryId, datasetId, or signature is invalid");
    const stored = quoteStore.get(id.toLowerCase());
    if (!stored) return res.status(404).json({ error: "Unknown or expired coordinator quote" });
    const allocation = stored.manifest.allocations.find((item) => item.datasetId.toLowerCase() === datasetId.toLowerCase());
    if (!allocation || !stored.publisherApprovalsRequired.has(datasetId.toLowerCase())) return res.status(409).json({ error: "Publisher approval is not required for this allocation" });
    try {
      const approvalBlock = await deps.whitechainClient.getBlock({ blockNumber: await deps.whitechainClient.getBlockNumber() });
      if (approvalBlock.timestamp >= stored.manifest.deadline) return res.status(410).json({ error: "Quote expired before publisher approval" });
      const digest = hashPublisherApproval(
        { name: "QueryMint", version: "1", chainId: 1874, verifyingContract: deps.settlementAddress },
        stored.manifest.queryId, allocation, stored.manifest.deadline,
      );
      const signer = await recoverAddress({ hash: digest, signature });
      if (signer.toLowerCase() !== allocation.publisher.toLowerCase()) return res.status(403).json({ error: "Signature is not from the dataset publisher" });
      allocation.publisherSignature = signature;
      return res.json({ queryId: id, datasetId, approved: true });
    } catch (e) { return res.status(400).json({ error: safeError(e) }); }
  });

  app.get("/query/:queryId/status", async (req, res) => {
    const id = req.params.queryId as Hex;
    if (!isBytes32(id)) return badRequest(res, "queryId must be bytes32");
    const stored = quoteStore.get(id.toLowerCase());
    if (!stored) return res.status(404).json({ error: "Unknown or expired coordinator quote" });
    try {
      const settled = await deps.whitechainClient.readContract({ address: deps.settlementAddress, abi: settlementApiAbi, functionName: "settledQueries", args: [id] });
      const logs = settled ? await deps.whitechainClient.getLogs({ address: deps.settlementAddress, event: querySettledEvent, args: { queryId: id }, fromBlock: deps.deploymentBlock ?? 0n }) : [];
      return res.json({ queryId: id, settled, settlement: logs.at(-1) ? { transactionHash: logs.at(-1)!.transactionHash, blockNumber: logs.at(-1)!.blockNumber } : null });
    } catch (e) { return res.status(503).json({ error: safeError(e) }); }
  });

  app.post("/query/:queryId/deliver", async (req, res) => {
    const id = req.params.queryId as Hex;
    const txHash = req.body?.transactionHash;
    const buyer = req.body?.buyer;
    const buyerSignature = req.body?.buyerSignature;
    if (!isBytes32(id) || !isBytes32(txHash) || typeof buyer !== "string" || !isAddress(buyer) || !isCanonicalSignature(buyerSignature)) return badRequest(res, "queryId, transactionHash, buyer, or buyerSignature is invalid");
    const stored = quoteStore.get(id.toLowerCase());
    if (stored?.manifest.buyer.toLowerCase() !== buyer.toLowerCase() && stored) return res.status(403).json({ error: "Buyer does not match quote" });
    try {
      const buyerSigner = await recoverTypedDataAddress({ domain: { name: "QueryMint", version: "1", chainId: 1874, verifyingContract: deps.settlementAddress }, types: deliveryAuthorizationTypes,
        primaryType: "DeliveryAuthorization", message: { queryId: id, transactionHash: txHash as Hex, buyer: buyer as Address }, signature: buyerSignature });
      if (buyerSigner.toLowerCase() !== buyer.toLowerCase()) return res.status(403).json({ error: "Delivery request is not signed by the buyer" });
      if (stored?.delivered && stored.delivered.txHash.toLowerCase() === (txHash as string).toLowerCase() && stored.delivered.buyer.toLowerCase() === buyer.toLowerCase()) return res.json({ queryId: id, transactionHash: stored.delivered.txHash, records: stored.delivered.records, duplicateRequest: true });
      const receipt = await deps.whitechainClient.getTransactionReceipt({ hash: txHash as Hex });
      const tx = await deps.whitechainClient.getTransaction({ hash: txHash as Hex });
      if (receipt.status !== "success" || tx.from.toLowerCase() !== buyer.toLowerCase() || tx.to?.toLowerCase() !== deps.settlementAddress.toLowerCase()) return res.status(403).json({ error: "Transaction is not a successful settlement from this buyer" });
      const settled = await deps.whitechainClient.readContract({ address: deps.settlementAddress, abi: settlementApiAbi, functionName: "settledQueries", args: [id] });
      if (!settled) return res.status(403).json({ error: "Query has not been settled on-chain" });
      let decoded: ReturnType<typeof decodeFunctionData>;
      try { decoded = decodeFunctionData({ abi: settlementCallAbi, data: tx.input }); }
      catch { return res.status(403).json({ error: "Settlement transaction calldata is invalid" }); }
      if (decoded.functionName !== "settle") return res.status(403).json({ error: "Transaction is not a QueryMint settlement" });
      const manifest = reviveManifest(decoded.args[0]);
      if (manifest.queryId.toLowerCase() !== id.toLowerCase() || manifest.buyer.toLowerCase() !== buyer.toLowerCase() ||
        manifest.coordinator.toLowerCase() !== deps.coordinatorAccount.address.toLowerCase() || manifest.token.toLowerCase() !== WHITECHAIN_USDT.toLowerCase() ||
        manifest.totalAmount !== manifest.allocations.reduce((sum, allocation) => sum + allocation.payoutAmount, 0n) ||
        manifest.allocations.some((allocation) => allocation.recordCount !== allocation.recordHashes.length) ||
        hashResultRoot(manifest.allocations).toLowerCase() !== manifest.resultRoot.toLowerCase()) {
        return res.status(403).json({ error: "Settlement manifest does not match this buyer or its allocation totals" });
      }
      const domain = { name: "QueryMint" as const, version: "1" as const, chainId: 1874 as const, verifyingContract: deps.settlementAddress };
      const manifestDigest = hashQueryManifest(domain, manifest);
      if ((await recoverAddress({ hash: manifestDigest, signature: manifest.coordinatorSignature })).toLowerCase() !== deps.coordinatorAccount.address.toLowerCase()) {
        return res.status(403).json({ error: "Settlement manifest coordinator signature is invalid" });
      }
      const log = receipt.logs.map((entry) => {
        if (entry.address.toLowerCase() !== deps.settlementAddress.toLowerCase()) return undefined;
        try { return decodeEventLog({ abi: [querySettledEvent], data: entry.data, topics: entry.topics }); } catch { return undefined; }
      }).find((entry) => entry?.eventName === "QuerySettled" && (entry.args as any).queryId.toLowerCase() === id.toLowerCase());
      if (!log || (log.args as any).buyer.toLowerCase() !== buyer.toLowerCase() || (log.args as any).coordinator.toLowerCase() !== manifest.coordinator.toLowerCase() || (log.args as any).totalAmount !== manifest.totalAmount || (log.args as any).resultRoot.toLowerCase() !== manifest.resultRoot.toLowerCase() || (log.args as any).manifestDigest.toLowerCase() !== manifestDigest.toLowerCase()) {
        return res.status(403).json({ error: "Receipt does not prove settlement of this quote" });
      }
      const paid = receipt.logs.flatMap((entry) => {
        if (entry.address.toLowerCase() !== deps.settlementAddress.toLowerCase()) return [];
        try { const event = decodeEventLog({ abi: [allocationPaidEvent], data: entry.data, topics: entry.topics }); return event.eventName === "AllocationPaid" && (event.args as any).queryId.toLowerCase() === id.toLowerCase() ? [event.args as any] : []; }
        catch { return []; }
      });
      if (paid.length !== manifest.allocations.length || manifest.allocations.some((allocation) => {
        const events = paid.filter((event) => event.datasetId.toLowerCase() === allocation.datasetId.toLowerCase());
        return events.length !== 1 || events[0].publisher.toLowerCase() !== allocation.publisher.toLowerCase() ||
          events[0].amount !== allocation.payoutAmount || events[0].recordCount !== allocation.recordCount ||
          events[0].payout.toLowerCase() === "0x0000000000000000000000000000000000000000";
      }) || paid.reduce((sum, event) => sum + event.amount, 0n) !== manifest.totalAmount) {
        return res.status(403).json({ error: "Receipt allocation payouts do not match the signed manifest" });
      }
      const outgoingTransfers = receipt.logs.flatMap((entry) => {
        if (entry.address.toLowerCase() !== WHITECHAIN_USDT.toLowerCase()) return [];
        try { const event = decodeEventLog({ abi: [erc20TransferEvent], data: entry.data, topics: entry.topics }); return event.eventName === "Transfer" && event.args.from.toLowerCase() === deps.settlementAddress.toLowerCase() ? [event.args] : []; }
        catch { return []; }
      });
      const transferKey = (recipient: string, value: bigint) => `${recipient.toLowerCase()}:${value}`;
      const expectedTransfers = new Map<string, number>();
      const actualTransfers = new Map<string, number>();
      for (const event of paid) {
        const key = transferKey(event.payout, event.amount);
        expectedTransfers.set(key, (expectedTransfers.get(key) ?? 0) + 1);
      }
      for (const transfer of outgoingTransfers) {
        const key = transferKey(transfer.to, transfer.value);
        actualTransfers.set(key, (actualTransfers.get(key) ?? 0) + 1);
      }
      if (outgoingTransfers.length !== paid.length || [...expectedTransfers].some(([key, count]) => actualTransfers.get(key) !== count)) {
        return res.status(403).json({ error: "USDT transfer recipients or amounts do not match the allocation events" });
      }
      const records = await getManifestRecords(manifest);
      if (records.length !== manifest.allocations.reduce((sum, allocation) => sum + allocation.recordCount, 0) || manifest.allocations.some((allocation) => {
        const rows = records.filter((row) => row.datasetId.toLowerCase() === allocation.datasetId.toLowerCase() && row.publisher.toLowerCase() === allocation.publisher.toLowerCase());
        return rows.length !== allocation.recordCount || allocation.recordHashes.some((hash) => rows.filter((row) => row.recordHash.toLowerCase() === hash.toLowerCase()).length !== 1);
      })) return res.status(403).json({ error: "Retrieved record count or content hashes do not match the signed manifest" });
      if (stored) stored.delivered = { txHash: txHash as Hex, buyer: buyer as Address, records };
      return res.json({ queryId: id, transactionHash: txHash, blockNumber: receipt.blockNumber.toString(), records, duplicateRequest: false });
    } catch (e) {
      if (e instanceof DeliveryVerificationError) return res.status(403).json({ error: safeError(e) });
      return res.status(503).json({ error: safeError(e) });
    }
  });

  app.get("/publishers/:address/earnings", async (req, res) => {
    if (!isAddress(req.params.address)) return badRequest(res, "publisher address is invalid");
    try {
      const logs = await deps.whitechainClient.getLogs({ address: deps.settlementAddress, event: allocationPaidEvent,
        args: { publisher: req.params.address as Address }, fromBlock: deps.deploymentBlock ?? 0n });
      const total = logs.reduce((sum, log) => sum + log.args.amount!, 0n);
      return res.json({ publisher: req.params.address, totalAmount: total.toString(), settlements: logs.map((log) => ({
        queryId: log.args.queryId, datasetId: log.args.datasetId, amount: log.args.amount!.toString(), recordCount: log.args.recordCount,
        transactionHash: log.transactionHash, blockNumber: log.blockNumber?.toString(), payout: log.args.payout,
      })) });
    } catch (e) { return res.status(503).json({ error: safeError(e) }); }
  });

  app.use((error: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    res.status(400).json({ error: safeError(error) });
  });
  return app;
}

export function parseQuoteManifest(json: unknown): QueryManifest { return reviveManifest(json); }
