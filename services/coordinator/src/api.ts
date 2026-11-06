import express, { type Express, type Request, type Response } from "express";
import {
  hashAllocations,
  hashPublisherApproval,
  hashRecordHashes,
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
  recoverAddress,
  parseAbiItem,
  type Hex,
  type PublicClient,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { randomBytes } from "node:crypto";
import { queryAuthorizedRecords, type VerifiedRecord } from "./arkiv/query.js";
import { PublisherProfile, DatasetManifest } from "./arkiv/schema.js";
import { eq, and } from "@arkiv-network/sdk/query";
import { key } from "@arkiv-network/sdk/schema";

const querySettledEvent = parseAbiItem(
  "event QuerySettled(bytes32 indexed queryId,address indexed buyer,address indexed coordinator,uint256 totalAmount,bytes32 resultRoot,bytes32 manifestDigest)",
);
const allocationPaidEvent = parseAbiItem(
  "event AllocationPaid(bytes32 indexed queryId,bytes32 indexed datasetId,address indexed publisher,address payout,uint256 amount,uint32 recordCount)",
);

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
  now?: () => number;
  queryRecords?: (category: string, limit: number) => Promise<VerifiedRecord[]>;
  corsOrigin?: string;
}

interface StoredQuote {
  manifest: QueryManifest;
  expiresAt: number;
  records: Array<{ publisher: Address; datasetId: Hex; recordHash: Hex; preview: string; label: string }>;
  privatePayloads: Array<{ publisher: Address; datasetId: Hex; recordHash: Hex; payload: unknown }>;
  publisherApprovalsRequired: Set<string>;
  delivered?: { txHash: Hex; buyer: Address; records: unknown[] };
}

const quoteStore = new Map<string, StoredQuote>();
const rateBuckets = new Map<string, { start: number; count: number }>();

function badRequest(res: Response, message: string): void { res.status(400).json({ error: message }); }
function safeError(error: unknown): string { return error instanceof Error ? error.message : "Request failed"; }
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
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb", strict: true }));
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && origin === deps.corsOrigin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }
    if (req.method === "OPTIONS") { res.sendStatus(origin === deps.corsOrigin ? 204 : 403); return; }
    next();
  });
  app.use((req, res, next) => {
    const now = Date.now();
    const key = req.ip ?? "unknown";
    const bucket = rateBuckets.get(key);
    if (!bucket || now - bucket.start >= 60_000) rateBuckets.set(key, { start: now, count: 1 });
    else if (++bucket.count > 60) { res.status(429).json({ error: "Rate limit exceeded" }); return; }
    if (rateBuckets.size > 5_000) for (const [ip, value] of rateBuckets) if (now - value.start >= 60_000) rateBuckets.delete(ip);
    next();
  });
  app.get("/health", (_req, res) => res.json({ ok: true }));

  const getRecords = deps.queryRecords ?? ((category: string, limit: number) => queryAuthorizedRecords({
    arkivClient: deps.arkivClient,
    whitechainClient: deps.whitechainClient,
    settlementAddress: deps.settlementAddress,
    coordinator: deps.coordinatorAccount.address,
    category,
    maxRecords: limit,
    encryptionKey: deps.encryptionKey,
  }));

  async function loadPublishers(): Promise<unknown[]> {
    const page = await deps.arkivClient.select({ $key: true, $owner: true, wallet: true, status: true, displayName: true, payoutAddress: true })
      .from(PublisherProfile, { onMismatch: "throw" }).where(eq("status", "active")).limit(100).fetch();
    const results = [];
    for (const row of page.entities) {
      const owner = row.wallet.value as Address;
      if (row.$owner.toLowerCase() !== owner.toLowerCase() || row.status.value !== "active") continue;
      const [payout, , registered] = await deps.whitechainClient.readContract({ address: deps.settlementAddress, abi: settlementApiAbi, functionName: "publishers", args: [owner] });
      if (!registered) continue;
      results.push({ address: owner, displayName: row.displayName.value, payoutAddress: payout, entityKey: row.$key });
    }
    return results;
  }
  async function loadDatasets(datasetId?: Hex): Promise<unknown[]> {
    const query = deps.arkivClient.select({ $key: true, $owner: true, datasetId: true, publisher: true, category: true, status: true, title: true, description: true })
      .from(DatasetManifest, { onMismatch: "throw" });
    const predicate = datasetId ? and(eq("status", "active"), eq("datasetId", key(datasetId))) : eq("status", "active");
    const page = await query.where(predicate).limit(100).fetch();
    const results = [];
    for (const row of page.entities) {
      const id = row.datasetId.value as Hex;
      const publisher = row.publisher.value as Address;
      if (row.$owner.toLowerCase() !== publisher.toLowerCase() || row.status.value !== "active") continue;
      const [onChainPublisher, policy, grant] = await Promise.all([
        deps.whitechainClient.readContract({ address: deps.settlementAddress, abi: settlementApiAbi, functionName: "datasetPublisher", args: [id] }),
        deps.whitechainClient.readContract({ address: deps.settlementAddress, abi: settlementApiAbi, functionName: "datasetPolicies", args: [id] }),
        deps.whitechainClient.readContract({ address: deps.settlementAddress, abi: settlementApiAbi, functionName: "coordinatorGrants", args: [id, deps.coordinatorAccount.address] }),
      ]);
      const block = await deps.whitechainClient.getBlock({ blockNumber: await deps.whitechainClient.getBlockNumber() });
      if (onChainPublisher.toLowerCase() !== publisher.toLowerCase() || !policy[6] || !grant[2] || block.timestamp >= policy[4] || block.timestamp >= grant[0]) continue;
      results.push({ datasetId: id, publisher, category: row.category.value, title: row.title.value, description: row.description.value,
        pricePerRecord: policy[0].toString(), maxRecordsPerQuery: policy[3], maxPayoutPerQuery: policy[1].toString(), policyExpiresAt: policy[4].toString(),
        coordinator: deps.coordinatorAccount.address, coordinatorGrantExpiresAt: grant[0].toString() });
    }
    return results;
  }

  app.get("/publishers", async (_req, res) => { try { res.json({ publishers: await loadPublishers() }); } catch (e) { res.status(503).json({ error: safeError(e) }); } });
  app.get("/datasets", async (_req, res) => { try { res.json({ datasets: await loadDatasets() }); } catch (e) { res.status(503).json({ error: safeError(e) }); } });
  app.get("/datasets/:datasetId", async (req, res) => {
    if (!isBytes32(req.params.datasetId)) return badRequest(res, "datasetId must be bytes32");
    try { const items = await loadDatasets(req.params.datasetId as Hex); res.status(items.length ? 200 : 404).json(items[0] ?? { error: "Dataset not found or inactive" }); }
    catch (e) { res.status(503).json({ error: safeError(e) }); }
  });

  app.post("/query/quote", async (req, res) => {
    const buyer = req.body?.buyer;
    const filters = req.body?.where;
    const category = filters?.category;
    const limit = req.body?.limit ?? 20;
    if (typeof buyer !== "string" || !isAddress(buyer)) return badRequest(res, "buyer must be an EVM address");
    if (!filters || typeof filters !== "object" || Array.isArray(filters) || Object.keys(filters).some((key) => key !== "category")) return badRequest(res, "Only the indexed category filter is currently supported");
    if (typeof category !== "string" || category.length < 1 || category.length > 64 || !/^[a-zA-Z0-9._-]+$/.test(category)) return badRequest(res, "where.category is invalid");
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) return badRequest(res, "limit must be an integer from 1 to 50");
    try {
      const found = await getRecords(category, limit);
      if (!found.length) return res.status(404).json({ error: "No authorized records matched this query" });
      const byDataset = new Map<string, VerifiedRecord[]>();
      for (const row of found) {
        const key = row.datasetId.toLowerCase();
        const list = byDataset.get(key) ?? [];
        list.push(row); byDataset.set(key, list);
      }
      const groups = [...byDataset.values()].sort((a, b) => BigInt(a[0]!.datasetId) < BigInt(b[0]!.datasetId) ? -1 : 1);
      if (groups.length > 10) return res.status(422).json({ error: "Query matches more than 10 publisher datasets; narrow the category or limit" });
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
      const privatePayloads: StoredQuote["privatePayloads"] = [];
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
        if (new Set(hashes.map((h) => h.toLowerCase())).size !== hashes.length) return res.status(422).json({ error: "Duplicate record hash in dataset result", datasetId: first.datasetId });
        const price = first.pricePerRecord;
        const payoutAmount = price * BigInt(rows.length);
        if (rows.length > first.maxRecordsPerQuery || payoutAmount > first.maxPayoutPerQuery) return res.status(422).json({ error: "Matching records exceed publisher query limits; narrow the query", datasetId: first.datasetId });
        if (first.publisherSignatureThreshold !== 0n && payoutAmount >= first.publisherSignatureThreshold) publisherApprovalsRequired.add(first.datasetId.toLowerCase());
        deadline = [deadline, first.policyExpiresAt, first.grantExpiresAt].reduce((a, b) => a < b ? a : b);
        allocations.push({ publisher: first.publisher, datasetId: first.datasetId, publisherNonce: first.publisherNonce, policyNonce: first.policyNonce,
          grantNonce: first.grantNonce, recordCount: rows.length, recordHashes: hashes, payoutAmount, publisherSignature: "0x" });
        for (const row of rows) {
          previewRecords.push({ publisher: row.publisher, datasetId: row.datasetId, recordHash: row.contentHash, preview: row.preview, label: row.label });
          privatePayloads.push({ publisher: row.publisher, datasetId: row.datasetId, recordHash: row.contentHash, payload: row.payload });
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
      quoteStore.set(queryId.toLowerCase(), { manifest, expiresAt: Number(deadline), records: previewRecords, privatePayloads, publisherApprovalsRequired });
      return res.status(201).json({ quoteId: queryId, manifest: serializeManifest(manifest), settlementAddress: deps.settlementAddress,
        records: previewRecords, breakdown: allocations.map((a) => ({ publisher: a.publisher, datasetId: a.datasetId, recordCount: a.recordCount,
          pricePerRecord: (a.payoutAmount / BigInt(a.recordCount)).toString(), payoutAmount: a.payoutAmount.toString() })),
        publisherApprovalRequests: allocations.filter((a) => publisherApprovalsRequired.has(a.datasetId.toLowerCase())).map((a) => ({
          publisher: a.publisher, datasetId: a.datasetId, domain: { name: "QueryMint", version: "1", chainId: 1874, verifyingContract: deps.settlementAddress },
          types: publisherApprovalTypes, primaryType: "PublisherApproval", message: {
            queryId, publisher: a.publisher, datasetId: a.datasetId, publisherNonce: a.publisherNonce.toString(), policyNonce: a.policyNonce.toString(),
            grantNonce: a.grantNonce.toString(), recordCount: a.recordCount, recordHashesHash: hashRecordHashes(a.recordHashes),
            payoutAmount: a.payoutAmount.toString(), deadline: deadline.toString(),
          },
        })) });
    } catch (e) { return res.status(503).json({ error: safeError(e) }); }
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
    if (!isBytes32(id) || !isBytes32(txHash) || typeof buyer !== "string" || !isAddress(buyer)) return badRequest(res, "queryId, transactionHash, or buyer is invalid");
    const stored = quoteStore.get(id.toLowerCase());
    if (!stored) return res.status(404).json({ error: "Unknown or expired coordinator quote" });
    if (stored.manifest.buyer.toLowerCase() !== buyer.toLowerCase()) return res.status(403).json({ error: "Buyer does not match quote" });
    if (stored.delivered) return res.json({ queryId: id, transactionHash: stored.delivered.txHash, records: stored.delivered.records, duplicateRequest: true });
    try {
      const receipt = await deps.whitechainClient.getTransactionReceipt({ hash: txHash as Hex });
      const tx = await deps.whitechainClient.getTransaction({ hash: txHash as Hex });
      if (receipt.status !== "success" || tx.from.toLowerCase() !== buyer.toLowerCase() || tx.to?.toLowerCase() !== deps.settlementAddress.toLowerCase()) return res.status(403).json({ error: "Transaction is not a successful settlement from this buyer" });
      const log = receipt.logs.map((entry) => {
        if (entry.address.toLowerCase() !== deps.settlementAddress.toLowerCase()) return undefined;
        try { return decodeEventLog({ abi: [querySettledEvent], data: entry.data, topics: entry.topics }); } catch { return undefined; }
      }).find((entry) => entry?.eventName === "QuerySettled" && (entry.args as any).queryId.toLowerCase() === id.toLowerCase());
      const settled = await deps.whitechainClient.readContract({ address: deps.settlementAddress, abi: settlementApiAbi, functionName: "settledQueries", args: [id] });
      if (!settled || !log || (log.args as any).buyer.toLowerCase() !== buyer.toLowerCase() || (log.args as any).coordinator.toLowerCase() !== stored.manifest.coordinator.toLowerCase() || (log.args as any).totalAmount !== stored.manifest.totalAmount || (log.args as any).resultRoot.toLowerCase() !== stored.manifest.resultRoot.toLowerCase()) {
        return res.status(403).json({ error: "Receipt does not prove settlement of this quote" });
      }
      const records = stored.privatePayloads.map((row) => ({ publisher: row.publisher, datasetId: row.datasetId, recordHash: row.recordHash, payload: row.payload }));
      stored.delivered = { txHash: txHash as Hex, buyer: buyer as Address, records };
      return res.json({ queryId: id, transactionHash: txHash, blockNumber: receipt.blockNumber.toString(), records, duplicateRequest: false });
    } catch (e) { return res.status(503).json({ error: safeError(e) }); }
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
