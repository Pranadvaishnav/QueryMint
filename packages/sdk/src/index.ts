import {
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
  decodeEventLog,
  isAddress,
  parseAbiItem,
  recoverAddress,
} from "viem";
import { WHITECHAIN_USDT, hashQueryManifest, hashResultRoot, type QueryManifest } from "@querymint/shared";

export * from "@querymint/shared";

export interface QueryMintQuote {
  quoteId: Hex;
  manifest: QueryManifest;
  settlementAddress: Address;
  records: Array<{ publisher: Address; datasetId: Hex; recordHash: Hex; preview: string; [key: string]: unknown }>;
  totalMatchingRecords?: number;
  eligibleRecords?: number;
  breakdown: Array<{ publisher: Address; datasetId: Hex; recordCount: number; pricePerRecord: string; payoutAmount: string }>;
  publisherApprovalRequests?: Array<{ publisher: Address; datasetId: Hex; domain: unknown; types: unknown; primaryType: string; message: Record<string, unknown> }>;
  approvalsMissing?: Hex[];
}

export interface QueryMintDelivery {
  transactionHash: Hex;
  receipt: TransactionReceipt;
  queryId: Hex;
  blockNumber: string;
  records: Array<{ publisher: Address; datasetId: Hex; recordHash: Hex; payload: unknown }>;
}

export interface CreateQueryMintOptions {
  apiUrl: string;
  settlementAddress: Address;
  walletClient: WalletClient;
  publicClient: PublicClient;
  fetch?: typeof fetch;
  onSettlementConfirmed?: (transactionHash: Hex) => void;
  onPaymentStep?: (step: PaymentStep) => void;
  onDeliveryStep?: (step: DeliveryStep) => void;
}

export type PaymentStep = { stage: "approval" | "settlement"; status: "pending" | "submitted" | "confirmed" | "failed" | "skipped"; transactionHash?: Hex; message?: string };
export type DeliveryStep = { status: "pending" | "signature requested" | "confirmed" | "retryable error" | "unrecoverable error"; message?: string };

const settleAbi = [{
  type: "function", name: "settle", stateMutability: "nonpayable",
  inputs: [{ name: "manifest", type: "tuple", components: [
    { name: "queryId", type: "bytes32" }, { name: "buyer", type: "address" },
    { name: "coordinator", type: "address" }, { name: "token", type: "address" },
    { name: "totalAmount", type: "uint128" }, { name: "deadline", type: "uint64" },
    { name: "resultRoot", type: "bytes32" },
    { name: "allocations", type: "tuple[]", components: [
      { name: "publisher", type: "address" }, { name: "datasetId", type: "bytes32" },
      { name: "publisherNonce", type: "uint64" }, { name: "policyNonce", type: "uint64" },
      { name: "grantNonce", type: "uint64" }, { name: "recordCount", type: "uint32" },
      { name: "recordHashes", type: "bytes32[]" }, { name: "payoutAmount", type: "uint128" },
      { name: "publisherSignature", type: "bytes" },
    ]}, { name: "coordinatorSignature", type: "bytes" },
  ]}], outputs: [],
}] as const;

const erc20Abi = [{
  type: "function", name: "approve", stateMutability: "nonpayable",
  inputs: [{ name: "spender", type: "address" }, { name: "value", type: "uint256" }], outputs: [{ type: "bool" }],
}] as const;
const erc20AllowanceAbi = [{
  type: "function", name: "allowance", stateMutability: "view",
  inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }],
}] as const;
const settlementStateAbi = [
  { type: "function", name: "settledQueries", stateMutability: "view", inputs: [{ name: "queryId", type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "publishers", stateMutability: "view", inputs: [{ name: "publisher", type: "address" }], outputs: [{ type: "address" }, { type: "uint64" }, { type: "bool" }] },
  { type: "function", name: "datasetPublisher", stateMutability: "view", inputs: [{ name: "datasetId", type: "bytes32" }], outputs: [{ type: "address" }] },
  { type: "function", name: "datasetPolicies", stateMutability: "view", inputs: [{ name: "datasetId", type: "bytes32" }], outputs: [{ type: "uint128" }, { type: "uint128" }, { type: "uint128" }, { type: "uint32" }, { type: "uint64" }, { type: "uint64" }, { type: "bool" }] },
  { type: "function", name: "coordinatorGrants", stateMutability: "view", inputs: [{ name: "datasetId", type: "bytes32" }, { name: "coordinator", type: "address" }], outputs: [{ type: "uint64" }, { type: "uint64" }, { type: "bool" }] },
] as const;
const querySettledEvent = parseAbiItem("event QuerySettled(bytes32 indexed queryId,address indexed buyer,address indexed coordinator,uint256 totalAmount,bytes32 resultRoot,bytes32 manifestDigest)");
const deliveryAuthorizationTypes = { DeliveryAuthorization: [
  { name: "queryId", type: "bytes32" }, { name: "transactionHash", type: "bytes32" }, { name: "buyer", type: "address" },
] } as const;

type JsonObject = Record<string, unknown>;
const objectValue = (value: unknown, field: string): JsonObject => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid QueryMint response: ${field} must be an object`);
  return value as JsonObject;
};
const addressValue = (value: unknown, field: string): Address => {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) throw new Error(`Invalid QueryMint response: ${field} must be an address`);
  return value as Address;
};
const bytes32Value = (value: unknown, field: string): Hex => {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`Invalid QueryMint response: ${field} must be bytes32`);
  return value as Hex;
};
const bytesValue = (value: unknown, field: string, bytes?: number): Hex => {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value) || (bytes !== undefined && value.length !== 2 + bytes * 2)) {
    throw new Error(`Invalid QueryMint response: ${field} must be valid hex${bytes === undefined ? "" : ` (${bytes} bytes)`}`);
  }
  return value as Hex;
};
const uintValue = (value: unknown, field: string, bits: number): bigint => {
  if ((typeof value !== "string" && typeof value !== "bigint") || !/^\d+$/.test(String(value))) throw new Error(`Invalid QueryMint response: ${field} must be an unsigned integer`);
  const number = BigInt(value);
  if (number >= (1n << BigInt(bits))) throw new Error(`Invalid QueryMint response: ${field} exceeds uint${bits}`);
  return number;
};
const countValue = (value: unknown, field: string, maximum: number): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error(`Invalid QueryMint response: ${field} must be an integer from 0 to ${maximum}`);
  return value;
};

async function normalizeQuote(value: unknown, expectedBuyer?: Address, expectedSettlement?: Address): Promise<QueryMintQuote> {
  const raw = objectValue(value, "quote");
  const quoteId = bytes32Value(raw.quoteId, "quoteId");
  const manifestRaw = objectValue(raw.manifest, "manifest");
  const queryId = bytes32Value(manifestRaw.queryId, "manifest.queryId");
  const buyer = addressValue(manifestRaw.buyer, "manifest.buyer");
  const coordinator = addressValue(manifestRaw.coordinator, "manifest.coordinator");
  const token = addressValue(manifestRaw.token, "manifest.token");
  const settlementAddress = addressValue(raw.settlementAddress, "settlementAddress");
  if (token.toLowerCase() !== WHITECHAIN_USDT.toLowerCase()) throw new Error("Invalid QueryMint response: manifest token is not official Whitechain Sepolia USDT");
  if (quoteId.toLowerCase() !== queryId.toLowerCase()) throw new Error("Invalid QueryMint response: quoteId does not match manifest queryId");
  if (expectedBuyer && buyer.toLowerCase() !== expectedBuyer.toLowerCase()) throw new Error("Invalid QueryMint response: buyer does not match the connected wallet");
  if (expectedSettlement && settlementAddress.toLowerCase() !== expectedSettlement.toLowerCase()) throw new Error("Invalid QueryMint response: settlement address does not match SDK configuration");

  const totalAmount = uintValue(manifestRaw.totalAmount, "manifest.totalAmount", 128);
  const deadline = uintValue(manifestRaw.deadline, "manifest.deadline", 64);
  const resultRoot = bytes32Value(manifestRaw.resultRoot, "manifest.resultRoot");
  const coordinatorSignature = bytesValue(manifestRaw.coordinatorSignature, "manifest.coordinatorSignature", 65);
  if (!Array.isArray(manifestRaw.allocations) || manifestRaw.allocations.length < 1 || manifestRaw.allocations.length > 10) throw new Error("Invalid QueryMint response: manifest allocations must contain 1 to 10 entries");
  const seenDatasets = new Set<string>();
  const seenHashes = new Set<string>();
  let allocatedAmount = 0n;
  let allocatedRecords = 0;
  const allocations = manifestRaw.allocations.map((value, index) => {
    const rawAllocation = objectValue(value, `manifest.allocations[${index}]`);
    const publisher = addressValue(rawAllocation.publisher, `manifest.allocations[${index}].publisher`);
    const datasetId = bytes32Value(rawAllocation.datasetId, `manifest.allocations[${index}].datasetId`);
    const key = datasetId.toLowerCase();
    if (seenDatasets.has(key)) throw new Error("Invalid QueryMint response: duplicate dataset allocation");
    seenDatasets.add(key);
    const publisherNonce = uintValue(rawAllocation.publisherNonce, `manifest.allocations[${index}].publisherNonce`, 64);
    const policyNonce = uintValue(rawAllocation.policyNonce, `manifest.allocations[${index}].policyNonce`, 64);
    const grantNonce = uintValue(rawAllocation.grantNonce, `manifest.allocations[${index}].grantNonce`, 64);
    const payoutAmount = uintValue(rawAllocation.payoutAmount, `manifest.allocations[${index}].payoutAmount`, 128);
    const recordCount = countValue(rawAllocation.recordCount, `manifest.allocations[${index}].recordCount`, 50);
    if (!recordCount || !Array.isArray(rawAllocation.recordHashes) || rawAllocation.recordHashes.length !== recordCount) throw new Error("Invalid QueryMint response: allocation record count does not match record hashes");
    const recordHashes = rawAllocation.recordHashes.map((hash, hashIndex) => {
      const recordHash = bytes32Value(hash, `manifest.allocations[${index}].recordHashes[${hashIndex}]`);
      const hashKey = recordHash.toLowerCase();
      if (seenHashes.has(hashKey)) throw new Error("Invalid QueryMint response: duplicate record hash");
      seenHashes.add(hashKey);
      return recordHash;
    });
    allocatedAmount += payoutAmount;
    allocatedRecords += recordCount;
    if (allocatedRecords > 50) throw new Error("Invalid QueryMint response: quote exceeds 50 records");
    return { publisher, datasetId, publisherNonce, policyNonce, grantNonce, recordCount, recordHashes,
      payoutAmount, publisherSignature: bytesValue(rawAllocation.publisherSignature, `manifest.allocations[${index}].publisherSignature`) };
  });
  if (allocatedAmount !== totalAmount) throw new Error("Invalid QueryMint response: allocation payouts do not sum to manifest total");

  if (!Array.isArray(raw.records) || raw.records.length !== allocatedRecords) throw new Error("Invalid QueryMint response: record previews do not match manifest record count");
  const expectedRecords = new Set(allocations.flatMap((allocation) => allocation.recordHashes.map((hash) => `${allocation.publisher.toLowerCase()}:${allocation.datasetId.toLowerCase()}:${hash.toLowerCase()}`)));
  for (const [index, value] of raw.records.entries()) {
    const record = objectValue(value, `records[${index}]`);
    if (Object.hasOwn(record, "payload") || Object.hasOwn(record, "encryptedPayload")) throw new Error("Invalid QueryMint response: quote previews must not contain payload data");
    const identity = `${addressValue(record.publisher, `records[${index}].publisher`).toLowerCase()}:${bytes32Value(record.datasetId, `records[${index}].datasetId`).toLowerCase()}:${bytes32Value(record.recordHash, `records[${index}].recordHash`).toLowerCase()}`;
    if (!expectedRecords.delete(identity) || typeof record.preview !== "string") throw new Error("Invalid QueryMint response: record preview does not match signed manifest");
  }
  if (expectedRecords.size) throw new Error("Invalid QueryMint response: a manifest record preview is missing");

  if (!Array.isArray(raw.breakdown) || raw.breakdown.length !== allocations.length) throw new Error("Invalid QueryMint response: payout breakdown does not match allocations");
  const seenBreakdown = new Set<string>();
  const breakdown = raw.breakdown.map((value, index) => {
    const row = objectValue(value, `breakdown[${index}]`);
    const publisher = addressValue(row.publisher, `breakdown[${index}].publisher`);
    const datasetId = bytes32Value(row.datasetId, `breakdown[${index}].datasetId`);
    const recordCount = countValue(row.recordCount, `breakdown[${index}].recordCount`, 50);
    const pricePerRecord = uintValue(row.pricePerRecord, `breakdown[${index}].pricePerRecord`, 128);
    const payoutAmount = uintValue(row.payoutAmount, `breakdown[${index}].payoutAmount`, 128);
    if (seenBreakdown.has(datasetId.toLowerCase())) throw new Error("Invalid QueryMint response: duplicate payout breakdown entry");
    seenBreakdown.add(datasetId.toLowerCase());
    const allocation = allocations.find((candidate) => candidate.datasetId.toLowerCase() === datasetId.toLowerCase());
    if (!allocation || allocation.publisher.toLowerCase() !== publisher.toLowerCase() || allocation.recordCount !== recordCount || allocation.payoutAmount !== payoutAmount || pricePerRecord * BigInt(recordCount) !== payoutAmount) {
      throw new Error("Invalid QueryMint response: payout breakdown differs from signed allocation");
    }
    return { publisher, datasetId, recordCount, pricePerRecord: pricePerRecord.toString(), payoutAmount: payoutAmount.toString() };
  });
  const totalMatchingRecords = countValue(raw.totalMatchingRecords, "totalMatchingRecords", Number.MAX_SAFE_INTEGER);
  const eligibleRecords = countValue(raw.eligibleRecords, "eligibleRecords", 50);
  if (eligibleRecords !== allocatedRecords || totalMatchingRecords < eligibleRecords || raw.searchComplete !== true) throw new Error("Invalid QueryMint response: discovery counts or completeness are inconsistent");

  const publisherApprovalRequests = raw.publisherApprovalRequests;
  if (!Array.isArray(publisherApprovalRequests)) throw new Error("Invalid QueryMint response: publisherApprovalRequests must be an array");
  const approvalsMissing = raw.approvalsMissing;
  if (approvalsMissing !== undefined && (!Array.isArray(approvalsMissing) || approvalsMissing.some((item) => typeof item !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(item)))) {
    throw new Error("Invalid QueryMint response: approvalsMissing must contain dataset IDs");
  }
  const manifest: QueryManifest = { queryId, buyer, coordinator, token, totalAmount, deadline, resultRoot, allocations, coordinatorSignature };
  if (hashResultRoot(allocations).toLowerCase() !== resultRoot.toLowerCase()) throw new Error("Invalid QueryMint response: result root does not match allocation record hashes");
  let signer: Address;
  try { signer = await recoverAddress({ hash: hashQueryManifest({ name: "QueryMint", version: "1", chainId: 1874, verifyingContract: settlementAddress }, manifest), signature: coordinatorSignature }); }
  catch { throw new Error("Invalid QueryMint response: coordinator signature is malformed"); }
  if (signer.toLowerCase() !== coordinator.toLowerCase()) throw new Error("Invalid QueryMint response: coordinator signature does not match manifest");
  return { ...raw, quoteId, settlementAddress, manifest, records: raw.records as QueryMintQuote["records"], totalMatchingRecords,
    eligibleRecords, breakdown, publisherApprovalRequests: publisherApprovalRequests as QueryMintQuote["publisherApprovalRequests"],
    ...(approvalsMissing === undefined ? {} : { approvalsMissing: approvalsMissing as Hex[] }) } as QueryMintQuote;
}

export function createQueryMint(options: CreateQueryMintOptions) {
  const request = options.fetch ?? fetch;
  const apiUrl = options.apiUrl.replace(/\/$/, "");
  return {
    async quote(input: { where: { category: string }; limit?: number }): Promise<QueryMintQuote> {
      const buyer = options.walletClient.account?.address;
      if (!buyer) throw new Error("walletClient must have an account before requesting a quote");
      const response = await request(`${apiUrl}/query/quote`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...input, buyer }),
      });
      if (!response.ok) {
        let detail = `QueryMint quote failed (${response.status})`;
        try { const body = await response.json() as { error?: unknown; code?: unknown }; if (typeof body.error === "string") detail = `${typeof body.code === "string" ? `${body.code}: ` : ""}${body.error}`; }
        catch { /* Keep the status-only fallback for non-JSON responses. */ }
        throw new Error(detail);
      }
      return await normalizeQuote(await response.json(), buyer, options.settlementAddress);
    },
    async submitPublisherApproval(input: { quoteId: Hex; datasetId: Hex; signature: Hex }) {
      const response = await request(`${apiUrl}/query/${input.quoteId}/publisher-approval`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ datasetId: input.datasetId, signature: input.signature }),
      });
      if (!response.ok) throw new Error(`Publisher approval submission failed (${response.status}): ${await response.text()}`);
      return response.json() as Promise<{ queryId: Hex; datasetId: Hex; approved: boolean }>;
    },
    async refreshQuote(input: { quote: QueryMintQuote }): Promise<QueryMintQuote> {
      const response = await request(`${apiUrl}/query/${input.quote.quoteId}/quote`);
      if (!response.ok) throw new Error(`Unable to refresh quote (${response.status}): ${await response.text()}`);
      const latest = objectValue(await response.json(), "refreshed quote");
      if (typeof latest.quoteId !== "string" || latest.quoteId.toLowerCase() !== input.quote.quoteId.toLowerCase()) throw new Error("Invalid QueryMint response: refreshed quote ID changed");
      if (!latest.manifest) throw new Error("Invalid QueryMint response: refreshed manifest is missing");
      const approvalsMissing = latest.approvalsMissing;
      const refreshed = await normalizeQuote({ ...input.quote, manifest: latest.manifest,
        ...(approvalsMissing === undefined ? {} : { approvalsMissing }) }, input.quote.manifest.buyer, options.settlementAddress);
      if (refreshed.manifest.coordinator.toLowerCase() !== input.quote.manifest.coordinator.toLowerCase() ||
        refreshed.manifest.token.toLowerCase() !== input.quote.manifest.token.toLowerCase()) {
        throw new Error("Invalid QueryMint response: refreshed quote changed coordinator or token");
      }
      return { ...refreshed, publisherApprovalRequests: (input.quote.publisherApprovalRequests ?? []).filter((approval) =>
        refreshed.approvalsMissing?.some((datasetId) => datasetId.toLowerCase() === approval.datasetId.toLowerCase())) };
    },
    async deliver(input: { transactionHash: Hex }) {
      const account = options.walletClient.account;
      if (!account) { options.onDeliveryStep?.({ status: "unrecoverable error", message: "Connect the buyer wallet before recovering delivery." }); throw new Error("walletClient must have an account"); }
      options.onDeliveryStep?.({ status: "pending", message: "Verifying the settlement receipt before delivery." });
      if (await options.walletClient.getChainId() !== 1874 || await options.publicClient.getChainId() !== 1874) {
        options.onDeliveryStep?.({ status: "unrecoverable error", message: "Switch both wallet and public client to Whitechain Sepolia before delivery recovery." });
        throw new Error("Delivery requires Whitechain Sepolia clients");
      }
      let receipt;
      try { receipt = await options.publicClient.getTransactionReceipt({ hash: input.transactionHash }); }
      catch (error) { options.onDeliveryStep?.({ status: "retryable error", message: "Could not retrieve the transaction receipt. Check the network and retry." }); throw error; }
      if (receipt.status !== "success") { options.onDeliveryStep?.({ status: "unrecoverable error", message: "This transaction has no successful settlement receipt. Check the transaction hash." }); throw new Error("Settlement transaction did not succeed"); }
      const settlement = receipt.logs.find((entry) => {
        if (entry.address.toLowerCase() !== options.settlementAddress.toLowerCase()) return false;
        try { return decodeEventLog({ abi: [querySettledEvent], data: entry.data, topics: entry.topics }).eventName === "QuerySettled"; }
        catch { return false; }
      });
      if (!settlement) { options.onDeliveryStep?.({ status: "unrecoverable error", message: "This receipt does not contain a QueryMint settlement event." }); throw new Error("Transaction receipt has no QueryMint settlement event"); }
      const event = decodeEventLog({ abi: [querySettledEvent], data: settlement.data, topics: settlement.topics });
      if (event.args.buyer.toLowerCase() !== account.address.toLowerCase()) { options.onDeliveryStep?.({ status: "unrecoverable error", message: "Connect the buyer wallet that submitted this settlement." }); throw new Error("Connected wallet is not the buyer for this settlement"); }
      options.onDeliveryStep?.({ status: "signature requested", message: "Sign the buyer authorization prompt." });
      let buyerSignature: Hex;
      try { buyerSignature = await options.walletClient.signTypedData({ account, domain: { name: "QueryMint", version: "1", chainId: 1874, verifyingContract: options.settlementAddress },
        types: deliveryAuthorizationTypes, primaryType: "DeliveryAuthorization", message: { queryId: event.args.queryId, transactionHash: input.transactionHash, buyer: account.address } }); }
      catch (error) { options.onDeliveryStep?.({ status: "retryable error", message: "Delivery signature was not completed. Retry when ready; no funds were spent." }); throw error; }
      let response: Response;
      try { response = await request(`${apiUrl}/query/${event.args.queryId}/deliver`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ transactionHash: input.transactionHash, buyer: account.address, buyerSignature }),
      }); } catch (error) { options.onDeliveryStep?.({ status: "retryable error", message: "Coordinator delivery could not be reached. Retry using this settlement hash." }); throw error; }
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        options.onDeliveryStep?.({ status: retryable ? "retryable error" : "unrecoverable error", message: retryable ? `Coordinator delivery is temporarily unavailable (${response.status}). Retry.` : `Coordinator rejected delivery (${response.status}). Check the buyer wallet and settlement hash.` });
        throw new Error(`Settlement succeeded but data delivery failed (${response.status})`);
      }
      let body: JsonObject;
      try { body = objectValue(await response.json(), "delivery"); }
      catch { options.onDeliveryStep?.({ status: "unrecoverable error", message: "Coordinator returned an invalid delivery response." }); throw new Error("Invalid QueryMint delivery response"); }
      if (typeof body.queryId !== "string" || body.queryId.toLowerCase() !== event.args.queryId.toLowerCase() ||
        typeof body.transactionHash !== "string" || body.transactionHash.toLowerCase() !== input.transactionHash.toLowerCase() ||
        typeof body.blockNumber !== "string" || body.blockNumber !== receipt.blockNumber.toString() ||
        !Array.isArray(body.records) || body.records.length === 0 || body.records.some((value) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) return true;
          const record = value as JsonObject;
          return !isAddress(String(record.publisher), { strict: false }) || !/^0x[0-9a-fA-F]{64}$/.test(String(record.datasetId)) ||
            !/^0x[0-9a-fA-F]{64}$/.test(String(record.recordHash)) || !Object.hasOwn(record, "payload");
        })) {
        options.onDeliveryStep?.({ status: "unrecoverable error", message: "Coordinator delivery response did not match the confirmed settlement." });
        throw new Error("Invalid QueryMint delivery response");
      }
      const result: QueryMintDelivery = { transactionHash: input.transactionHash, receipt, queryId: event.args.queryId,
        blockNumber: body.blockNumber, records: body.records as QueryMintDelivery["records"] };
      options.onDeliveryStep?.({ status: "confirmed", message: "Delivery authorization verified and records released." });
      return result;
    },
    async pay(input: { quote: QueryMintQuote }) {
      const account = options.walletClient.account;
      if (!account) throw new Error("walletClient must have an account");
      if (account.address.toLowerCase() !== input.quote.manifest.buyer.toLowerCase()) throw new Error("The connected wallet is not the buyer named in this quote");
      const quote = await this.refreshQuote(input);
      if (quote.approvalsMissing?.length) throw new Error(`Publisher approvals are still required for: ${quote.approvalsMissing.join(", ")}`);
      if (quote.settlementAddress.toLowerCase() !== options.settlementAddress.toLowerCase()) throw new Error("Quote settlement address does not match SDK configuration");
      const [chainId, publicChainId] = await Promise.all([options.walletClient.getChainId(), options.publicClient.getChainId()]);
      if (chainId !== 1874 || publicChainId !== 1874 || quote.manifest.token.toLowerCase() !== WHITECHAIN_USDT.toLowerCase()) {
        throw new Error("Quote or wallet is not configured for Whitechain Sepolia USDT");
      }
      const alreadySettled = await options.publicClient.readContract({ address: options.settlementAddress, abi: settlementStateAbi, functionName: "settledQueries", args: [quote.manifest.queryId] });
      if (alreadySettled) throw new Error("This quote is already settled. Recover delivery with its confirmed settlement transaction hash; no new settlement was submitted.");
      const validateCurrentAuthorization = async () => {
        const block = await options.publicClient.getBlock({ blockTag: "latest" });
        if (quote.manifest.deadline <= block.timestamp) throw new Error("Quote expired. Request a new quote before paying.");
        for (const allocation of quote.manifest.allocations) {
          const [publisher, owner, policy, grant] = await Promise.all([
            options.publicClient.readContract({ address: options.settlementAddress, abi: settlementStateAbi, functionName: "publishers", args: [allocation.publisher] }),
            options.publicClient.readContract({ address: options.settlementAddress, abi: settlementStateAbi, functionName: "datasetPublisher", args: [allocation.datasetId] }),
            options.publicClient.readContract({ address: options.settlementAddress, abi: settlementStateAbi, functionName: "datasetPolicies", args: [allocation.datasetId] }),
            options.publicClient.readContract({ address: options.settlementAddress, abi: settlementStateAbi, functionName: "coordinatorGrants", args: [allocation.datasetId, quote.manifest.coordinator] }),
          ]);
          if (!publisher[2] || publisher[1] !== allocation.publisherNonce || owner.toLowerCase() !== allocation.publisher.toLowerCase() ||
            !policy[6] || policy[5] !== allocation.policyNonce || block.timestamp >= policy[4] ||
            !grant[2] || grant[1] !== allocation.grantNonce || block.timestamp >= grant[0]) {
            throw new Error(`Quote authorization changed or expired for dataset ${allocation.datasetId}. Request a new quote.`);
          }
        }
      };
      await validateCurrentAuthorization();
      const currentAllowance = await options.publicClient.readContract({ address: WHITECHAIN_USDT, abi: erc20AllowanceAbi, functionName: "allowance", args: [account.address, options.settlementAddress] });
      if (currentAllowance < quote.manifest.totalAmount) {
        options.onPaymentStep?.({ stage: "approval", status: "pending", message: "Approve the exact USDT amount in MetaMask." });
        let approveHash: Hex;
        try {
          approveHash = await options.walletClient.writeContract({ account, chain: options.walletClient.chain, address: WHITECHAIN_USDT,
            abi: erc20Abi, functionName: "approve", args: [options.settlementAddress, quote.manifest.totalAmount] });
        } catch (error) { options.onPaymentStep?.({ stage: "approval", status: "failed", message: "Approval was not submitted." }); throw error; }
        options.onPaymentStep?.({ stage: "approval", status: "submitted", transactionHash: approveHash, message: "Waiting for approval confirmation." });
        let approval;
        try { approval = await options.publicClient.waitForTransactionReceipt({ hash: approveHash }); }
        catch (error) { options.onPaymentStep?.({ stage: "approval", status: "failed", transactionHash: approveHash, message: "Approval confirmation could not be verified." }); throw error; }
        if (approval.status !== "success") { options.onPaymentStep?.({ stage: "approval", status: "failed", transactionHash: approveHash, message: "Approval transaction reverted." }); throw new Error(`USDT approval transaction failed: ${approveHash}`); }
        options.onPaymentStep?.({ stage: "approval", status: "confirmed", transactionHash: approveHash, message: "Exact USDT approval confirmed." });
      } else options.onPaymentStep?.({ stage: "approval", status: "skipped", message: "Existing USDT allowance already covers this exact amount." });

      await validateCurrentAuthorization();
      options.onPaymentStep?.({ stage: "settlement", status: "pending", message: "Submit settlement in MetaMask after checking the quote is still valid." });
      let txHash: Hex;
      try { txHash = await options.walletClient.writeContract({ account, chain: options.walletClient.chain, address: options.settlementAddress,
        abi: settleAbi, functionName: "settle", args: [quote.manifest] }); }
      catch (error) { options.onPaymentStep?.({ stage: "settlement", status: "failed", message: "Settlement was not submitted. Approval remains confirmed if shown above." }); throw error; }
      options.onPaymentStep?.({ stage: "settlement", status: "submitted", transactionHash: txHash, message: "Waiting for settlement confirmation." });
      let receipt;
      try { receipt = await options.publicClient.waitForTransactionReceipt({ hash: txHash }); }
      catch (error) { options.onPaymentStep?.({ stage: "settlement", status: "failed", transactionHash: txHash, message: "Settlement confirmation could not be verified; check this transaction before retrying." }); throw error; }
      if (receipt.status !== "success") { options.onPaymentStep?.({ stage: "settlement", status: "failed", transactionHash: txHash, message: "Settlement transaction reverted; no payment was confirmed." }); throw new Error(`Settlement transaction failed: ${txHash}`); }
      options.onPaymentStep?.({ stage: "settlement", status: "confirmed", transactionHash: txHash, message: "Settlement confirmed on Whitechain Sepolia." });
      options.onSettlementConfirmed?.(txHash);
      options.onDeliveryStep?.({ status: "pending", message: "Settlement is confirmed. Data delivery now requires a buyer EIP-712 signature." });
      try { return await this.deliver({ transactionHash: txHash }); }
      catch (error) { throw new Error(`Settlement succeeded but data delivery failed; retry with transaction ${txHash}`, { cause: error }); }
    },
  };
}
