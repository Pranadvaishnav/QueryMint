# QueryMint — ETHGlobal submission and demo guide

## Project summary

QueryMint gives buyers one searchable interface for publisher-owned data across Arkiv. Each publisher chooses the datasets, pricing, record caps, payout cap, expiry, and coordinator access. For a buyer query, the coordinator discovers and verifies eligible records, then signs an EIP-712 manifest with explicit record hashes and per-dataset payouts. The buyer pays the exact USDT total once on Whitechain Sepolia; the settlement contract validates publisher policy and sends each allocation directly to its configured payout address. After a successful receipt and buyer EIP-712 authorization, QueryMint releases the encrypted records.

**Short pitch:** “QueryMint turns publisher-controlled data access into a verifiable, multi-publisher purchase: discover on Arkiv, enforce prices and payouts on Whitechain, and deliver only after settlement.”

## What is implemented

- Arkiv Rabdi (chain `7794095`) publisher profiles, manifests, encrypted records, batching for publisher uploads, indexed discovery, keyset pagination, owner checks, and content/payload hash verification.
- Whitechain Sepolia (chain `1874`) publisher/dataset policy and coordinator authorization, plus the deployed QueryMintSettlement contract and official USDT token.
- Coordinator quote aggregation with deterministic ordering, bounded capacity (10 allocations / 50 records), EIP-712 signatures, expiry/nonce checks, and duplicate rejection.
- SDK exact-amount approval, settlement, receipt verification, buyer-authorized delivery, and transaction-hash recovery.
- Publisher and buyer interfaces, plus a separate SDK integration demo.

The deployed contract is `0xb40363F6F9C1bEECf386C5C8440A826Ed9b9c854`; official Whitechain Sepolia USDT is `0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7`. Explorer links: [contract](https://explorer.testnet.whitechain.io/address/0xb40363F6F9C1bEECf386C5C8440A826Ed9b9c854) and [USDT](https://explorer.testnet.whitechain.io/address/0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7).

## Evidence and limits

The project owner reports one live two-publisher settlement for 4 USDT total, split 2 USDT to each publisher, followed by delivery of four records whose hashes matched the signed manifest. Local mocked integration tests cover five publishers and the contract's ten-allocation/fifty-record maximum; local EVM gas measurements are documented separately in `docs/live-validation.md` and are not live Whitechain gas measurements.

On 2026-11-07 a read-only production check observed HTTP 200 from coordinator health, publisher and dataset discovery, and quote generation. The quote had two allocations, four records, and a 4 USDT total. No approval or settlement was made by that check. The marketplace origin passed an HTTP CORS preflight. We could not inspect the production browser UI or hosting dashboards during this pass, so the separate SDK demo deployment and its final production build variables still need an operator check.

Arkiv records are publicly readable entities; only the licensed payload is encrypted. The coordinator holds the demo encryption key, can decrypt records, and returns plaintext after settlement verification. This is a coordinator-trust model, not end-to-end encryption. The coordinator keeps unsettled quote state and rate limits in memory and is intentionally configured as one Railway replica. The indexer, RPC providers, coordinator availability, and query completeness are operational trust assumptions. The coordinator's signed selection is not a cryptographic proof that an indexer returned every matching record. No independent security audit is claimed.

## Three-minute demo sequence

1. **Publisher control (30–40 sec):** open the publisher console, connect a publisher wallet, show its owned dataset and on-chain policy/payout limits. Explain that publishers authorize the coordinator and choose what can be monetized. Avoid changing the live policy during the presentation.
2. **Discovery (30–40 sec):** show the marketplace discovering both publishers/datasets. Filter the shared `defi` category and request a quote. Explain that the coordinator checks Arkiv `$owner` and current Whitechain policy/grants, then presents deterministic record and payout allocations.
3. **Quote (30 sec):** show the four-record/two-allocation quote and 4 USDT total. Point out exact record counts, publisher payouts, expiry, and the exact-amount approval. A quote request alone spends no funds.
4. **Settlement (45–60 sec, only with buyer/operator authorization):** on Whitechain Sepolia, review the account and network. Confirm exact USDT approval if allowance is insufficient, wait for its receipt, submit one settlement, and wait for the successful receipt. Show the transaction in the Whitechain explorer and explain the publisher allocation events. Never initiate a second settlement as a recovery action.
5. **Delivery (30–40 sec):** show the buyer EIP-712 delivery signature prompt and delivered record count/hash verification. Explain that this message signature spends no funds and creates no transaction. If ordinary UI state is lost, use the recovery field with the confirmed settlement hash; the coordinator re-verifies receipt, manifest, buyer, publisher payouts, record ownership, and hashes before delivery.

If a live transaction is not appropriate, stop after quote review or use a recorded explorer receipt and clearly label it as the previously completed transaction. Do not represent local test output as live network activity.

## Operator preflight

- Check Railway `/health`, `/publishers`, and `/datasets`; health alone does not prove Arkiv or Whitechain availability.
- Open the deployed marketplace and verify its coordinator URL, contract address, and CORS. Verify the separate SDK demo deployment has `VITE_COORDINATOR_API_URL`, `VITE_QUERYMINT_SETTLEMENT_ADDRESS`, and `VITE_WHITECHAIN_RPC_URL` configured at build time.
- Confirm the two reused datasets remain active and discoverable. Do not republish or overwrite their Arkiv records. If adding publishers for a stress demo, use separate wallets and obtain each publisher's explicit confirmation for Whitechain setup and Arkiv writes.
- Check buyer USDT and WBT, buyer network, publisher WBT/tGLM only if onboarding is required, coordinator signer stability, and Arkiv access configuration without displaying secrets.
- Run one fresh quote and inspect the allocation sum, recipients, expiry, and capacity before allowing a buyer to approve. A successful approval is not settlement; a successful settlement receipt is not delivery until the signed recovery/delivery response arrives.
- Keep only one Railway replica while quote and rate-limit state are in memory. Keep a backup plan: known-good Vercel/Railway deployments and the confirmed transaction hash for delivery recovery.

See [deployment setup](deployment.md), [API and security limits](coordinator-api.md), [live evidence](live-validation.md), and [Arkiv schema](../arkiv/schema.md).

## Judge questions

**Why Arkiv?** Publisher-owned entities make the source and owner of each dataset/record inspectable and queryable, while Arkiv stores the discovery metadata and encrypted payloads. The coordinator checks the entity owner; tags alone are not treated as authorization.

**Why Whitechain?** The deployed contract makes each dataset's publisher policy enforceable at payment time: the coordinator cannot substitute recipients or exceed the publisher's caps. Settlement transfers the buyer's exact USDT total to the configured payout addresses.

**What does the buyer sign?** A normal ERC-20 approval and settlement transaction may require wallet confirmations. After a confirmed settlement, the buyer signs a scoped EIP-712 delivery authorization. That final signature is not a transaction and spends no funds.

**What if the coordinator restarts?** Unsettled quotes and quote-specific publisher approvals in memory are lost. After settlement, the buyer can reconstruct delivery from the chain transaction and a buyer signature, provided the stable coordinator signing key and Arkiv records remain available.

**What is not solved?** Coordinator-held decryption keys, indexer completeness/availability, finite Arkiv retention, single-replica availability, and the absence of an independent security audit are explicit limitations.
