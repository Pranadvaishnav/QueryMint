import { useEffect, useMemo, useState } from "react";
import { custom, formatUnits, isAddress, keccak256, toBytes, type Address } from "viem";
import { createWalletClient as createArkivWalletClient, ExpirationTime, type ExecuteBatchReturnType } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { getWalletClient, switchChain as switchWalletChain } from "wagmi/actions";
import { config } from "./wagmi";
import { buildPublisherCreateOperations, canResumeWhitechainSetup, hasConfirmedPublisherBatch, publishAndPersistPublisherBatch, PublisherBatchResultError, type EncryptedPublisherRecord } from "./publisherArkiv";
import { useAccount, useConnect, useDisconnect, usePublicClient, useReadContract, useSwitchChain, useWalletClient } from "wagmi";
import { createQueryMint, type DeliveryStep, type PaymentStep, type QueryMintQuote } from "@querymint/sdk";
import { WHITECHAIN_USDT, whitechainSepolia } from "@querymint/shared";
import { discoveryView, type DiscoveryStatus } from "./discoveryState";
import { previewRecordCount } from "./buyerDisplay";
import { isValidDeliveryTransactionHash } from "./deliveryRecovery";
import { formatPublisherReference, loadPublisherReferences, savePublisherReferences as persistPublisherReferences, type PublisherReference, type PublisherSetup, type StoredPublisherReferences } from "./publisherReferences";

const API = (import.meta.env.VITE_COORDINATOR_API_URL || (import.meta.env.DEV ? "http://localhost:3001" : "")).replace(/\/+$/, "");
const SETTLEMENT = import.meta.env.VITE_QUERYMINT_SETTLEMENT_ADDRESS as Address | undefined;
const explorer = whitechainSepolia.blockExplorers?.default.url ?? "https://explorer.testnet.whitechain.io";
const usdtBalanceAbi = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] }] as const;
const publisherWriteAbi = [
  { type: "function", name: "registerPublisher", stateMutability: "nonpayable", inputs: [{ name: "payout", type: "address" }], outputs: [] },
  { type: "function", name: "updatePublisherPayout", stateMutability: "nonpayable", inputs: [{ name: "payout", type: "address" }], outputs: [] },
  { type: "function", name: "registerDataset", stateMutability: "nonpayable", inputs: [{ name: "datasetId", type: "bytes32" }, { name: "pricePerRecord", type: "uint128" }, { name: "maxRecordsPerQuery", type: "uint32" }, { name: "maxPayoutPerQuery", type: "uint128" }, { name: "publisherSignatureThreshold", type: "uint128" }, { name: "expiresAt", type: "uint64" }], outputs: [] },
  { type: "function", name: "authorizeCoordinator", stateMutability: "nonpayable", inputs: [{ name: "datasetId", type: "bytes32" }, { name: "coordinator", type: "address" }, { name: "expiresAt", type: "uint64" }], outputs: [] },
  { type: "function", name: "revokeCoordinator", stateMutability: "nonpayable", inputs: [{ name: "datasetId", type: "bytes32" }, { name: "coordinator", type: "address" }], outputs: [] },
  { type: "function", name: "updateDatasetPolicy", stateMutability: "nonpayable", inputs: [{ name: "datasetId", type: "bytes32" }, { name: "pricePerRecord", type: "uint128" }, { name: "maxRecordsPerQuery", type: "uint32" }, { name: "maxPayoutPerQuery", type: "uint128" }, { name: "publisherSignatureThreshold", type: "uint128" }, { name: "expiresAt", type: "uint64" }], outputs: [] },
  { type: "function", name: "publishers", stateMutability: "view", inputs: [{ name: "publisher", type: "address" }], outputs: [{ name: "payout", type: "address" }, { name: "nonce", type: "uint64" }, { name: "registered", type: "bool" }] },
  { type: "function", name: "datasetPublisher", stateMutability: "view", inputs: [{ name: "datasetId", type: "bytes32" }], outputs: [{ type: "address" }] },
  { type: "function", name: "datasetPolicies", stateMutability: "view", inputs: [{ name: "datasetId", type: "bytes32" }], outputs: [{ type: "uint128" }, { type: "uint128" }, { type: "uint128" }, { type: "uint32" }, { type: "uint64" }, { type: "uint64" }, { type: "bool" }] },
  { type: "function", name: "coordinatorGrants", stateMutability: "view", inputs: [{ name: "datasetId", type: "bytes32" }, { name: "coordinator", type: "address" }], outputs: [{ type: "uint64" }, { type: "uint64" }, { type: "bool" }] },
] as const;

interface Dataset {
  datasetId: `0x${string}`; publisher: Address; category: string; title: string; description: string;
  pricePerRecord: string; maxRecordsPerQuery: number; maxPayoutPerQuery: string; policyExpiresAt: string; coordinatorGrantExpiresAt: string;
}
interface Publisher { address: Address; displayName: string; payoutAddress: Address; entityKey: string }
interface Earnings { publisher: Address; totalAmount: string; settlements: Array<{ queryId: string; datasetId: string; amount: string; recordCount: number; transactionHash: string; blockNumber: string }> }
type View = "market" | "publisher";
type OnboardingStage = "prepare" | "arkiv" | "publisher" | "policy" | "grant";
type OnboardingStatus = "pending" | "submitted" | "confirmed" | "failed" | "skipped" | "revoked" | "reconciliation required";
interface OnboardingProgress { stage: OnboardingStage; status: OnboardingStatus; network: string; transactionHash?: string; detail?: string }
const ONBOARDING_STAGES: Array<{ id: OnboardingStage; title: string; network: string }> = [
  { id: "prepare", title: "Prepare encrypted data", network: "Coordinator API · Rabdi data preparation" },
  { id: "arkiv", title: "Submit Arkiv batch", network: "Arkiv Rabdi · 7794095" },
  { id: "publisher", title: "Register publisher if necessary", network: "Whitechain Sepolia · 1874" },
  { id: "policy", title: "Register dataset policy", network: "Whitechain Sepolia · 1874" },
  { id: "grant", title: "Authorize coordinator", network: "Whitechain Sepolia · 1874" },
];

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
  const [discoveryStatus, setDiscoveryStatus] = useState<DiscoveryStatus>("loading");
  const [discoveryError, setDiscoveryError] = useState("");
  const [earnings, setEarnings] = useState<Earnings | null>(null);
  const [category, setCategory] = useState("defi");
  const [limit, setLimit] = useState(20);
  const [quote, setQuote] = useState<QueryMintQuote | null>(null);
  const [delivered, setDelivered] = useState<{ records: unknown[]; transactionHash: string; blockNumber: string } | null>(null);
  const [pendingDelivery, setPendingDelivery] = useState<string | null>(null);
  const [deliveryHashInput, setDeliveryHashInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [paymentPending, setPaymentPending] = useState(false);
  const [paymentSteps, setPaymentSteps] = useState<Partial<Record<PaymentStep["stage"], PaymentStep>>>({});
  const [deliveryStep, setDeliveryStep] = useState<DeliveryStep | null>(null);
  const [approvalPending, setApprovalPending] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [publisherNameInput, setPublisherNameInput] = useState("");
  const [payoutAddressInput, setPayoutAddressInput] = useState("");
  const [datasetTitle, setDatasetTitle] = useState("");
  const [datasetCategory, setDatasetCategory] = useState("defi");
  const [datasetPrice, setDatasetPrice] = useState("1000000");
  const [datasetMaxRecords, setDatasetMaxRecords] = useState("20");
  const [datasetMaxPayout, setDatasetMaxPayout] = useState("20000000");
  const [signatureThreshold, setSignatureThreshold] = useState("0");
  const [datasetExpiry, setDatasetExpiry] = useState("30");
  const [coordinatorExpiry, setCoordinatorExpiry] = useState("7");
  const [recordJson, setRecordJson] = useState('[{"label":"Sample observation","preview":"Sample preview","payload":{"sampleType":"publisher supplied","value":42}}]');
  const [publisherBundles, setPublisherBundles] = useState<StoredPublisherReferences[]>([]);
  const [selectedDatasetId, setSelectedDatasetId] = useState<`0x${string}` | "">("");
  const [onboardingProgress, setOnboardingProgress] = useState<Record<string, Partial<Record<OnboardingStage, OnboardingProgress>>>>({});
  const [referencePersistenceWarning, setReferencePersistenceWarning] = useState("");
  const [writeBusy, setWriteBusy] = useState(false);

  const sdk = useMemo(() => {
    if (!walletClient || !publicClient || !SETTLEMENT || !API) return null;
    return createQueryMint({ apiUrl: API, settlementAddress: SETTLEMENT, walletClient, publicClient,
      onPaymentStep: (step) => setPaymentSteps((current) => {
        const previous = current[step.stage];
        return { ...current, [step.stage]: { ...step, transactionHash: step.transactionHash ?? previous?.transactionHash,
          ...(step.stage === "approval" && step.status === "skipped" && previous?.status === "confirmed" ? { status: "confirmed" as const, message: "Previously confirmed exact approval remains sufficient." } : {}) } };
      }),
      onDeliveryStep: setDeliveryStep,
      onSettlementConfirmed: (hash) => { if (address) { setDeliveryHashInput(hash); try { localStorage.setItem(`querymint:pending-delivery:${address.toLowerCase()}`, hash); setPendingDelivery(hash); } catch { setPendingDelivery(hash); } } } });
  }, [walletClient, publicClient, address]);

  async function loadMarketplace() {
    setDiscoveryStatus("loading"); setDiscoveryError("");
    try {
      if (!API) throw new Error("Marketplace API is not configured. Set VITE_COORDINATOR_API_URL for this deployment.");
      const requestOptions = { signal: AbortSignal.timeout(20_000) };
      const [datasetRes, publisherRes] = await Promise.all([fetch(`${API}/datasets`, requestOptions), fetch(`${API}/publishers`, requestOptions)]);
      for (const failed of [datasetRes, publisherRes]) if (!failed.ok) {
        let message = `Coordinator or Arkiv discovery is unavailable (${failed.status}).`;
        try { const body = await failed.json() as { error?: unknown }; if (typeof body.error === "string") message = body.error; } catch { /* Keep the HTTP status fallback. */ }
        throw new Error(message);
      }
      const [datasetBody, publisherBody] = await Promise.all([datasetRes.json(), publisherRes.json()]);
      if (!Array.isArray(datasetBody.datasets) || !Array.isArray(publisherBody.publishers)) throw new Error("Coordinator returned an invalid discovery response.");
      setDatasets(datasetBody.datasets); setPublishers(publisherBody.publishers); setDiscoveryStatus("success");
    } catch (e) {
      setDiscoveryError(e instanceof Error && e.name === "TimeoutError"
        ? "Coordinator or Arkiv discovery timed out. Retry when the indexer is available."
        : e instanceof Error ? e.message : "Coordinator or Arkiv discovery failed. Retry shortly.");
      setDiscoveryStatus("error");
    }
  }

  function savePublisherBundle(owner: Address, bundle: StoredPublisherReferences) {
    setPublisherBundles((current) => {
      const index = current.findIndex((item) => item.datasetId.toLowerCase() === bundle.datasetId.toLowerCase());
      if (index < 0) return [...current, bundle];
      return current.map((item, itemIndex) => itemIndex === index ? bundle : item);
    });
    setSelectedDatasetId(bundle.datasetId);
    setReferencePersistenceWarning(persistPublisherReferences(owner, bundle)
      ? ""
      : "Confirmed references remain visible for this session but could not be saved in this browser.");
  }

  function setOnboardingStep(datasetId: string, stage: OnboardingStage, status: OnboardingStatus, network: string, extra: Pick<OnboardingProgress, "transactionHash" | "detail"> = {}) {
    setOnboardingProgress((current) => ({
      ...current,
      [datasetId.toLowerCase()]: { ...current[datasetId.toLowerCase()], [stage]: { stage, status, network, ...extra } },
    }));
  }

  async function loadEarnings() {
    if (!address || !API) return;
    try {
      const response = await fetch(`${API}/publishers/${address}/earnings`);
      if (!response.ok) throw new Error("Earnings are unavailable");
      setEarnings(await response.json());
    } catch { setEarnings(null); }
  }

  useEffect(() => { void loadMarketplace(); }, []);
  useEffect(() => {
    if (!address) {
      setPublisherBundles([]);
      setSelectedDatasetId("");
      return;
    }
    const saved = loadPublisherReferences(address);
    setPublisherBundles(saved);
    setSelectedDatasetId(saved.at(-1)?.datasetId ?? "");
    setReferencePersistenceWarning("");
  }, [address]);
  useEffect(() => { if (view === "publisher") void loadEarnings(); }, [view, address]);
  useEffect(() => {
    if (!address) { setPendingDelivery(null); return; }
    try { const saved = localStorage.getItem(`querymint:pending-delivery:${address.toLowerCase()}`); setPendingDelivery(saved); setDeliveryHashInput(saved ?? ""); } catch { setPendingDelivery(null); setDeliveryHashInput(""); }
  }, [address]);

  async function requestQuote() {
    if (!sdk) { setError("Connect a wallet on Whitechain Sepolia and configure the settlement address first."); return; }
    setLoading(true); setError(""); setNotice(""); setDelivered(null); setPaymentSteps({}); setDeliveryStep(null);
    try { setQuote(await sdk.quote({ where: { category }, limit })); }
    catch (e) { setError(e instanceof Error ? e.message : "Quote request failed"); }
    finally { setLoading(false); }
  }

  async function payForQuote() {
    if (!sdk || !quote || paymentPending) return;
    setPaymentPending(true); setError(""); setNotice(""); setDeliveryStep(null);
    try {
      const result = await sdk.pay({ quote });
      setDelivered({ records: result.records ?? [], transactionHash: result.transactionHash, blockNumber: result.receipt.blockNumber.toString() });
      if (address) { try { localStorage.removeItem(`querymint:pending-delivery:${address.toLowerCase()}`); } catch { /* Ignore storage restrictions. */ } }
      setPendingDelivery(null);
      setDeliveryHashInput("");
      setNotice("Settlement confirmed. Licensed data was released after receipt verification.");
      setQuote(null);
      if (view === "publisher") void loadEarnings();
    } catch (e) { setError(e instanceof Error ? e.message : "Payment failed. Review the payment stages before retrying."); }
    finally { setPaymentPending(false); }
  }

  async function retryDelivery() {
    const transactionHash = deliveryHashInput.trim() as `0x${string}`;
    if (!sdk || !transactionHash || paymentPending || !isValidDeliveryTransactionHash(transactionHash)) { if (transactionHash) setError("Enter a valid 32-byte settlement transaction hash."); return; }
    setPaymentPending(true); setError(""); setDeliveryStep({ status: "pending", message: "Checking the confirmed settlement before requesting your buyer signature." });
    try {
      if (address) { setPendingDelivery(transactionHash); try { localStorage.setItem(`querymint:pending-delivery:${address.toLowerCase()}`, transactionHash); } catch { /* Session retry remains active. */ } }
      const result = await sdk.deliver({ transactionHash });
      setDelivered({ records: result.records ?? [], transactionHash: result.transactionHash, blockNumber: result.receipt.blockNumber.toString() });
      if (address) { try { localStorage.removeItem(`querymint:pending-delivery:${address.toLowerCase()}`); } catch { /* Ignore storage restrictions. */ } }
      setPendingDelivery(null); setDeliveryHashInput(""); setNotice("Settlement verified. Licensed data was released.");
    } catch (e) { setError(e instanceof Error ? e.message : "Data delivery retry failed"); }
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

  async function publishDataset() {
    if (!address || !isConnected || !SETTLEMENT || !walletClient || !publicClient || writeBusy) return;
    setWriteBusy(true); setError(""); setNotice("");
    let datasetId: `0x${string}` | undefined;
    let activeStage: OnboardingStage = "prepare";
    let bundle: StoredPublisherReferences | undefined;
    let batchSubmissionStarted = false;
    try {
      if (chainId !== whitechainSepolia.id) throw new Error("Switch to Whitechain Sepolia before starting the publisher write flow.");
      const records = JSON.parse(recordJson) as Array<{ label: string; preview: string; payload: Record<string, unknown> }>;
      if (!Array.isArray(records) || !records.length || records.length > 50 || records.some((r) => !r.label || !r.preview || !r.payload || typeof r.payload !== "object")) throw new Error("Enter 1–50 records with label, preview, and payload fields.");
      if (Number(datasetMaxRecords) < 1 || Number(datasetMaxRecords) > 50) throw new Error("Maximum records per query must be between 1 and 50.");
      const coordinator = import.meta.env.VITE_COORDINATOR_ADDRESS as Address | undefined;
      if (!coordinator) throw new Error("Set VITE_COORDINATOR_ADDRESS to the coordinator wallet before publishing.");
      const payoutAddress = (payoutAddressInput.trim() || address) as Address;
      if (!isAddress(payoutAddress)) throw new Error("Enter a valid publisher payout address.");
      const now = Math.floor(Date.now() / 1000);
      datasetId = keccak256(toBytes(`${address.toLowerCase()}:querymint:${crypto.randomUUID()}`));
      const expiresAt = BigInt(now + Number(datasetExpiry) * 86_400);
      const setup: PublisherSetup = {
        publisher: address, payoutAddress, coordinator, title: datasetTitle.trim(), category: datasetCategory.trim(),
        pricePerRecord: datasetPrice, maxRecordsPerQuery: Number(datasetMaxRecords), maxPayoutPerQuery: datasetMaxPayout,
        publisherSignatureThreshold: signatureThreshold, datasetExpiresAt: expiresAt.toString(),
        coordinatorGrantExpiresAt: BigInt(Math.min(Number(expiresAt), now + Number(coordinatorExpiry) * 86_400)).toString(),
      };
      bundle = { datasetId, references: [], setup };
      setSelectedDatasetId(datasetId);
      setReferencePersistenceWarning("");
      setOnboardingStep(datasetId, "prepare", "pending", "Coordinator API · Rabdi data preparation");
      const arkivChain = rabdi({ accessKey: "" });

      await switchWalletChain(config, { chainId: arkivChain.id });
      const arkivWallet = await getWalletClient(config, { chainId: arkivChain.id });
      if (!arkivWallet.account) throw new Error("Reconnect your wallet on Arkiv Rabdi to sign entity writes.");
      const arkiv = createArkivWalletClient({ account: arkivWallet.account, chain: arkivChain, transport: custom((window as any).ethereum) });
      const retention = ExpirationTime.fromDays(30);
      setOnboardingStep(datasetId, "prepare", "pending", "Arkiv Rabdi · 7794095", { detail: `Encrypting ${records.length} records before any Arkiv write.` });
      const encryptedRecords = await Promise.all(records.map(async (record) => {
        const encryptedResponse = await fetch(`${API}/publisher/encrypt-record`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ payload: record.payload }) });
        if (!encryptedResponse.ok) throw new Error(`Coordinator encryption service failed (${encryptedResponse.status}).`);
        const encrypted = await encryptedResponse.json() as { encryptedPayload: `0x${string}`; contentHash: `0x${string}`; payloadHash: `0x${string}` };
        return { label: record.label, preview: record.preview, contentHash: encrypted.contentHash, payloadHash: encrypted.payloadHash, encryptedPayload: encrypted.encryptedPayload } satisfies EncryptedPublisherRecord;
      }));
      setOnboardingStep(datasetId, "prepare", "confirmed", "Coordinator API · Rabdi data preparation", { detail: `${encryptedRecords.length} payloads encrypted in memory.` });

      activeStage = "arkiv";
      setOnboardingStep(datasetId, "arkiv", "pending", "Arkiv Rabdi · 7794095", { detail: "One atomic batch: profile, manifest, and every record." });
      const creates = buildPublisherCreateOperations({
        owner: address, payoutAddress, displayName: publisherNameInput.trim() || `Publisher ${short(address)}`,
        datasetId, category: setup.category, title: setup.title, pricePerRecord: BigInt(setup.pricePerRecord),
        maxRecordsPerQuery: setup.maxRecordsPerQuery, records: encryptedRecords, expiration: retention,
      });
      batchSubmissionStarted = true;
      await publishAndPersistPublisherBatch(
        () => arkiv.executeBatch({ creates }) as Promise<ExecuteBatchReturnType>,
        encryptedRecords.length,
        (batch) => {
          bundle = { ...bundle!, references: batch.references };
          savePublisherBundle(address, bundle);
          setOnboardingStep(datasetId!, "arkiv", "confirmed", "Arkiv Rabdi · 7794095", { transactionHash: batch.transactionHash, detail: `${batch.references.length - 1} entity keys mapped in create order.` });
        },
      );
      setNotice(`Arkiv batch confirmed. Continue Whitechain setup for dataset ${datasetId}.`);

      activeStage = "publisher";
      setOnboardingStep(datasetId, "publisher", "pending", "Whitechain Sepolia · 1874");
      await completeWhitechainSetup(bundle);
      await loadMarketplace();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Publisher onboarding failed";
      const transactionHash = e && typeof e === "object" && "txHash" in e && typeof e.txHash === "string" ? e.txHash :
        e instanceof PublisherBatchResultError ? e.transactionHash : undefined;
      const knownRevert = e instanceof Error && /reverted|ran out of gas/i.test(e.message);
      const definiteNoSubmission = e instanceof Error && /user rejected|user denied|request rejected|cancelled by user|estimate.*gas|gas estimation/i.test(e.message);
      if (bundle && batchSubmissionStarted && !hasConfirmedPublisherBatch(bundle.references) && !knownRevert && !definiteNoSubmission) {
        bundle = { ...bundle, references: [{ kind: "Arkiv batch", ...(transactionHash ? { transactionHash } : {}), status: "reconciliation required" }] };
        savePublisherBundle(address!, bundle);
        activeStage = "arkiv";
        setOnboardingStep(datasetId!, "arkiv", "reconciliation required", "Arkiv Rabdi · 7794095", { ...(transactionHash ? { transactionHash } : {}), detail: "The batch result is incomplete or unknown. Do not submit it again until Rabdi wallet activity is checked." });
      } else if (datasetId && !bundle?.references.some((reference) => reference.kind === "Arkiv batch" && !reference.status)) {
        const network = activeStage === "prepare" ? "Arkiv Rabdi · 7794095" : "Coordinator API · Rabdi data preparation";
        setOnboardingStep(datasetId, activeStage, "failed", network, { ...(transactionHash ? { transactionHash } : {}), detail: message });
      }
      setError(message);
    } finally { setWriteBusy(false); }
  }

  async function completeWhitechainSetup(inputBundle: StoredPublisherReferences) {
    if (!address || !SETTLEMENT || !walletClient || !publicClient || !inputBundle.setup) throw new Error("This dataset has no resumable Whitechain setup details.");
    const setup = inputBundle.setup;
    if (setup.publisher.toLowerCase() !== address.toLowerCase()) throw new Error("Reconnect the wallet that owns this dataset before resuming setup.");
    const configuredCoordinator = import.meta.env.VITE_COORDINATOR_ADDRESS as Address | undefined;
    if (!configuredCoordinator || setup.coordinator.toLowerCase() !== configuredCoordinator.toLowerCase()) throw new Error("The saved coordinator does not match the currently configured coordinator. Review the setup before authorizing access.");
    if (!hasConfirmedPublisherBatch(inputBundle.references)) throw new Error("A confirmed Arkiv batch is required before Whitechain setup can resume.");
    const datasetId = inputBundle.datasetId;
    const whitechainNetwork = "Whitechain Sepolia · 1874";
    let activeStage: OnboardingStage = "publisher";
    let activeTransactionHash: string | undefined;

    let bundle = inputBundle;
    const remember = (reference: PublisherReference) => {
      const replacedKinds = reference.kind === "Coordinator grant" ? ["Coordinator grant", "Coordinator revocation"] : [reference.kind];
      const nextReferences = [...bundle!.references.filter((item) => !replacedKinds.includes(item.kind)), reference];
      bundle = { ...bundle!, references: nextReferences };
      savePublisherBundle(address!, bundle!);
    };
    const sendAndWait = async (stage: OnboardingStage, functionName: "registerPublisher" | "updatePublisherPayout" | "registerDataset" | "authorizeCoordinator" | "updateDatasetPolicy" | "revokeCoordinator", args: readonly unknown[], kind: PublisherReference["kind"]) => {
      const hash = await walletClient.writeContract({ address: SETTLEMENT, abi: publisherWriteAbi, functionName: functionName as any, args: args as any });
      activeTransactionHash = hash;
      remember({ kind, transactionHash: hash, status: "submitted" });
      setOnboardingStep(datasetId, stage, "submitted", whitechainNetwork, { transactionHash: hash, detail: "Submitted; waiting for the Whitechain receipt." });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        remember({ kind, transactionHash: hash, status: "failed" });
        throw new Error(`${functionName} transaction reverted: ${hash}`);
      }
      remember({ kind, transactionHash: hash });
      setOnboardingStep(datasetId, stage, "confirmed", whitechainNetwork, { transactionHash: hash });
    };
    const resolvePending = async (kind: PublisherReference["kind"], stage: OnboardingStage) => {
      const pending = bundle.references.find((reference) => reference.kind === kind && reference.status === "submitted" && reference.transactionHash);
      if (!pending?.transactionHash) return;
      activeTransactionHash = pending.transactionHash;
      setOnboardingStep(datasetId, stage, "submitted", whitechainNetwork, { transactionHash: pending.transactionHash, detail: "Checking the previously submitted transaction before retrying." });
      let receipt;
      try { receipt = await publicClient.getTransactionReceipt({ hash: pending.transactionHash as `0x${string}` }); }
      catch {
        throw new Error(`Transaction ${pending.transactionHash} is not confirmed yet. Wait for it to settle, then resume setup; it will not be resubmitted.`);
      }
      if (receipt.status === "success") {
        remember({ kind, transactionHash: pending.transactionHash });
        setOnboardingStep(datasetId, stage, "confirmed", whitechainNetwork, { transactionHash: pending.transactionHash });
      } else {
        remember({ kind, transactionHash: pending.transactionHash, status: "failed" });
        setOnboardingStep(datasetId, stage, "failed", whitechainNetwork, { transactionHash: pending.transactionHash, detail: "The previous transaction reverted; setup can retry this step." });
      }
    };

    try {
    await switchWalletChain(config, { chainId: whitechainSepolia.id });
    setOnboardingStep(datasetId, "publisher", "pending", whitechainNetwork);
    await resolvePending("Publisher registration", "publisher");
    await resolvePending("Publisher payout update", "publisher");
    const publisherState = await publicClient.readContract({ address: SETTLEMENT, abi: publisherWriteAbi, functionName: "publishers", args: [address] });
    if (!publisherState[2]) {
      await sendAndWait("publisher", "registerPublisher", [setup.payoutAddress], "Publisher registration");
    } else if (publisherState[0].toLowerCase() !== setup.payoutAddress.toLowerCase()) {
      await sendAndWait("publisher", "updatePublisherPayout", [setup.payoutAddress], "Publisher payout update");
    } else {
      const savedPublisherReference = bundle.references.find((reference) => reference.kind === "Publisher registration" || reference.kind === "Publisher payout update");
      if (!savedPublisherReference || savedPublisherReference.status === "failed") remember({ kind: "Publisher registration", status: "already present" });
      setOnboardingStep(datasetId, "publisher", "skipped", whitechainNetwork, { detail: "Publisher is already registered with the selected payout address." });
    }

    activeStage = "policy"; activeTransactionHash = undefined;
    setOnboardingStep(datasetId, "policy", "pending", whitechainNetwork);
    await resolvePending("Dataset policy", "policy");
    const datasetOwner = await publicClient.readContract({ address: SETTLEMENT, abi: publisherWriteAbi, functionName: "datasetPublisher", args: [datasetId] });
    const zeroAddress = "0x0000000000000000000000000000000000000000";
    if (datasetOwner.toLowerCase() === zeroAddress) {
      await sendAndWait("policy", "registerDataset", [datasetId, BigInt(setup.pricePerRecord), setup.maxRecordsPerQuery, BigInt(setup.maxPayoutPerQuery), BigInt(setup.publisherSignatureThreshold), BigInt(setup.datasetExpiresAt)], "Dataset policy");
    } else if (datasetOwner.toLowerCase() === address.toLowerCase()) {
      const policy = await publicClient.readContract({ address: SETTLEMENT, abi: publisherWriteAbi, functionName: "datasetPolicies", args: [datasetId] });
      const policyMatches = policy[0] === BigInt(setup.pricePerRecord) && policy[1] === BigInt(setup.maxPayoutPerQuery) &&
        policy[2] === BigInt(setup.publisherSignatureThreshold) && BigInt(policy[3]) === BigInt(setup.maxRecordsPerQuery) &&
        policy[4] === BigInt(setup.datasetExpiresAt) && policy[6];
      if (!policyMatches) throw new Error("This dataset is already registered with a different on-chain policy. Review its selected policy before continuing.");
      const savedPolicyReference = bundle.references.find((reference) => reference.kind === "Dataset policy");
      if (!savedPolicyReference || savedPolicyReference.status === "failed") remember({ kind: "Dataset policy", status: "already present" });
      setOnboardingStep(datasetId, "policy", "skipped", whitechainNetwork, { detail: "Matching active policy already exists on chain." });
    } else {
      throw new Error("This dataset ID is already registered to another publisher.");
    }

    activeStage = "grant"; activeTransactionHash = undefined;
    setOnboardingStep(datasetId, "grant", "pending", whitechainNetwork);
    await resolvePending("Coordinator grant", "grant");
    const grant = await publicClient.readContract({ address: SETTLEMENT, abi: publisherWriteAbi, functionName: "coordinatorGrants", args: [datasetId, setup.coordinator] });
    if (grant[2] && grant[0] >= BigInt(setup.coordinatorGrantExpiresAt)) {
      const existingGrant = bundle.references.find((reference) => reference.kind === "Coordinator grant");
      remember(existingGrant && existingGrant.status !== "failed" ? existingGrant : { kind: "Coordinator grant", status: "already present" });
      setOnboardingStep(datasetId, "grant", "skipped", whitechainNetwork, { detail: `Coordinator grant is active through ${dateFromSeconds(grant[0].toString())}.` });
    } else {
      await sendAndWait("grant", "authorizeCoordinator", [datasetId, setup.coordinator, BigInt(setup.coordinatorGrantExpiresAt)], "Coordinator grant");
    }
    setNotice(`Dataset ${datasetId} is fully configured. Arkiv keys and confirmed transaction references are listed below.`);
    } catch (error) {
      const hasPending = bundle.references.some((reference) => reference.status === "submitted" && reference.transactionHash === activeTransactionHash);
      setOnboardingStep(datasetId, activeStage, hasPending ? "submitted" : "failed", whitechainNetwork, { ...(activeTransactionHash ? { transactionHash: activeTransactionHash } : {}), detail: error instanceof Error ? error.message : "Whitechain setup failed" });
      throw error;
    }
  }

  async function manageDataset(action: "update" | "revoke") {
    if (!selectedDatasetId || !SETTLEMENT || !address || !walletClient || !publicClient || !import.meta.env.VITE_COORDINATOR_ADDRESS) return;
    setWriteBusy(true); setError("");
    try {
      await switchWalletChain(config, { chainId: whitechainSepolia.id });
      const coordinator = import.meta.env.VITE_COORDINATOR_ADDRESS as Address;
      const hash = action === "revoke"
        ? await walletClient.writeContract({ address: SETTLEMENT, abi: publisherWriteAbi, functionName: "revokeCoordinator", args: [selectedDatasetId, coordinator] })
        : await walletClient.writeContract({ address: SETTLEMENT, abi: publisherWriteAbi, functionName: "updateDatasetPolicy", args: [selectedDatasetId, BigInt(datasetPrice), Number(datasetMaxRecords), BigInt(datasetMaxPayout), BigInt(signatureThreshold), BigInt(Math.floor(Date.now() / 1000) + Number(datasetExpiry) * 86_400)] });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`${action} transaction reverted: ${hash}`);
      setNotice(action === "revoke" ? `Coordinator authorization revoked: ${hash}` : `Dataset policy updated: ${hash}`);
      const bundle = publisherBundles.find((item) => item.datasetId.toLowerCase() === selectedDatasetId.toLowerCase());
      if (bundle) {
        const reference: PublisherReference = { kind: action === "revoke" ? "Coordinator revocation" : "Dataset policy", transactionHash: hash };
        const setup = bundle.setup && action === "update" ? {
          ...bundle.setup, pricePerRecord: datasetPrice, maxRecordsPerQuery: Number(datasetMaxRecords),
          maxPayoutPerQuery: datasetMaxPayout, publisherSignatureThreshold: signatureThreshold,
          datasetExpiresAt: String(Math.floor(Date.now() / 1000) + Number(datasetExpiry) * 86_400),
        } : bundle.setup;
        savePublisherBundle(address, { ...bundle, ...(setup ? { setup } : {}), references: [...bundle.references.filter((item) => item.kind !== reference.kind), reference] });
      }
      await loadMarketplace();
    } catch (e) { setError(e instanceof Error ? e.message : `Could not ${action} dataset authorization`); }
    finally { setWriteBusy(false); }
  }

  const mine = datasets.filter((dataset) => dataset.publisher.toLowerCase() === address?.toLowerCase());
  const localDatasets: Dataset[] = publisherBundles.filter((bundle) => bundle.setup?.publisher.toLowerCase() === address?.toLowerCase()).map((bundle) => ({
    datasetId: bundle.datasetId, publisher: bundle.setup!.publisher, category: bundle.setup!.category, title: bundle.setup!.title,
    description: "Created from this browser", pricePerRecord: bundle.setup!.pricePerRecord,
    maxRecordsPerQuery: bundle.setup!.maxRecordsPerQuery, maxPayoutPerQuery: bundle.setup!.maxPayoutPerQuery,
    policyExpiresAt: bundle.setup!.datasetExpiresAt, coordinatorGrantExpiresAt: bundle.setup!.coordinatorGrantExpiresAt,
  }));
  const publisherDatasetMap = new Map<string, Dataset>();
  for (const dataset of [...mine, ...localDatasets]) publisherDatasetMap.set(dataset.datasetId.toLowerCase(), dataset);
  const publisherDatasets = [...publisherDatasetMap.values()];
  const selectedBundle = publisherBundles.find((bundle) => bundle.datasetId.toLowerCase() === selectedDatasetId.toLowerCase());
  const selectedDataset = publisherDatasets.find((dataset) => dataset.datasetId.toLowerCase() === selectedDatasetId.toLowerCase());
  const selectedProgress = selectedDatasetId ? onboardingProgress[selectedDatasetId.toLowerCase()] ?? {} : {};
  const selectedArkivComplete = !!selectedBundle && hasConfirmedPublisherBatch(selectedBundle.references);
  const selectedNeedsReconciliation = !!selectedBundle?.references.some((reference) => reference.kind === "Arkiv batch" && reference.status === "reconciliation required");
  const canResumeWhitechain = !!selectedBundle && canResumeWhitechainSetup(selectedBundle);
  const deliveryHashValid = isValidDeliveryTransactionHash(deliveryHashInput);
  const datasetsView = discoveryView(discoveryStatus, datasets.length);
  const publishersView = discoveryView(discoveryStatus, publishers.length);
  const mineView = discoveryView(discoveryStatus, publisherDatasets.length);
  const publisherName = (wallet: string) => publishers.find((publisher) => publisher.address.toLowerCase() === wallet.toLowerCase())?.displayName ?? short(wallet);

  async function selectPublisherDataset(datasetId: `0x${string}`) {
    setSelectedDatasetId(datasetId);
    const local = publisherBundles.find((bundle) => bundle.datasetId.toLowerCase() === datasetId.toLowerCase());
    if (local?.setup) {
      setDatasetTitle(local.setup.title); setDatasetCategory(local.setup.category); setDatasetPrice(local.setup.pricePerRecord);
      setDatasetMaxRecords(String(local.setup.maxRecordsPerQuery)); setDatasetMaxPayout(local.setup.maxPayoutPerQuery);
      setSignatureThreshold(local.setup.publisherSignatureThreshold);
      setDatasetExpiry(String(Math.max(1, Math.ceil((Number(local.setup.datasetExpiresAt) - Date.now() / 1000) / 86_400))));
      return;
    }
    if (!publicClient || !SETTLEMENT) return;
    try {
      const policy = await publicClient.readContract({ address: SETTLEMENT, abi: publisherWriteAbi, functionName: "datasetPolicies", args: [datasetId] });
      setDatasetPrice(policy[0].toString()); setDatasetMaxPayout(policy[1].toString()); setSignatureThreshold(policy[2].toString());
      setDatasetMaxRecords(String(policy[3]));
      setDatasetExpiry(String(Math.max(1, Math.ceil((Number(policy[4]) - Date.now() / 1000) / 86_400))));
      const discovered = publisherDatasets.find((dataset) => dataset.datasetId.toLowerCase() === datasetId.toLowerCase());
      if (discovered) { setDatasetTitle(discovered.title); setDatasetCategory(discovered.category); }
    } catch (error) { setError(error instanceof Error ? error.message : "Could not load dataset policy"); }
  }

  async function resumeWhitechainSetup() {
    if (!selectedBundle || !canResumeWhitechainSetup(selectedBundle) || writeBusy) return;
    setWriteBusy(true); setError(""); setNotice("");
    try {
      await completeWhitechainSetup(selectedBundle);
      await loadMarketplace();
    } catch (error) { setError(error instanceof Error ? error.message : "Whitechain setup could not be resumed"); }
    finally { setWriteBusy(false); }
  }

  function coordinatorAuthorizationLabel(datasetId: string) {
    const references = publisherBundles.find((bundle) => bundle.datasetId.toLowerCase() === datasetId.toLowerCase())?.references ?? [];
    return references.map((reference) => reference.kind).lastIndexOf("Coordinator revocation") > references.map((reference) => reference.kind).lastIndexOf("Coordinator grant")
      ? "Coordinator revoked" : "Coordinator active";
  }

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
      {isConnected && !delivered && <div className="delivery-recovery" role="group" aria-label="Recover settled data">
        <span className="delivery-recovery-copy">{pendingDelivery ? "Settlement confirmed. Retry data delivery." : "Already settled? Enter the transaction hash to recover delivery."}</span>
        <input className="delivery-recovery-input" aria-label="Settlement transaction hash" value={deliveryHashInput} onChange={(event) => setDeliveryHashInput(event.target.value)} maxLength={66} autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder="0x followed by the 64-character transaction hash" />
        <button className="delivery-recovery-button" disabled={!sdk || !deliveryHashValid || paymentPending} onClick={() => void retryDelivery()}>{paymentPending ? "Verifying…" : pendingDelivery ? "Retry data delivery" : "Recover delivery"}</button>
      </div>}
      {deliveryStep && !delivered && <div className={`alert ${deliveryStep.status === "retryable error" || deliveryStep.status === "unrecoverable error" ? "alert-error" : "alert-notice"}`} role="status">
        {deliveryStep.status === "pending" || deliveryStep.status === "signature requested" ? <span className="spinner dark" /> : deliveryStep.status === "confirmed" ? <span>Confirmed:</span> : deliveryStep.status === "retryable error" ? <span>Retryable delivery issue:</span> : deliveryStep.status === "unrecoverable error" ? <span>Delivery blocked:</span> : <span>Delivery:</span>}
        <span>{deliveryStep.message} {deliveryStep.status === "signature requested" && "This EIP-712 signature authorizes delivery only; it spends no funds and creates no blockchain transaction."}</span>
      </div>}
      {discoveryStatus === "loading" && (datasets.length > 0 || publishers.length > 0) && <div className="inline-hint"><span className="spinner dark" /> Refreshing coordinator and Arkiv discovery…</div>}
      {discoveryStatus === "error" && (datasets.length > 0 || publishers.length > 0) && <div className="alert alert-error"><span>!</span>{discoveryError}<button className="text-button" onClick={() => void loadMarketplace()}>Retry ↻</button></div>}

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
          <div className="quote-summary"><div><span className="muted-label">QUERY ID</span><code>{short(quote.quoteId)}</code></div><div><span className="muted-label">AUTHORIZED MATCHES</span><strong>{quote.totalMatchingRecords ?? quote.records.length}</strong></div><div><span className="muted-label">ELIGIBLE TO SETTLE</span><strong>{quote.eligibleRecords ?? quote.records.length}</strong></div><div><span className="muted-label">EXPIRES</span><strong>{dateFromSeconds(quote.manifest.deadline.toString())}</strong></div></div>
          {quote.publisherApprovalRequests?.length ? <div className="approval-warning"><div><strong>Publisher approval required</strong><span>Each threshold-triggered allocation needs a signature from its publisher wallet.</span></div>{quote.publisherApprovalRequests.map((request) => <button key={request.datasetId} disabled={!!approvalPending || !isConnected || address?.toLowerCase() !== request.publisher.toLowerCase()} onClick={() => void approveHighValueAllocation(request)}>{approvalPending === request.datasetId ? "Waiting for signature…" : `Sign for ${short(request.datasetId)}`}</button>)}</div> : null}
          <div className="allocation-table"><div className="table-head"><span>PUBLISHER / DATASET</span><span>RECORDS</span><span>PRICE / RECORD</span><span>PAYOUT</span></div>
            {quote.breakdown.map((row) => <div className="table-row" key={row.datasetId}><div className="publisher-cell"><span className="publisher-avatar">{publisherName(row.publisher).slice(0, 1).toUpperCase()}</span><div><strong>{publisherName(row.publisher)}</strong><small>{short(row.datasetId)}</small></div></div><span>{row.recordCount}</span><span>{amount(row.pricePerRecord)}</span><strong>{amount(row.payoutAmount)}</strong></div>)}
          </div>
          <div className="quote-bottom"><div className="preview-list"><span className="muted-label">PREVIEW · SHOWING {previewRecordCount(quote.records.length)} OF {quote.eligibleRecords ?? quote.records.length} ELIGIBLE RECORDS · {quote.totalMatchingRecords ?? quote.records.length} AUTHORIZED MATCHES</span>{quote.records.slice(0, previewRecordCount(quote.records.length)).map((record, index) => <div className="preview-row" key={`${record.recordHash}-${index}`}><span className="preview-index">{String(index + 1).padStart(2, "0")}</span><span>{record.preview}</span><code>{short(record.recordHash)}</code></div>)}</div>
            <div className="pay-card"><span className="muted-label">TOTAL TO SETTLE</span><strong className="total-amount">{amount(quote.manifest.totalAmount)}</strong><small>Exact USDT amount · paid directly to publishers</small><div className="payment-network">Required network: <strong>Whitechain Sepolia · Chain ID 1874</strong></div>
              <div className="payment-guidance">{!isConnected ? "Connect the buyer wallet before continuing." : chainId !== whitechainSepolia.id ? "Switch MetaMask to Whitechain Sepolia before continuing." : "MetaMask will ask you to confirm each required transaction."}</div>
              {chainId !== whitechainSepolia.id && isConnected && <button className="inline-link" disabled={isSwitching} onClick={() => switchChain({ chainId: whitechainSepolia.id })}>{isSwitching ? "Switching network…" : "Switch to Whitechain Sepolia"}</button>}
              <button className="primary-button" disabled={paymentPending || paymentSteps.settlement?.status === "confirmed" || !isConnected || chainId !== whitechainSepolia.id || !!quote.publisherApprovalRequests?.length} onClick={() => void payForQuote()}>{paymentPending ? <><span className="spinner" /> Waiting for wallet</> : paymentSteps.settlement?.status === "confirmed" ? <>Settlement confirmed <span>✓</span></> : paymentSteps.settlement?.status === "failed" ? <>Retry settlement <span>→</span></> : paymentSteps.approval?.status === "confirmed" ? <>Submit settlement <span>→</span></> : <>Approve exact amount & settle <span>→</span></>}</button></div>
          </div>
          <div className="inline-hint">Deployed settlement limits: up to 10 dataset allocations and 50 records per query. This quote includes {quote.breakdown.length} allocation(s) and {quote.eligibleRecords ?? quote.records.length} eligible record(s). {quote.totalMatchingRecords !== undefined && quote.totalMatchingRecords > (quote.eligibleRecords ?? quote.records.length) ? "More authorized matches exist than are included in this payable quote; request another query to review additional results." : "The complete authorized result set fits within this quote."}</div>
          <div className="payment-steps" aria-label="Payment progress">
            {(() => {
              const approval = paymentSteps.approval;
              const settlementStep = paymentSteps.settlement;
              const rows = [
                { title: "Approve exact USDT amount", status: approval?.status === "skipped" ? "Skipped; existing allowance is sufficient." : approval?.status === "confirmed" ? "Approval transaction confirmed." : approval?.status === "submitted" ? "Approval submitted." : approval?.status === "failed" ? "Approval failed." : "Approve the exact amount shown above." },
                { title: "Wait for approval confirmation", status: approval?.status === "confirmed" || approval?.status === "skipped" ? "Ready for settlement." : approval?.status === "submitted" ? "Waiting for approval receipt." : "Settlement waits until approval is confirmed." },
                { title: "Submit QueryMint settlement", status: settlementStep?.status === "submitted" ? "Settlement submitted." : settlementStep?.status === "failed" ? "Settlement failed; approval remains recorded above." : settlementStep?.status === "confirmed" ? "Settlement was submitted." : settlementStep?.status === "pending" ? "Ready for MetaMask confirmation." : "Submit only after quote authorization is rechecked." },
                { title: "Wait for settlement confirmation", status: settlementStep?.status === "confirmed" ? "Successful Whitechain receipt verified." : settlementStep?.status === "failed" ? "No successful settlement receipt." : settlementStep?.status === "submitted" ? "Waiting for settlement receipt." : "Delivery remains locked until receipt confirmation." },
                { title: "Enable data delivery", status: settlementStep?.status === "confirmed" ? "Requires buyer EIP-712 authorization to release records." : "Available only after settlement confirmation." },
              ];
              return rows.map((row, index) => {
                const complete = index === 0 ? approval?.status === "confirmed" || approval?.status === "skipped" : index === 1 ? approval?.status === "confirmed" || approval?.status === "skipped" : index === 2 ? settlementStep?.status === "submitted" || settlementStep?.status === "confirmed" : index === 3 ? settlementStep?.status === "confirmed" : false;
                const failed = index < 2 ? approval?.status === "failed" : index < 4 ? settlementStep?.status === "failed" : false;
                const hash = index < 2 ? approval?.transactionHash : index < 4 ? settlementStep?.transactionHash : undefined;
                return <div className="payment-step" key={row.title}><span className={`payment-step-number ${complete ? "complete" : failed ? "failed" : ""}`}>{complete ? "✓" : index + 1}</span><div><strong>{row.title}</strong><small>{row.status}</small>{hash && <a href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer">{index < 2 ? "Approval" : "Settlement"} tx {short(hash)} ↗</a>}</div></div>;
              });
            })()}
          </div>
          <div className="inline-hint">Transaction-hash recovery is only needed if normal delivery state is lost, such as after a refresh or failed delivery response. The buyer EIP-712 delivery signature spends no funds and creates no blockchain transaction.</div>
        </section>}

        {delivered && <section className="panel delivered-panel"><div className="panel-kicker"><span className="success-mark">✓</span> SETTLEMENT CONFIRMED <span className="panel-rule" /></div><div className="receipt-grid"><div><span className="muted-label">TRANSACTION</span><a href={`${explorer}/tx/${delivered.transactionHash}`} target="_blank" rel="noreferrer">{short(delivered.transactionHash)} ↗</a></div><div><span className="muted-label">BLOCK</span><strong>{delivered.blockNumber}</strong></div><div><span className="muted-label">LICENSED RECORDS</span><strong>{delivered.records.length}</strong></div></div><pre className="payload-view">{JSON.stringify(delivered.records, null, 2)}</pre></section>}

        <section className="section-block"><div className="section-title"><div><span className="eyebrow">DISCOVER</span><h2>Available datasets</h2></div><button className="text-button" onClick={() => void loadMarketplace()}>Refresh ↻</button></div>
          {datasetsView === "loading" ? <div className="empty-state"><span className="spinner dark" /> Loading coordinator data…</div>
            : datasetsView === "error" ? <div className="empty-state">{discoveryError}<button className="text-button" onClick={() => void loadMarketplace()}>Retry discovery ↻</button></div>
            : datasetsView === "empty" ? <div className="empty-state">No active coordinator-authorized datasets returned by the API.</div>
            : <div className="dataset-grid">{datasets.map((dataset) => <article className="dataset-card" key={dataset.datasetId}><div className="dataset-top"><span className="category-tag">{dataset.category}</span><span className="active-tag"><i /> AUTHORIZED</span></div><h3>{dataset.title}</h3><p>{dataset.description}</p><div className="dataset-stats"><div><span>PRICE / RECORD</span><strong>{amount(dataset.pricePerRecord)}</strong></div><div><span>QUERY CAP</span><strong>{dataset.maxRecordsPerQuery} records</strong></div></div><div className="dataset-foot"><span>BY {publisherName(dataset.publisher).toUpperCase()}</span><button onClick={() => { setCategory(dataset.category); window.scrollTo({ top: 0, behavior: "smooth" }); }}>Query category ↗</button></div></article>)}</div>}
        </section>
        <section className="section-block publisher-directory"><div className="section-title"><div><span className="eyebrow">ATTRIBUTION</span><h2>Verified publishers</h2></div><span className="small-count">{publishers.length} REGISTERED</span></div>
          {publishersView === "loading" ? <div className="empty-state"><span className="spinner dark" /> Loading publisher profiles…</div>
            : publishersView === "error" ? <div className="empty-state">{discoveryError}<button className="text-button" onClick={() => void loadMarketplace()}>Retry discovery ↻</button></div>
            : publishersView === "empty" ? <div className="empty-state">No registered publisher profiles returned by the coordinator.</div>
            : <div className="directory-grid">{publishers.map((publisher) => <article key={publisher.address}><span className="publisher-avatar">{publisher.displayName.slice(0, 1).toUpperCase()}</span><div><strong>{publisher.displayName}</strong><small>{short(publisher.address)} · Whitechain registered</small></div><a href={`${explorer}/address/${publisher.address}`} target="_blank" rel="noreferrer">Profile ↗</a></article>)}</div>}
        </section>
      </> : <>
        <section className="panel publisher-panel">
          <div className="panel-kicker">PUBLISH A DATASET <span className="panel-rule" /><span className="small-count">ARKIV + WHITECHAIN</span></div>
          {!address ? <div className="empty-state">Connect the publisher wallet to write a profile, dataset policy, and encrypted records.</div> : <>
            <div className="query-controls publisher-form-grid">
              <label>Publisher name<div className="input-wrap"><input value={publisherNameInput} onChange={(e) => setPublisherNameInput(e.target.value)} placeholder="Your publisher name" /></div></label>
              <label>Payout address<div className="input-wrap"><input value={payoutAddressInput} onChange={(e) => setPayoutAddressInput(e.target.value)} placeholder={address} /></div></label>
              <label>Dataset title<div className="input-wrap"><input value={datasetTitle} onChange={(e) => setDatasetTitle(e.target.value)} placeholder="Dataset title" /></div></label>
              <label>Category<div className="input-wrap"><input value={datasetCategory} onChange={(e) => setDatasetCategory(e.target.value)} maxLength={64} /></div></label>
              <label>Price per record · USDT base units<div className="input-wrap"><input inputMode="numeric" value={datasetPrice} onChange={(e) => setDatasetPrice(e.target.value)} /></div></label>
              <label>Maximum records / query<div className="input-wrap"><input type="number" min="1" max="50" value={datasetMaxRecords} onChange={(e) => setDatasetMaxRecords(e.target.value)} /></div></label>
              <label>Maximum payout / query · USDT base units<div className="input-wrap"><input inputMode="numeric" value={datasetMaxPayout} onChange={(e) => setDatasetMaxPayout(e.target.value)} /></div></label>
              <label>Publisher approval threshold · base units, 0 disables<div className="input-wrap"><input inputMode="numeric" value={signatureThreshold} onChange={(e) => setSignatureThreshold(e.target.value)} /></div></label>
              <label>Dataset expiry · days<div className="input-wrap"><input type="number" min="1" value={datasetExpiry} onChange={(e) => setDatasetExpiry(e.target.value)} /></div></label>
              <label>Coordinator grant · days<div className="input-wrap"><input type="number" min="1" value={coordinatorExpiry} onChange={(e) => setCoordinatorExpiry(e.target.value)} /></div></label>
            </div>
            <label className="publisher-record-input">Records JSON<div className="input-wrap publisher-record-wrap"><textarea rows={5} value={recordJson} onChange={(e) => setRecordJson(e.target.value)} /></div></label>
            <div className="inline-hint">Your wallet signs each Arkiv entity and each Whitechain policy transaction. For this MVP, record plaintext is sent to the trusted coordinator API for encryption; only ciphertext is written to Arkiv. Use test data until publisher managed encryption and HTTPS are configured.</div>
            <button className="primary-button query-button" disabled={writeBusy || !SETTLEMENT || !datasetTitle.trim() || canResumeWhitechain || selectedNeedsReconciliation} onClick={() => void publishDataset()}>{writeBusy ? <><span className="spinner" /> Working on {ONBOARDING_STAGES.find((stage) => selectedProgress[stage.id]?.status === "pending" || selectedProgress[stage.id]?.status === "submitted")?.title ?? "publisher setup"}…</> : canResumeWhitechain || selectedNeedsReconciliation ? <>Finish selected dataset setup first <span>↗</span></> : <>Publish a new dataset <span>→</span></>}</button>
            {selectedDatasetId && (selectedBundle || Object.keys(selectedProgress).length > 0) && <section className="onboarding-progress" aria-label="Publisher onboarding progress">
              <div className="panel-kicker">ONBOARDING PROGRESS <span className="panel-rule" /><span className="small-count">{short(selectedDatasetId)}</span></div>
              {selectedBundle?.setup && <div className="inline-hint">Setup review · payout <code>{short(selectedBundle.setup.payoutAddress)}</code> · coordinator <code>{short(selectedBundle.setup.coordinator)}</code> · {amount(selectedBundle.setup.pricePerRecord)} / record · max payout {amount(selectedBundle.setup.maxPayoutPerQuery)} · {selectedBundle.setup.maxRecordsPerQuery} records/query</div>}
              {ONBOARDING_STAGES.map((stage) => {
                const storedRef = selectedBundle?.references.find((reference) =>
                  stage.id === "arkiv" ? reference.kind === "Arkiv batch" :
                  stage.id === "publisher" ? reference.kind === "Publisher registration" || reference.kind === "Publisher payout update" :
                  stage.id === "policy" ? reference.kind === "Dataset policy" : stage.id === "grant" ? reference.kind === "Coordinator grant" : false);
                const grantIndex = selectedBundle?.references.map((reference) => reference.kind).lastIndexOf("Coordinator grant") ?? -1;
                const revokeIndex = selectedBundle?.references.map((reference) => reference.kind).lastIndexOf("Coordinator revocation") ?? -1;
                const grantRevoked = stage.id === "grant" && revokeIndex > grantIndex;
                const persistedStatus: OnboardingStatus = stage.id === "prepare" ? selectedArkivComplete ? "confirmed" : "pending" :
                  stage.id === "arkiv" ? selectedNeedsReconciliation ? "reconciliation required" : selectedArkivComplete ? "confirmed" : "pending" :
                  grantRevoked ? "revoked" : storedRef ? storedRef.status === "already present" ? "skipped" : storedRef.status === "reconciliation required" ? "reconciliation required" : storedRef.status === "submitted" ? "submitted" : storedRef.status === "failed" ? "failed" : "confirmed" : "pending";
                const progress = selectedProgress[stage.id];
                const status = progress?.status ?? persistedStatus;
                const transactionHash = progress?.transactionHash ?? storedRef?.transactionHash;
                const entityRefs = stage.id === "arkiv" ? (selectedBundle?.references.filter((reference) => reference.entityKey) ?? []) : [];
                const statusLabel = status === "skipped" ? "Already confirmed" : status === "reconciliation required" ? "Reconciliation required" : status[0]!.toUpperCase() + status.slice(1);
                const nextAction = stage.id === "prepare" ? "Next: encrypt records in memory." : stage.id === "arkiv" ? "Next: approve one Rabdi batch transaction." : stage.id === "publisher" ? "Next: confirm registration if needed." : stage.id === "policy" ? "Next: confirm or verify the dataset policy." : "Next: confirm coordinator authorization.";
                return <div className={`onboarding-step status-${status.replaceAll(" ", "-")}`} key={stage.id}>
                  <span className="onboarding-step-mark">{status === "confirmed" || status === "skipped" ? "✓" : status === "failed" || status === "reconciliation required" ? "!" : status === "submitted" ? "↗" : "·"}</span>
                  <div><strong>{stage.title}</strong><small>{progress?.network ?? stage.network} · {statusLabel} · {progress?.detail ?? nextAction}</small>
                    {transactionHash && <a href={`${stage.id === "arkiv" ? "https://rabdi.explorer.arkiv.network" : explorer}/tx/${transactionHash}`} target="_blank" rel="noreferrer">{short(transactionHash)} ↗</a>}
                    {entityRefs.length > 0 && <small>{entityRefs.length} entity keys confirmed</small>}
                  </div>
                </div>;
              })}
              {canResumeWhitechain && <button className="text-button" disabled={writeBusy} onClick={() => void resumeWhitechainSetup()}>Resume Whitechain setup for this dataset ↗</button>}
              {selectedNeedsReconciliation && <div className="inline-hint warning">The Arkiv batch could not be fully reconciled. Do not resubmit it until you check Rabdi wallet activity and confirm whether it landed.</div>}
            </section>}
            <section className="publisher-management">
              <div className="panel-kicker">MANAGE YOUR DATASETS <span className="panel-rule" /><span className="small-count">{publisherDatasets.length}</span></div>
              {publisherDatasets.length === 0 ? <div className="empty-state">Your datasets will appear here after coordinator discovery or a confirmed Arkiv batch.</div> : <>
                <div className="publisher-dataset-list">{publisherDatasets.map((dataset) => <article className={`publisher-dataset ${selectedDatasetId.toLowerCase() === dataset.datasetId.toLowerCase() ? "selected" : ""}`} key={dataset.datasetId}>
                  <div><span className="category-tag">{dataset.category}</span><h3>{dataset.title}</h3><code>{dataset.datasetId}</code></div>
                  <div className="publisher-dataset-meta"><span>Price <strong>{amount(dataset.pricePerRecord)}</strong></span><span>Max/query <strong>{dataset.maxRecordsPerQuery}</strong></span></div>
                  <div className="authorization-state"><i />{coordinatorAuthorizationLabel(dataset.datasetId)}<small>Until {dateFromSeconds(dataset.coordinatorGrantExpiresAt)}</small></div>
                  <button className="text-button" disabled={writeBusy} onClick={() => void selectPublisherDataset(dataset.datasetId)}>{selectedDatasetId.toLowerCase() === dataset.datasetId.toLowerCase() ? "Selected" : "Select dataset"}</button>
                </article>)}</div>
                {selectedDataset && <div className="selected-dataset-controls">
                  <div className="inline-hint">Selected dataset: <code>{selectedDataset.datasetId}</code> · Price {amount(selectedDataset.pricePerRecord)} · cap {selectedDataset.maxRecordsPerQuery} records</div>
                  <div className="query-controls"><button className="text-button" disabled={writeBusy} onClick={() => void manageDataset("update")}>Update selected policy</button><button className="text-button" disabled={writeBusy} onClick={() => void manageDataset("revoke")}>Revoke selected coordinator access</button></div>
                  {selectedBundle?.references.length ? <pre className="payload-view">{selectedBundle.references.map(formatPublisherReference).join("\n")}</pre> : <div className="inline-hint">No locally saved Arkiv references for this dataset.</div>}
                </div>}
              </>}
            </section>
            {referencePersistenceWarning && <div className="alert alert-notice">{referencePersistenceWarning}</div>}
          </>}
        </section>
        <div className="publisher-stats"><section className="panel stat-card"><span className="muted-label">CONNECTED PUBLISHER</span><strong>{address ? short(address) : "Wallet not connected"}</strong><small>{address ? "Whitechain Sepolia" : "Connect to view your data"}</small></section><section className="panel stat-card"><span className="muted-label">ACTIVE DATASETS</span><strong>{!address ? "—" : discoveryStatus === "success" ? mine.length : discoveryStatus === "loading" ? "…" : "—"}</strong><small>{!address ? "Connect to view your data" : discoveryStatus === "success" ? "Authorized for this coordinator" : discoveryStatus === "loading" ? "Loading coordinator data" : "Discovery unavailable"}</small></section><section className="panel stat-card"><span className="muted-label">TOTAL EARNINGS</span><strong>{earnings ? amount(earnings.totalAmount) : "—"}</strong><small>From AllocationPaid events</small></section></div>
        <section className="panel publisher-panel"><div className="panel-kicker">YOUR DATASETS <span className="panel-rule" /><span className="small-count">{discoveryStatus === "success" ? `${mine.length} ACTIVE` : discoveryStatus === "loading" ? "LOADING" : "UNAVAILABLE"}</span></div>
          {!address ? <div className="empty-state">Connect the publisher wallet to see matching datasets.</div>
            : mineView === "loading" ? <div className="empty-state"><span className="spinner dark" /> Loading your coordinator-authorized datasets…</div>
            : mineView === "error" ? <div className="empty-state">{discoveryError}<button className="text-button" onClick={() => void loadMarketplace()}>Retry discovery ↻</button></div>
            : mineView === "empty" ? <div className="empty-state">No active datasets owned by this wallet are currently registered with this coordinator.</div>
            : <div className="publisher-dataset-list">{publisherDatasets.map((dataset) => <div className="publisher-dataset" key={dataset.datasetId}><div><span className="category-tag">{dataset.category}</span><h3>{dataset.title}</h3><code>{dataset.datasetId}</code></div><div className="publisher-dataset-meta"><span>Price <strong>{amount(dataset.pricePerRecord)}</strong></span><span>Max/query <strong>{dataset.maxRecordsPerQuery}</strong></span></div><div className="authorization-state"><i /> {coordinatorAuthorizationLabel(dataset.datasetId)}<small>Until {dateFromSeconds(dataset.coordinatorGrantExpiresAt)}</small></div></div>)}</div>}
        </section>
        <section className="panel publisher-panel"><div className="panel-kicker">SETTLEMENT HISTORY <span className="panel-rule" /><span className="small-count">ON-CHAIN EVENTS</span></div>{earnings?.settlements.length ? <div className="allocation-table"><div className="table-head"><span>QUERY / DATASET</span><span>RECORDS</span><span>BLOCK</span><span>EARNED</span></div>{earnings.settlements.map((row) => <div className="table-row" key={`${row.transactionHash}-${row.datasetId}`}><div className="publisher-cell"><span className="publisher-avatar">↗</span><div><a href={`${explorer}/tx/${row.transactionHash}`} target="_blank" rel="noreferrer">{short(row.queryId)}</a><small>{short(row.datasetId)}</small></div></div><span>{row.recordCount}</span><span>{row.blockNumber}</span><strong>{amount(row.amount)}</strong></div>)}</div> : <div className="empty-state">No settlement events returned for this wallet.</div>}</section>
        <div className="publisher-note"><span>i</span><p>Dataset registration, Arkiv uploads and authorization updates require publisher wallet transactions. This dashboard only displays data returned by the coordinator and does not fabricate upload or earnings activity.</p></div>
      </>}

      <footer className="footer"><span>QUERYMINT <i>·</i> PUBLISHER-OWNED DATA</span><span>WHITECHAIN SEPOLIA <i>·</i> ARKIV RABDI</span></footer>
    </main>
  </div>;
}
