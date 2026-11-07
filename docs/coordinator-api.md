# QueryMint coordinator API

The coordinator listens on `127.0.0.1:${COORDINATOR_PORT}` by default for local development and binds `0.0.0.0:$PORT` in production. Production is currently reported at `https://querymint-production.up.railway.app`; a read-only check on 2026-11-07 observed `/health`, `/publishers`, `/datasets`, and signed quote generation succeeding. This is a point-in-time observation, not an uptime guarantee. The coordinator requires server-side Arkiv, Whitechain, encryption, and coordinator-signing configuration; none of these secrets belong in the browser. Set `COORDINATOR_CORS_ORIGINS` to exact web origins.

For local startup, copy `.env.example` to `.env`, fill in the coordinator key, Arkiv access key, 32-byte demo encryption key, Whitechain RPC, and deployed settlement address, then run `npm run dev:coordinator` from the repository root. The `/health` route confirms the process is serving; network readiness is established by actual route calls. Without a settlement deployment address and Arkiv key, the app can be exercised through the injected mocked clients in the test suite, but not against the real networks.

## Routes

| Method and path | Behavior |
|---|---|
| `GET /health` | Process health only; does not claim network connectivity. |
| `GET /publishers` | Reads Arkiv publisher profiles; checks Arkiv owner and current Whitechain registration/payout. |
| `GET /datasets` | Reads active Arkiv dataset manifests and checks owner, on-chain publisher, policy, coordinator grant, and expiry. |
| `GET /datasets/:datasetId` | Same checks for one bytes32 dataset ID. |
| `POST /query/quote` | Accepts `{ buyer, where: { category }, limit }`; returns previews, publisher payout breakdown, a coordinator EIP-712 signature, and optional publisher approval requests. |
| `GET /query/:queryId/quote` | Returns the latest manifest with any verified publisher approvals applied. |
| `POST /query/:queryId/publisher-approval` | Accepts `{ datasetId, signature }`; verifies the publisher typed-data signature before updating the cached quote. |
| `GET /query/:queryId/status` | Reads `settledQueries` and matching `QuerySettled` events from Whitechain. |
| `POST /query/:queryId/deliver` | Accepts `{ transactionHash, buyer, buyerSignature }`; verifies a buyer EIP-712 delivery authorization, successful settlement receipt, signed manifest digest, every `AllocationPaid` and USDT payout transfer, and exact Arkiv owner/content hashes before releasing plaintext. |
| `GET /publishers/:address/earnings` | Sums `AllocationPaid` logs for the publisher. Set `QUERYMINT_DEPLOYMENT_BLOCK` to avoid provider-wide log-range limits. |

Amounts and EIP-712 integer fields cross JSON as base-10 strings. The buyer SDK revives manifest integer values to `bigint` before ABI encoding. Prices always come from current Whitechain policy storage; Arkiv price fields are discovery metadata only.

For delivery, the buyer signs `DeliveryAuthorization(bytes32 queryId,bytes32 transactionHash,address buyer)` in the `QueryMint` / `1` EIP-712 domain for chain ID `1874` and the settlement contract. This signature authorizes only the matching buyer, query, and confirmed transaction; it does not submit a transaction or transfer funds.

## Publisher approval flow

When an allocation meets its on-chain `publisherSignatureThreshold`, the quote includes the `PublisherApproval` typed-data domain and message. The publisher must sign with its registered wallet and submit the signature to `/publisher-approval`. The coordinator recovers and checks the signer. The SDK refreshes the quote before payment and refuses to settle while required signatures are missing. The publisher signature does not alter the coordinator-signed manifest digest because the Solidity contract deliberately excludes the signature bytes from the allocation struct hash.

## Operational limits and trust

- Query filtering currently supports indexed `category`; payable result count is at most 50 records and 10 dataset allocations.
- Unsettled quote previews and publisher approvals are held in process memory. Restart before settlement loses them; the buyer must request a fresh quote and, where required, obtain publisher approvals again. An existing USDT allowance remains an ERC-20 state change, so the SDK checks the current allowance and does not request an unnecessary second approval.
- After settlement, delivery recovery does not depend on quote memory: the coordinator decodes the manifest from the supplied transaction calldata, verifies the successful receipt, coordinator signature, settlement event, every allocation payout event and matching USDT transfer, then looks up the exact Arkiv records. It checks unique dataset/hash lookup, Arkiv `$owner`, encrypted payload hash and decrypted content hash. Any missing, ambiguous, altered or wrongly owned record fails closed. Recovery is read-only; it cannot create another settlement or publisher payout. If the delivery response is lost or the process restarts, the buyer can repeat the signed request; the coordinator reconstructs and returns the records again. The `duplicateRequest` marker is only an in-memory optimization and is not a durable delivery ledger.
- A 60-request-per-minute in-memory IP limiter is a basic abuse guard, not a distributed rate limiter.
- The coordinator receives plaintext from the publisher browser at the encryption endpoint, encrypts it server-side, and retains the demo AES-256-GCM key in its server environment. It decrypts records server-side to verify content hashes and returns licensed plaintext after settlement verification and a buyer EIP-712 signature. This is not publisher-to-buyer end-to-end encryption; coordinator key custody, confidentiality, availability and correct operation are trust assumptions. Use synthetic/demo data only.
- Arkiv ownership establishes entity attribution, not confidentiality: Arkiv entities and metadata may be publicly readable. Encrypted payload confidentiality depends on the coordinator-controlled demo key. Records have finite Arkiv retention; expired or unavailable entities cannot be delivered even if payment settled. Buyers should recover promptly and retain their delivered data securely.
- The coordinator-signed manifest attests to the coordinator's selected query result. Neither the manifest nor settlement proves that Arkiv indexing returned every eligible record. Bounded pagination detects its configured safety cap and fails instead of issuing an apparently complete quote, but it is not a cryptographic proof of query completeness.
- Publisher authorization and payout arithmetic are enforced by the contract at settlement. Recovery verifies the settlement receipt and payout events emitted by the configured contract and verifies record ownership/content hashes again. The code review and automated tests do not constitute an independent security audit or establish live RPC/indexer correctness.
- Query filtering currently supports indexed `category`. The browser offers result limits of 5â€“50; the API accepts 1â€“1000 for diagnostics, but payable quotes remain bounded by the deployed contract's 10 dataset allocations and 50 records. The coordinator reports the complete authorized `totalMatchingRecords` separately from `eligibleRecords`. When a buyer's selected result limit is lower than the complete match count, records are selected deterministically by ascending dataset ID and content hash.
- Publisher, dataset, and record scans use ascending Arkiv entity-key pagination with 100 entities per page and a 20-page safety cap. A full cap is reported as incomplete (HTTP 503 with `INCOMPLETE_RESULTS`) and never produces a payable quote or a successful partial discovery list. Each page uses the existing bounded retry policy for transient 429/5xx failures; exhausted retries return an error instead of partial results.
- Duplicate plaintext content hashes are rejected, both within one dataset and across datasets. The quote is not produced because the deployed contract requires unique hashes across all allocations. Record hashes in each allocation and dataset allocations are sorted in ascending numeric order before signing, matching the contract's validation and result-root rules.
- Automated tests use mocked Arkiv and Whitechain clients. Live Rabdi and Whitechain operations remain pending until valid `.env` configuration and funded test wallets are available.
