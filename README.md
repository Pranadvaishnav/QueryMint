# QueryMint

QueryMint lets a buyer query publisher-owned Arkiv datasets in one request and settle the resulting per-publisher payouts in USDT on Whitechain Sepolia.

## Networks
- Whitechain Sepolia: chain ID `1874`; USDT `0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7`.
- Arkiv Rabdi: chain ID `7794095`.

## Status

The local coordinator milestone adds Arkiv-backed publisher/dataset discovery, an owner-checked query and signed quote endpoint, publisher approval handoff for high-value allocations, settlement status verification, post-settlement delivery, event-derived earnings, and matching buyer SDK routes. The existing publisher authorization and settlement contract, Foundry tests, shared EIP-712 helpers, Arkiv schemas/encryption/query logic, and roundtrip writer are preserved. API and Arkiv-helper tests use mocks; see [WHITECHAIN_FEEDBACK.md](WHITECHAIN_FEEDBACK.md) for the boundary between read-only token verification and unperformed state-changing checks.

The real testnet vertical slice is not yet complete: the Arkiv roundtrip has not been run, there is no deployed settlement address, and no live USDT settlement has been made. The publisher/buyer user interfaces are pending. No live transaction is represented as successful.

## Buyer SDK shape

```ts
const qm = createQueryMint({ apiUrl, settlementAddress, walletClient, publicClient });
const quote = await qm.quote({ where: { category: "defi" }, limit: 20 });
console.table(quote.breakdown); // review publisher payouts before prompting the wallet
const result = await qm.pay({ quote });
console.log(result.records, result.transactionHash);
```

`quote()` uses the connected wallet as the buyer. `pay()` refreshes the signed quote, refuses to proceed while a required publisher approval is missing, approves the exact base-unit amount, submits settlement, waits for the mined receipt, then requests delivery. A delivery/API failure after settlement is surfaced with the settlement transaction hash; it is not silently described as a refund. See [coordinator API documentation](docs/coordinator-api.md).

## Current milestone checklist

- [x] Workspace, pinned dependencies, TypeScript workspaces, and architecture/security instructions.
- [x] Whitechain USDT read-only verification and explicit live-transfer limitations.
- [x] Arkiv SDK 1.0.1 capability review, schemas, encrypted record model, owner-checking query path, and writer/query roundtrip script.
- [x] Solidity authorization/settlement contract and local tests for limits, signatures, replay, payouts, and failure cases.
- [x] Direct local settlement gas measurements for 1/1, 2/4, and 5/50 publisher/record batches.
- [x] Buyer SDK API surface for quote, exact approval, settlement, and post-receipt delivery.
- [x] Coordinator discovery, quote, signature, status, delivery, and event-derived earnings endpoints; mocked coordinator/Arkiv tests.
- [ ] Buyer and publisher apps.
- [ ] Real Arkiv two-publisher write/query and live Whitechain settlement (requires Arkiv access key and funded test wallets).
- [ ] Deployment, explorer links, lifecycle receipts, and demo video script.

AI usage disclosure: AI assistance was used for architecture drafting and code authoring. All observed network behavior and test outcomes are described separately from unverified work.

See [AGENTS.md](AGENTS.md) for the architecture and security constraints. See `/arkiv/` for schema and judging documentation.
