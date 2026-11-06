import { useEffect, useMemo, useState } from "react";
import { formatUnits, type Address } from "viem";
import { useAccount, useConnect, useDisconnect, usePublicClient, useReadContract, useSwitchChain, useWalletClient } from "wagmi";
import { createQueryMint, type QueryMintQuote } from "@querymint/sdk";
import { WHITECHAIN_USDT, whitechainSepolia } from "@querymint/shared";

const API = import.meta.env.VITE_COORDINATOR_API_URL || "http://localhost:3001";
const SETTLEMENT = import.meta.env.VITE_QUERYMINT_SETTLEMENT_ADDRESS as Address | undefined;
const explorer = whitechainSepolia.blockExplorers?.default.url ?? "https://explorer.testnet.whitechain.io";
const usdtBalanceAbi = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] }] as const;

interface Dataset {
  datasetId: `0x${string}`; publisher: Address; category: string; title: string; description: string;
  pricePerRecord: string; maxRecordsPerQuery: number; maxPayoutPerQuery: string; policyExpiresAt: string; coordinatorGrantExpiresAt: string;
}
interface Publisher { address: Address; displayName: string; payoutAddress: Address; entityKey: string }
interface Earnings { publisher: Address; totalAmount: string; settlements: Array<{ queryId: string; datasetId: string; amount: string; recordCount: number; transactionHash: string; blockNumber: string }> }
type View = "market" | "publisher";

function short(value?: string) { return value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "—"; }
function amount(value?: string | bigint) { return `${formatUnits(BigInt(value ?? 0), 6)} USDT`; }
function dateFromSeconds(value: string) { return new Date(Number(value) * 1000).toLocaleString(); }

export function App() {
  const { address, chainId, isConnected } = useAccount();
  const { connectors, connect, isPending: isConnecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const { data: walletClient } = useWalletClient({ chainId: whitechainSepolia.id });
  const publicClient = usePublicClient({ chainId: whitechainSepolia.id });
  const balance = useReadContract({ address: WHITECHAIN_USDT, abi: usdtBalanceAbi, functionName: "balanceOf", args: address ? [address] : undefined, chainId: whitechainSepolia.id, query: { enabled: !!address } });

  const [view, setView] = useState<View>("market");
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [publishers, setPublishers] = useState<Publisher[]>([]);
  const [earnings, setEarnings] = useState<Earnings | null>(null);
  const [category, setCategory] = useState("defi");
  const [limit, setLimit] = useState(20);
  const [quote, setQuote] = useState<QueryMintQuote | null>(null);
  const [delivered, setDelivered] = useState<{ records: unknown[]; transactionHash: string; blockNumber: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [paymentPending, setPaymentPending] = useState(false);
  const [approvalPending, setApprovalPending] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const sdk = useMemo(() => {
    if (!walletClient || !publicClient || !SETTLEMENT) return null;
    return createQueryMint({ apiUrl: API, settlementAddress: SETTLEMENT, walletClient, publicClient });
  }, [walletClient, publicClient]);

  async function loadMarketplace() {
    setLoading(true); setError("");
    try {
      const [datasetRes, publisherRes] = await Promise.all([fetch(`${API}/datasets`), fetch(`${API}/publishers`)]);
      if (!datasetRes.ok || !publisherRes.ok) throw new Error("Coordinator discovery is unavailable. Check that the API is running and configured.");
      const [datasetBody, publisherBody] = await Promise.all([datasetRes.json(), publisherRes.json()]);
      setDatasets(datasetBody.datasets ?? []); setPublishers(publisherBody.publishers ?? []);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load marketplace data"); }
    finally { setLoading(false); }
  }

  async function loadEarnings() {
    if (!address) return;
    try {
      const response = await fetch(`${API}/publishers/${address}/earnings`);
      if (!response.ok) throw new Error("Earnings are unavailable");
      setEarnings(await response.json());
    } catch { setEarnings(null); }
  }

  useEffect(() => { void loadMarketplace(); }, []);
  useEffect(() => { if (view === "publisher") void loadEarnings(); }, [view, address]);

  async function requestQuote() {
    if (!sdk) { setError("Connect a wallet on Whitechain Sepolia and configure the settlement address first."); return; }
    setLoading(true); setError(""); setNotice(""); setDelivered(null);
    try { setQuote(await sdk.quote({ where: { category }, limit })); }
    catch (e) { setError(e instanceof Error ? e.message : "Quote request failed"); }
    finally { setLoading(false); }
  }

  async function payForQuote() {
    if (!sdk || !quote || paymentPending) return;
    setPaymentPending(true); setError(""); setNotice("Check your wallet for exact USDT approval, then settlement confirmation.");
    try {
      const result = await sdk.pay({ quote });
      setDelivered({ records: result.records ?? [], transactionHash: result.transactionHash, blockNumber: result.receipt.blockNumber.toString() });
      setNotice("Settlement confirmed. Licensed data was released after receipt verification.");
      setQuote(null);
      if (view === "publisher") void loadEarnings();
    } catch (e) { setError(e instanceof Error ? e.message : "Payment failed"); }
    finally { setPaymentPending(false); }
  }

  async function approveHighValueAllocation(request: NonNullable<QueryMintQuote["publisherApprovalRequests"]>[number]) {
    if (!sdk || !walletClient?.account || !address || address.toLowerCase() !== request.publisher.toLowerCase()) {
      setError("Connect the dataset publisher wallet to sign this approval."); return;
    }
    setApprovalPending(request.datasetId); setError("");
    try {
      const message = { ...request.message,
        publisherNonce: BigInt(String(request.message.publisherNonce)), policyNonce: BigInt(String(request.message.policyNonce)),
        grantNonce: BigInt(String(request.message.grantNonce)), payoutAmount: BigInt(String(request.message.payoutAmount)),
        deadline: BigInt(String(request.message.deadline)),
      };
      const signature = await walletClient.signTypedData({ account: walletClient.account, domain: request.domain as any,
        types: request.types as any, primaryType: request.primaryType as any, message: message as any });
      await sdk.submitPublisherApproval({ quoteId: quote!.quoteId, datasetId: request.datasetId, signature });
      setQuote(await sdk.refreshQuote({ quote: quote! }));
      setNotice("Publisher approval verified. The quote is ready to refresh and settle.");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not submit publisher approval"); }
    finally { setApprovalPending(""); }
  }

  const mine = datasets.filter((dataset) => dataset.publisher.toLowerCase() === address?.toLowerCase());
  const publisherName = (wallet: string) => publishers.find((publisher) => publisher.address.toLowerCase() === wallet.toLowerCase())?.displayName ?? short(wallet);

  return <div className="shell">
    <aside className="rail">
      <div className="brand"><span className="brand-mark">Q</span><span>querymint<span className="brand-period">.</span></span></div>
      <div className="rail-label">WORKSPACE</div>
      <button className={`nav-item ${view === "market" ? "active" : ""}`} onClick={() => setView("market")}><span className="nav-icon">⌕</span>Data marketplace</button>
      <button className={`nav-item ${view === "publisher" ? "active" : ""}`} onClick={() => setView("publisher")}><span className="nav-icon">▦</span>Publisher console</button>
      <div className="rail-bottom"><span className="status-dot" />Whitechain Sepolia<span className="network-id">1874</span><a className="rail-explorer" href={explorer} target="_blank" rel="noreferrer">Explorer ↗</a></div>
    </aside>

    <main className="main">
      <header className="topbar"><div className="crumb">QUERYMINT <span>/</span> {view === "market" ? "MARKETPLACE" : "PUBLISHER"}</div>
        <div className="top-actions"><span className="network-pill"><i />Whitechain Sepolia</span>
          {isConnected ? <button className="wallet-button connected" onClick={() => disconnect()}><i />{short(address)} <span className="wallet-close">×</span></button>
            : <button className="wallet-button" disabled={isConnecting} onClick={() => { const connector = connectors[0]; if (connector) connect({ connector }); }}>{isConnecting ? "Connecting…" : "Connect wallet"}</button>}
        </div>
      </header>

      <section className="page-heading"><div><div className="eyebrow">PUBLISHER-OWNED DATA · SETTLED ON WHITECHAIN</div>
        <h1>{view === "market" ? <>Query the <em>market.</em></> : <>Your data, <em>your terms.</em></>}</h1>
        <p>{view === "market" ? "Find attributed datasets across publishers. Preview before you approve a payment." : "Manage your published datasets and track on-chain earnings."}</p></div>
        <div className="heading-meta"><span className="live-dot" />TESTNET <span>·</span> RABDI / WHITECHAIN</div></section>

      {error && <div className="alert alert-error"><span>!</span>{error}<button onClick={() => setError("")}>×</button></div>}
      {notice && <div className="alert alert-notice"><span>✓</span>{notice}<button onClick={() => setNotice("")}>×</button></div>}

      {view === "market" ? <>
        <div className="market-grid">
          <section className="panel query-panel">
            <div className="panel-kicker"><span className="step-number">01</span> QUERY BUILDER <span className="panel-rule" /></div>
            <div className="query-controls">
              <label>Indexed category<div className="input-wrap"><span className="input-prefix">#</span><input value={category} onChange={(event) => setCategory(event.target.value)} maxLength={64} placeholder="defi" /></div></label>
              <label>Result limit<div className="input-wrap"><span className="input-prefix">↗</span><select value={limit} onChange={(event) => setLimit(Number(event.target.value))}>{[5, 10, 20, 30, 50].map((n) => <option key={n} value={n}>{n} records</option>)}</select></div></label>
              <button className="primary-button query-button" disabled={loading || !isConnected || chainId !== whitechainSepolia.id} onClick={() => void requestQuote()}>{loading ? <><span className="spinner" /> Searching</> : <>Run query <span>→</span></>}</button>
            </div>
            {!isConnected && <div className="inline-hint">Connect your wallet to request a buyer-specific quote.</div>}
            {isConnected && chainId !== whitechainSepolia.id && <button className="inline-link" disabled={isSwitching} onClick={() => switchChain({ chainId: whitechainSepolia.id })}>{isSwitching ? "Switching network…" : "Switch wallet to Whitechain Sepolia →"}</button>}
            {!SETTLEMENT && <div className="inline-hint warning">Configure `VITE_QUERYMINT_SETTLEMENT_ADDRESS` in `.env` to enable quote payment.</div>}
          </section>

          <section className="panel balance-panel"><div className="panel-kicker">BUYER WALLET <span className="panel-rule" /></div>
            <div className="balance-amount">{isConnected && balance.data !== undefined ? formatUnits(balance.data, 6) : "—"}<span> USDT</span></div>
            <div className="balance-footer"><span>Available on Whitechain Sepolia</span><a href={`${explorer}/address/${WHITECHAIN_USDT}`} target="_blank" rel="noreferrer">USDT contract ↗</a></div>
          </section>
        </div>

        {quote && <section className="panel quote-panel">
          <div className="panel-kicker"><span className="step-number">02</span> QUOTE PREVIEW <span className="panel-rule" /><span className="signed-tag"><i /> SIGNED MANIFEST</span></div>
          <div className="quote-summary"><div><span className="muted-label">QUERY ID</span><code>{short(quote.quoteId)}</code></div><div><span className="muted-label">MATCHED RECORDS</span><strong>{quote.records.length}</strong></div><div><span className="muted-label">EXPIRES</span><strong>{dateFromSeconds(quote.manifest.deadline.toString())}</strong></div></div>
          {quote.publisherApprovalRequests?.length ? <div className="approval-warning"><div><strong>Publisher approval required</strong><span>Each threshold-triggered allocation needs a signature from its publisher wallet.</span></div>{quote.publisherApprovalRequests.map((request) => <button key={request.datasetId} disabled={!!approvalPending || !isConnected || address?.toLowerCase() !== request.publisher.toLowerCase()} onClick={() => void approveHighValueAllocation(request)}>{approvalPending === request.datasetId ? "Waiting for signature…" : `Sign for ${short(request.datasetId)}`}</button>)}</div> : null}
          <div className="allocation-table"><div className="table-head"><span>PUBLISHER / DATASET</span><span>RECORDS</span><span>PRICE / RECORD</span><span>PAYOUT</span></div>
            {quote.breakdown.map((row) => <div className="table-row" key={row.datasetId}><div className="publisher-cell"><span className="publisher-avatar">{publisherName(row.publisher).slice(0, 1).toUpperCase()}</span><div><strong>{publisherName(row.publisher)}</strong><small>{short(row.datasetId)}</small></div></div><span>{row.recordCount}</span><span>{amount(row.pricePerRecord)}</span><strong>{amount(row.payoutAmount)}</strong></div>)}
          </div>
          <div className="quote-bottom"><div className="preview-list"><span className="muted-label">PREVIEW</span>{quote.records.slice(0, 4).map((record, index) => <div className="preview-row" key={`${record.recordHash}-${index}`}><span className="preview-index">{String(index + 1).padStart(2, "0")}</span><span>{record.preview}</span><code>{short(record.recordHash)}</code></div>)}</div>
            <div className="pay-card"><span className="muted-label">TOTAL TO SETTLE</span><strong className="total-amount">{amount(quote.manifest.totalAmount)}</strong><small>Exact approval · paid directly to publishers</small><button className="primary-button" disabled={paymentPending || !isConnected || chainId !== whitechainSepolia.id || !!quote.publisherApprovalRequests?.length} onClick={() => void payForQuote()}>{paymentPending ? <><span className="spinner" /> Confirm in wallet</> : <>Approve & settle <span>→</span></>}</button></div>
          </div>
        </section>}

        {delivered && <section className="panel delivered-panel"><div className="panel-kicker"><span className="success-mark">✓</span> SETTLEMENT CONFIRMED <span className="panel-rule" /></div><div className="receipt-grid"><div><span className="muted-label">TRANSACTION</span><a href={`${explorer}/tx/${delivered.transactionHash}`} target="_blank" rel="noreferrer">{short(delivered.transactionHash)} ↗</a></div><div><span className="muted-label">BLOCK</span><strong>{delivered.blockNumber}</strong></div><div><span className="muted-label">LICENSED RECORDS</span><strong>{delivered.records.length}</strong></div></div><pre className="payload-view">{JSON.stringify(delivered.records, null, 2)}</pre></section>}

        <section className="section-block"><div className="section-title"><div><span className="eyebrow">DISCOVER</span><h2>Available datasets</h2></div><button className="text-button" onClick={() => void loadMarketplace()}>Refresh ↻</button></div>
          {loading && !datasets.length ? <div className="empty-state"><span className="spinner dark" /> Loading coordinator data…</div> : datasets.length ? <div className="dataset-grid">{datasets.map((dataset) => <article className="dataset-card" key={dataset.datasetId}><div className="dataset-top"><span className="category-tag">{dataset.category}</span><span className="active-tag"><i /> AUTHORIZED</span></div><h3>{dataset.title}</h3><p>{dataset.description}</p><div className="dataset-stats"><div><span>PRICE / RECORD</span><strong>{amount(dataset.pricePerRecord)}</strong></div><div><span>QUERY CAP</span><strong>{dataset.maxRecordsPerQuery} records</strong></div></div><div className="dataset-foot"><span>BY {publisherName(dataset.publisher).toUpperCase()}</span><button onClick={() => { setCategory(dataset.category); window.scrollTo({ top: 0, behavior: "smooth" }); }}>Query category ↗</button></div></article>)}</div> : <div className="empty-state">{error ? "Marketplace data could not be loaded." : "No active coordinator-authorized datasets returned by the API."}</div>}
        </section>
        <section className="section-block publisher-directory"><div className="section-title"><div><span className="eyebrow">ATTRIBUTION</span><h2>Verified publishers</h2></div><span className="small-count">{publishers.length} REGISTERED</span></div>
          {publishers.length ? <div className="directory-grid">{publishers.map((publisher) => <article key={publisher.address}><span className="publisher-avatar">{publisher.displayName.slice(0, 1).toUpperCase()}</span><div><strong>{publisher.displayName}</strong><small>{short(publisher.address)} · Whitechain registered</small></div><a href={`${explorer}/address/${publisher.address}`} target="_blank" rel="noreferrer">Profile ↗</a></article>)}</div> : <div className="empty-state">Publisher profiles are returned by the coordinator when available.</div>}
        </section>
      </> : <>
        <div className="publisher-stats"><section className="panel stat-card"><span className="muted-label">CONNECTED PUBLISHER</span><strong>{address ? short(address) : "Wallet not connected"}</strong><small>{address ? "Whitechain Sepolia" : "Connect to view your data"}</small></section><section className="panel stat-card"><span className="muted-label">ACTIVE DATASETS</span><strong>{address ? mine.length : "—"}</strong><small>Authorized for this coordinator</small></section><section className="panel stat-card"><span className="muted-label">TOTAL EARNINGS</span><strong>{earnings ? amount(earnings.totalAmount) : "—"}</strong><small>From AllocationPaid events</small></section></div>
        <section className="panel publisher-panel"><div className="panel-kicker">YOUR DATASETS <span className="panel-rule" /><span className="small-count">{mine.length} ACTIVE</span></div>{!address ? <div className="empty-state">Connect the publisher wallet to see matching datasets.</div> : mine.length ? <div className="publisher-dataset-list">{mine.map((dataset) => <div className="publisher-dataset" key={dataset.datasetId}><div><span className="category-tag">{dataset.category}</span><h3>{dataset.title}</h3><code>{dataset.datasetId}</code></div><div className="publisher-dataset-meta"><span>Price <strong>{amount(dataset.pricePerRecord)}</strong></span><span>Max/query <strong>{dataset.maxRecordsPerQuery}</strong></span></div><div className="authorization-state"><i /> Coordinator active<small>Until {dateFromSeconds(dataset.coordinatorGrantExpiresAt)}</small></div></div>)}</div> : <div className="empty-state">No active datasets owned by this wallet are currently registered with this coordinator.</div>}</section>
        <section className="panel publisher-panel"><div className="panel-kicker">SETTLEMENT HISTORY <span className="panel-rule" /><span className="small-count">ON-CHAIN EVENTS</span></div>{earnings?.settlements.length ? <div className="allocation-table"><div className="table-head"><span>QUERY / DATASET</span><span>RECORDS</span><span>BLOCK</span><span>EARNED</span></div>{earnings.settlements.map((row) => <div className="table-row" key={`${row.transactionHash}-${row.datasetId}`}><div className="publisher-cell"><span className="publisher-avatar">↗</span><div><a href={`${explorer}/tx/${row.transactionHash}`} target="_blank" rel="noreferrer">{short(row.queryId)}</a><small>{short(row.datasetId)}</small></div></div><span>{row.recordCount}</span><span>{row.blockNumber}</span><strong>{amount(row.amount)}</strong></div>)}</div> : <div className="empty-state">No settlement events returned for this wallet.</div>}</section>
        <div className="publisher-note"><span>i</span><p>Dataset registration, Arkiv uploads and authorization updates require publisher wallet transactions. This dashboard only displays data returned by the coordinator and does not fabricate upload or earnings activity.</p></div>
      </>}

      <footer className="footer"><span>QUERYMINT <i>·</i> PUBLISHER-OWNED DATA</span><span>WHITECHAIN SEPOLIA <i>·</i> ARKIV RABDI</span></footer>
    </main>
  </div>;
}
