# QueryMint

QueryMint lets buyers query publisher-owned Arkiv datasets in one request, review a signed multi-publisher quote, settle exact USDT payouts on Whitechain Sepolia, then retrieve the licensed records after receipt and buyer-signature verification.

## Networks and live deployment

- Whitechain Sepolia (chain ID `1874`) is the settlement and publisher-policy network. The deployed QueryMintSettlement contract is `0xb40363F6F9C1bEECf386C5C8440A826Ed9b9c854`; official USDT is `0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7`.
- Arkiv Rabdi (chain ID `7794095`) stores publisher-owned profiles, dataset manifests, and encrypted records.
- The production coordinator API is `https://querymint-production.up.railway.app`.
- The marketplace and publisher console deployment reported for the project is `https://web-rczjtwpqc-pranad.vercel.app`.

The owner has confirmed a live two-publisher settlement of 4 USDT total (2 USDT to each publisher), followed by buyer-authorized delivery of four records whose content hashes matched the signed manifest. The live validation log records that evidence and distinguishes it from local tests. In a read-only production smoke check on 2026-11-07, `/health`, `/publishers`, `/datasets`, and a buyer quote request succeeded; the quote contained four records across two allocations and totaled 4 USDT. The quote request did not approve or transfer tokens. Production browser UI inspection and access to Railway/Vercel deployment controls were unavailable in that pass.

## Architecture

The coordinator discovers Arkiv entities, verifies each publisher owner against Whitechain registration and active dataset/coordinator policy, deduplicates and bounds matching records, and signs EIP-712 manifests. The deployed contract independently validates publisher authorization, allocation amounts, payout recipients, nonces, expiry, and replay protection. The buyer SDK checks the quote, requests only the exact USDT approval when needed, submits settlement, waits for a successful receipt, and only then requests delivery. Recovery can reconstruct a settled query from the transaction and requires a buyer EIP-712 signature.

Arkiv metadata and entity ownership provide attribution, not confidentiality. Record payloads are encrypted by the coordinator using a server-held demo key; the coordinator can decrypt and returns licensed plaintext after settlement verification. This is a hackathon trust model, not end-to-end encryption or an independent security audit. Use synthetic demonstration data only.

## Run locally

Install the pinned workspace dependencies, copy `.env.example` to `.env`, then configure server-side values before starting the coordinator. Never put Arkiv access keys, private keys, or `DEMO_ENCRYPTION_KEY` in any `VITE_*` variable.

```powershell
npm ci
npm run dev:coordinator
npm run dev:web
npm run dev:demo
```

The buyer/publisher dashboard is at `http://localhost:5173`; the separate SDK demo is at `http://localhost:5174`. Frontends use public `VITE_*` build variables; server credentials stay only in the coordinator environment. See [deployment and environment setup](docs/deployment.md), [coordinator API and trust limits](docs/coordinator-api.md), and [live validation evidence](docs/live-validation.md).

## Buyer SDK shape

`@querymint/sdk` and its `@querymint/shared` dependency are configured as public ESM packages, but have **not been published**. Until release, follow [the SDK integration guide](packages/sdk/README.md) to use local package tarballs or the workspace. See the [release checklist](docs/sdk-release.md); do not expect `npm install @querymint/sdk` to work from the registry yet.

```ts
const qm = createQueryMint({ apiUrl, settlementAddress, walletClient, publicClient });
const quote = await qm.quote({ where: { category: "defi" }, limit: 20 });
console.table(quote.breakdown); // review publisher payouts before prompting the wallet
const result = await qm.pay({ quote });
console.log(result.records, result.transactionHash);
```

`quote()` uses the connected wallet as the buyer and validates the coordinator response, signed allocations, and payout breakdown. `pay()` refreshes the quote, refuses to proceed while a required publisher approval is missing, checks exact allowance, approves only the required amount, submits settlement, waits for the mined receipt, then requests buyer-authorized delivery. It may request two transactions and one message signature. A delivery/API failure after settlement is surfaced with the settlement transaction hash; it is not silently described as a refund. See [coordinator API documentation](docs/coordinator-api.md).

## Current milestone checklist

- [x] Workspace, pinned dependencies, TypeScript workspaces, and architecture/security instructions.
- [x] Whitechain USDT read-only verification and explicit live-transfer limitations.
- [x] Arkiv SDK 1.0.1 capability review, schemas, encrypted record model, owner-checking query path, and writer/query roundtrip script.
- [x] Solidity authorization/settlement contract and local tests for limits, signatures, replay, payouts, and failure cases.
- [x] Direct local settlement gas measurements for 1/1, 2/4, and 5/50 publisher/record batches.
- [x] Buyer SDK API surface for quote, exact approval, settlement, and post-receipt delivery.
- [x] Coordinator discovery, quote, signature, status, delivery, and event-derived earnings endpoints; mocked coordinator/Arkiv tests.
- [x] Buyer marketplace and signed quote/payment/delivery UI, read-only publisher datasets/permissions/earnings view, and separate SDK demo.
- [x] Publisher dataset registration/policy editor and encrypted Arkiv batch publishing.
- [x] Owner-checked multi-publisher discovery, signed quotes, bounded settlement, and buyer-authorized delivery recovery.
- [x] Live two-publisher settlement and four-record delivery reported by the project owner; current production discovery and quote smoke check pass.
- [x] Verify both production Vercel experiences in a browser and confirm the separate SDK demo deployment URL/configuration.
- [x] Re-run the full live flow at the event with the demo wallets, current policies/grants, funding, and a fresh buyer settlement.

   

    AI usage disclosure: AI assistance was used for architecture drafting and code authoring. All observed network behavior and test outcomes are described separately from unverified work.

    
