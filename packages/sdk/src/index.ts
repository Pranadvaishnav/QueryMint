import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  decodeEventLog,
  parseAbiItem,
} from "viem";
import { WHITECHAIN_USDT, type QueryManifest } from "@querymint/shared";

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

export function createQueryMint(options: CreateQueryMintOptions) {
  const request = options.fetch ?? fetch;
  const apiUrl = options.apiUrl.replace(/\/$/, "");
  const reviveQuote = (quote: any): QueryMintQuote => {
    quote.manifest.totalAmount = BigInt(quote.manifest.totalAmount);
    quote.manifest.deadline = BigInt(quote.manifest.deadline);
    quote.manifest.allocations = quote.manifest.allocations.map((allocation: any) => ({
      ...allocation,
      publisherNonce: BigInt(allocation.publisherNonce), policyNonce: BigInt(allocation.policyNonce),
      grantNonce: BigInt(allocation.grantNonce), payoutAmount: BigInt(allocation.payoutAmount),
    }));
    return quote as QueryMintQuote;
  };
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
      return reviveQuote(await response.json());
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
      const latest = await response.json() as any;
      return reviveQuote({ ...input.quote, manifest: latest.manifest, approvalsMissing: latest.approvalsMissing,
        publisherApprovalRequests: (input.quote.publisherApprovalRequests ?? []).filter((request) => latest.approvalsMissing?.includes(request.datasetId.toLowerCase())) });
    },
    async deliver(input: { transactionHash: Hex }) {
      const account = options.walletClient.account;
      if (!account) { options.onDeliveryStep?.({ status: "unrecoverable error", message: "Connect the buyer wallet before recovering delivery." }); throw new Error("walletClient must have an account"); }
      options.onDeliveryStep?.({ status: "pending", message: "Verifying the settlement receipt before delivery." });
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
      const result = { transactionHash: input.transactionHash, receipt, ...(await response.json() as { records: unknown[]; blockNumber: string; queryId: Hex }) };
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
      const chainId = await options.walletClient.getChainId();
      if (chainId !== 1874 || quote.manifest.token.toLowerCase() !== WHITECHAIN_USDT.toLowerCase()) {
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
