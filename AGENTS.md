# QueryMint project instructions

## Product architecture
- Arkiv Rabdi (chain ID 7794095) stores publisher-owned profiles, dataset manifests, records, and query receipts. Records are public; encrypt licensed payloads before writing.
- Whitechain Sepolia (chain ID 1874) is the source of truth for publisher policy, coordinator authorization, USDT collection, and payouts.
- The coordinator queries Arkiv, checks entity owners against dataset publishers registered on Whitechain, deduplicates content hashes, signs EIP-712 query manifests, and releases encrypted content only after confirmed settlement.
- The buyer reviews record attribution and the complete USDT payout breakdown before signing.
- Never describe a coordinator signature or Merkle root as proof that every matching Arkiv record was returned.

## Verified network settings
- Whitechain Sepolia RPC: `https://rpc.testnet.whitechain.io`
- Whitechain Sepolia explorer: `https://explorer.testnet.whitechain.io/`
- Whitechain Sepolia USDT: `0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7` (proxy; read-only RPC returned `decimals() = 6`, `symbol() = USDT`)
- Arkiv Rabdi RPC: `https://rpc.rabdi.db-chain.testnet.arkiv.network`
- Arkiv Rabdi chain ID: `7794095`; explorer: `https://rabdi.explorer.arkiv.network/`

## Coding and security rules
- Use TypeScript across web, coordinator, SDK, and shared packages; keep token values as bigint/integer base units.
- Pin npm dependencies and commit `package-lock.json`.
- Keep secrets in environment variables; never commit `.env`, keys, or access tokens.
- Treat Arkiv schemas/tags as query organization, not publisher authentication. Verify each returned entity owner.
- Enforce recipient, rate, record-count, total-payout, expiry, nonce, and replay constraints in the settlement contract.
- Use fixed USDT configuration, EIP-712 domain separation, SafeERC20, and reentrancy protection.
- Do not claim delivery refunds unless the contract can enforce the condition.
- Do not report tests, RPC transactions, or deployments as successful unless actually observed.

## Current milestone
Build and validate the first vertical slice: publisher policy and coordinator grant, Arkiv write/query, signed quote, exact USDT settlement, multiple publisher payouts, and receipt. Do not deploy without explicit wallet access and verified local tests.
