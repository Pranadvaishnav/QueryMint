# QueryMint buyer SDK

`@querymint/sdk` is prepared as an ESM npm package, version `0.1.0`, licensed under MIT. The package is **not yet published**. Its distributable JavaScript and TypeScript declarations are built into `dist/`; it depends on the public `@querymint/shared@0.1.0` package for chain definitions and EIP-712 helpers. Publish `@querymint/shared` before publishing the SDK.

Until release, build and pack both packages from the monorepo root:

```sh
npm ci
npm run build --workspace @querymint/shared
npm run build --workspace @querymint/sdk
npm pack --workspace @querymint/shared --pack-destination ./release-artifacts
npm pack --workspace @querymint/sdk --pack-destination ./release-artifacts
```

`release-artifacts` is a local staging directory; do not commit tarballs. The repository ignores `*.tgz` and package `dist/` output. For a separate local consumer, install both tarballs together because the SDK package declares `@querymint/shared` as a runtime dependency.

## Install after publication

In a new Vite/React project:

```sh
npm install @querymint/sdk@0.1.0 viem wagmi @tanstack/react-query
```

The SDK installation pulls in the matching shared package. The application uses the normal Vite/React and Wagmi setup; the SDK does not connect wallets, keep keys, or handle coordinator credentials itself.

Set these public variables in the application’s local `.env` and Vite production build environment:

```dotenv
VITE_COORDINATOR_API_URL=https://querymint-production.up.railway.app
VITE_QUERYMINT_SETTLEMENT_ADDRESS=0xb40363F6F9C1bEECf386C5C8440A826Ed9b9c854
VITE_WHITECHAIN_RPC_URL=https://rpc.testnet.whitechain.io
```

Only public API/RPC URLs and contract addresses belong in `VITE_` variables. Never place a coordinator private key, Arkiv access key, publisher key, or `DEMO_ENCRYPTION_KEY` in browser configuration.

## Whitechain Sepolia wallet setup

Configure Wagmi for chain ID `1874`, Whitechain Sepolia, and an injected wallet connector. Both clients passed to QueryMint must be configured for that chain. The buyer must connect the wallet that will pay and later authorize delivery. The SDK reads the account from `walletClient.account` and sends that address with the quote request.

```tsx
import { createQueryMint, whitechainSepolia, type QueryMintQuote, type QueryMintDelivery } from "@querymint/sdk";
import type { Address } from "viem";
import { usePublicClient, useWalletClient } from "wagmi";

const apiUrl = import.meta.env.VITE_COORDINATOR_API_URL as string | undefined;
const settlementAddress = import.meta.env.VITE_QUERYMINT_SETTLEMENT_ADDRESS as Address | undefined;
const { data: walletClient } = useWalletClient({ chainId: whitechainSepolia.id });
const publicClient = usePublicClient({ chainId: whitechainSepolia.id });
const querymint = apiUrl && settlementAddress && walletClient && publicClient
  ? createQueryMint({ apiUrl, settlementAddress, walletClient, publicClient })
  : null;
```

The parent app must wrap this component in a `WagmiProvider` configured with `whitechainSepolia`, an injected connector, and `http(import.meta.env.VITE_WHITECHAIN_RPC_URL)`.

## Minimal buyer flow

```tsx
const [quote, setQuote] = useState<QueryMintQuote | null>(null);
const [result, setResult] = useState<QueryMintDelivery | null>(null);
const [error, setError] = useState("");

async function requestQuote() {
  if (!querymint) return;
  try {
    setError("");
    setQuote(await querymint.quote({ where: { category: "defi" }, limit: 20 }));
  } catch (cause) {
    setError(cause instanceof Error ? cause.message : "Quote request failed");
  }
}

// Render quote.breakdown and quote.manifest.totalAmount for review before this action.
async function buy() {
  if (!querymint || !quote) return;
  try {
    setError("");
    setResult(await querymint.pay({ quote }));
  } catch (cause) {
    setError(cause instanceof Error ? cause.message : "Payment or delivery failed");
  }
}
```

In JSX, render `quote.breakdown` as one row per dataset (`publisher`, `recordCount`, `pricePerRecord`, and `payoutAmount`) and show `quote.manifest.totalAmount` in USDT before enabling the buyer’s action. Use integer base units for calculations; format with `formatUnits(amount, 6)` for display. `quote.records` are previews, not delivered plaintext.

## Signature and transaction sequence

1. `quote()` calls the coordinator API. It does not request a wallet signature or submit a transaction. It validates response fields and bounds, allocation payout arithmetic, record previews against manifest hashes, result root, and the coordinator EIP-712 signature.
2. `pay()` refreshes and revalidates the quote and checks both clients are on chain `1874`. It rechecks current publisher registration, dataset ownership, policy/grant status, nonces, and expiry.
3. If the buyer’s USDT allowance is below the exact quote amount, `pay()` requests one USDT approval transaction for that amount and waits for its receipt. If allowance already suffices, it skips approval.
4. `pay()` requests the Whitechain settlement transaction and waits for a successful receipt. It never automatically resubmits settlement.
5. After settlement confirmation, `pay()` requests a buyer EIP-712 `DeliveryAuthorization` message signature, which does not spend funds and is not a blockchain transaction. It then calls `deliver()` and returns decrypted record payloads only after the coordinator accepts the signed delivery request.

If `quote.publisherApprovalRequests` is nonempty, publisher signatures are also required. Collect each requested publisher’s typed-data signature and send it with `submitPublisherApproval({ quoteId, datasetId, signature })`. `pay()` stops until refreshed quote state reports no missing publisher approvals. The SDK does not hold publisher keys or sign on a publisher’s behalf.

## Transaction/error state and delivery recovery

Pass callbacks to expose wallet/network state in the application:

```ts
const querymint = createQueryMint({
  apiUrl,
  settlementAddress,
  walletClient,
  publicClient,
  onPaymentStep: (step) => setPaymentSteps((old) => ({ ...old, [step.stage]: step })),
  onSettlementConfirmed: (hash) => localStorage.setItem(`querymint:settlement:${buyerAddress}`, hash),
  onDeliveryStep: setDeliveryStep,
});
```

Approval and settlement steps include pending/submitted/confirmed/failed states and transaction hashes. Preserve the settlement hash if delivery fails after payment. Offer an explicit recovery action:

```ts
const transactionHash = localStorage.getItem(`querymint:settlement:${buyerAddress}`) as Hex | null;
if (transactionHash) setResult(await querymint.deliver({ transactionHash }));
```

`deliver()` checks the Whitechain Sepolia receipt, the QueryMint settlement event, and that the connected wallet is the event buyer before prompting for the buyer signature. It checks that the coordinator response refers to the same query, transaction, and block before returning records. The coordinator independently verifies the signature, transaction/calldata, settlement and payout events, Arkiv ownership, and content hashes. The SDK relies on the configured coordinator for those server-side checks and does not independently recompute content hashes from returned plaintext.

If settlement reverted, approval may remain in place; a new `pay()` call refreshes the quote, checks whether the query already settled, and reads current allowance before deciding whether approval is needed. If receipt status is unknown, inspect the transaction before retrying. Never automatically submit another settlement. If delivery alone fails, use `deliver()` with the confirmed transaction hash; it does not approve or settle again.

## Build and test

From the repository root:

```sh
npm ci
npm run build --workspace @querymint/shared
npm run build --workspace @querymint/sdk
npm test --workspace @querymint/sdk
npm pack --workspace @querymint/shared --dry-run
npm pack --workspace @querymint/sdk --dry-run
```

The eventual release requires publishing `@querymint/shared@0.1.0` first, then `@querymint/sdk@0.1.0`. Confirm the npm scope is controlled by QueryMint and the package names are available before release. Publishing is a separate operator action; no credentials are needed for this build or dry-run.

See [the SDK release checklist](../../docs/sdk-release.md) for repeatable validation and publication commands.
