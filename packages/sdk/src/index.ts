import {
  encodeFunctionData,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { WHITECHAIN_USDT, type QueryManifest } from "@querymint/shared";

export * from "@querymint/shared";

export interface QueryMintQuote {
  quoteId: Hex;
  manifest: QueryManifest;
  settlementAddress: Address;
  records: Array<{ publisher: Address; datasetId: Hex; recordHash: Hex; preview: string; [key: string]: unknown }>;
  breakdown: Array<{ publisher: Address; datasetId: Hex; recordCount: number; pricePerRecord: string; payoutAmount: string }>;
}

export interface CreateQueryMintOptions {
  apiUrl: string;
  settlementAddress: Address;
  walletClient: WalletClient;
  publicClient: PublicClient;
  fetch?: typeof fetch;
}

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

export function createQueryMint(options: CreateQueryMintOptions) {
  const request = options.fetch ?? fetch;
  const apiUrl = options.apiUrl.replace(/\/$/, "");
  return {
    async quote(input: { where: { category: string }; limit?: number }): Promise<QueryMintQuote> {
      const response = await request(`${apiUrl}/v1/quotes`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
      });
      if (!response.ok) throw new Error(`QueryMint quote failed (${response.status}): ${await response.text()}`);
      return response.json() as Promise<QueryMintQuote>;
    },
    async pay(input: { quote: QueryMintQuote }) {
      const account = options.walletClient.account;
      if (!account) throw new Error("walletClient must have an account");
      const chainId = await options.walletClient.getChainId();
      if (chainId !== 1874 || input.quote.manifest.token.toLowerCase() !== WHITECHAIN_USDT.toLowerCase()) {
        throw new Error("Quote or wallet is not configured for Whitechain Sepolia USDT");
      }
      const approveHash = await options.walletClient.writeContract({
        account, chain: options.walletClient.chain, address: WHITECHAIN_USDT,
        abi: erc20Abi, functionName: "approve", args: [options.settlementAddress, input.quote.manifest.totalAmount],
      });
      const approval = await options.publicClient.waitForTransactionReceipt({ hash: approveHash });
      if (approval.status !== "success") throw new Error("USDT approval transaction failed");
      const txHash = await options.walletClient.sendTransaction({
        account, chain: options.walletClient.chain, to: options.settlementAddress,
        data: encodeFunctionData({ abi: settleAbi, functionName: "settle", args: [input.quote.manifest] }),
      });
      const receipt = await options.publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") throw new Error(`Settlement transaction failed: ${txHash}`);
      const delivery = await request(`${apiUrl}/v1/quotes/${input.quote.quoteId}/deliver`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ transactionHash: txHash, buyer: account.address }),
      });
      if (!delivery.ok) throw new Error(`Settlement succeeded but data delivery failed (${delivery.status}); transaction: ${txHash}`);
      return { transactionHash: txHash, receipt, ...(await delivery.json() as { records: unknown[] }) };
    },
  };
}
