import { useMemo, useState } from "react";
import { formatUnits, type Address } from "viem";
import { useAccount, useConnect, usePublicClient, useWalletClient } from "wagmi";
import { createQueryMint, type QueryMintQuote } from "@querymint/sdk";
import { whitechainSepolia } from "@querymint/shared";

const settlementAddress = import.meta.env.VITE_QUERYMINT_SETTLEMENT_ADDRESS as Address | undefined;
const apiUrl = (import.meta.env.VITE_COORDINATOR_API_URL || (import.meta.env.DEV ? "http://localhost:3001" : "")).replace(/\/+$/, "");

export function App() {
  const { address, isConnected } = useAccount();
  const { connectors, connect } = useConnect();
  const { data: walletClient } = useWalletClient({ chainId: whitechainSepolia.id });
  const publicClient = usePublicClient({ chainId: whitechainSepolia.id });
  const querymint = useMemo(() => walletClient && publicClient && settlementAddress ? createQueryMint({ apiUrl, settlementAddress, walletClient, publicClient }) : null, [walletClient, publicClient]);
  const [category, setCategory] = useState("defi");
  const [quote, setQuote] = useState<QueryMintQuote | null>(null);
  const [result, setResult] = useState<any>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function runQuery() {
    if (!querymint) return;
    setError(""); setResult(null); setPending(true);
    try { setQuote(await querymint.quote({ where: { category }, limit: 20 })); }
    catch (e) { setError(e instanceof Error ? e.message : "Quote request failed"); }
    finally { setPending(false); }
  }
  async function settle() {
    if (!querymint || !quote) return;
    setError(""); setPending(true);
    try { setResult(await querymint.pay({ quote })); }
    catch (e) { setError(e instanceof Error ? e.message : "Payment failed"); }
    finally { setPending(false); }
  }

  const integration = `const querymint = createQueryMint({ apiUrl, settlementAddress, walletClient, publicClient });
const quote = await querymint.quote({ where: { category: "defi" }, limit: 20 });
console.table(quote.breakdown); // inspect publisher payouts before approval
const result = await querymint.pay({ quote });
console.log({ deliveredRecordCount: result.records.length, transactionHash: result.transactionHash });`;

  return <div className="demo-shell"><header className="demo-header"><a className="demo-brand" href="/">Q<span>.</span> QueryMint SDK</a><div className="demo-head-right"><span className="demo-network">WHITECHAIN SEPOLIA · 1874</span>{isConnected ? <span className="demo-address">{address?.slice(0, 6)}…{address?.slice(-4)}</span> : <button className="demo-connect" onClick={() => { const c = connectors[0]; if (c) connect({ connector: c }); }}>Connect wallet</button>}</div></header>
    <main className="demo-main"><div className="demo-eyebrow">THIRD-PARTY INTEGRATION EXAMPLE</div><h1>Data in one <em>query.</em></h1><p className="demo-intro">A compact buyer flow using the published QueryMint SDK. Quotes and records come from the configured coordinator API.</p>
      <div className="demo-columns"><section className="demo-card demo-query"><div className="demo-label">01 / QUERY</div><label>Category<input value={category} onChange={(event) => setCategory(event.target.value)} /></label><button disabled={!isConnected || !querymint || pending} onClick={() => void runQuery()}>{pending ? "Working…" : "Request quote →"}</button>{!apiUrl && <small>Set `VITE_COORDINATOR_API_URL` to the deployed coordinator.</small>}{!settlementAddress && <small>Set `VITE_QUERYMINT_SETTLEMENT_ADDRESS` to enable the SDK.</small>}</section>
      <section className="demo-card demo-code"><div className="demo-label">THE INTEGRATION · 5 CALLS</div><pre><code>{integration}</code></pre></section></div>
      {error && <div className="demo-alert">{error}</div>}
      {quote && <section className="demo-card demo-quote"><div className="demo-label">02 / REVIEW QUOTE</div><h2>{quote.eligibleRecords ?? quote.records.length} eligible records of {quote.totalMatchingRecords ?? quote.records.length} authorized matches</h2><p>Settlement limit: 10 dataset allocations and 50 records. This quote uses {quote.breakdown.length} allocations.</p><div className="demo-allocations">{quote.breakdown.map((allocation) => <div key={allocation.datasetId}><span>{allocation.publisher.slice(0, 6)}…{allocation.publisher.slice(-4)}<small>{allocation.recordCount} records · {formatUnits(BigInt(allocation.pricePerRecord), 6)} USDT / record</small></span><strong>{formatUnits(BigInt(allocation.payoutAmount), 6)} USDT</strong></div>)}</div><div className="demo-total"><span>Total · exact USDT approval</span><strong>{formatUnits(quote.manifest.totalAmount, 6)} USDT</strong></div><button disabled={pending || !!quote.publisherApprovalRequests?.length} onClick={() => void settle()}>{pending ? "Confirm in wallet…" : "Approve & settle"}</button>{quote.publisherApprovalRequests?.length ? <small>Publisher approval is required before settlement.</small> : null}</section>}
      {result && <section className="demo-card demo-result"><div className="demo-label">03 / SETTLED AND DELIVERED</div><h2>{result.records.length} licensed records released</h2><a href={`${whitechainSepolia.blockExplorers?.default.url ?? "https://explorer.testnet.whitechain.io"}/tx/${result.transactionHash}`} target="_blank" rel="noreferrer">Transaction {result.transactionHash.slice(0, 10)}… ↗</a><pre>{JSON.stringify(result.records, null, 2)}</pre></section>}
      <footer className="demo-footer">No sample transactions are shown. Query, settlement and delivery require a live coordinator and wallet.</footer>
    </main></div>;
}
