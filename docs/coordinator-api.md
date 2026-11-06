# QueryMint coordinator API

The coordinator listens on `127.0.0.1:${COORDINATOR_PORT}` by default. It requires server-side Arkiv, Whitechain, encryption, and coordinator-signing configuration; none of these secrets belong in the browser. Set `COORDINATOR_CORS_ORIGIN` to the exact web origin.

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
| `POST /query/:queryId/deliver` | Accepts `{ transactionHash, buyer }`; checks transaction sender/target, successful receipt, matching `QuerySettled` fields, and on-chain replay state before releasing payloads. Duplicate delivery requests by the same buyer are idempotent. |
| `GET /publishers/:address/earnings` | Sums `AllocationPaid` logs for the publisher. Set `QUERYMINT_DEPLOYMENT_BLOCK` to avoid provider-wide log-range limits. |

Amounts and EIP-712 integer fields cross JSON as base-10 strings. The buyer SDK revives manifest integer values to `bigint` before ABI encoding. Prices always come from current Whitechain policy storage; Arkiv price fields are discovery metadata only.

## Publisher approval flow

When an allocation meets its on-chain `publisherSignatureThreshold`, the quote includes the `PublisherApproval` typed-data domain and message. The publisher must sign with its registered wallet and submit the signature to `/publisher-approval`. The coordinator recovers and checks the signer. The SDK refreshes the quote before payment and refuses to settle while required signatures are missing. The publisher signature does not alter the coordinator-signed manifest digest because the Solidity contract deliberately excludes the signature bytes from the allocation struct hash.

## Operational limits and trust

- Query filtering currently supports indexed `category`; result limit is 1–50, with at most 10 dataset allocations.
- Query manifests and encrypted payload delivery state are held in process memory. Restarting or running multiple coordinator instances loses or partitions pending quotes. This is a single-instance hackathon design, not durable production storage.
- A 60-request-per-minute in-memory IP limiter is a basic abuse guard, not a distributed rate limiter.
- The coordinator decrypts records server-side to verify content hashes. It only returns previews before payment. Licensed plaintext is returned after settlement verification; coordinator key custody and uptime remain trust assumptions.
- Publisher authorization and payout arithmetic are enforced again by the contract. Arkiv ownership checks establish entity attribution, not query completeness.
- Automated tests use mocked Arkiv and Whitechain clients. Live Rabdi and Whitechain operations remain pending until valid `.env` configuration and funded test wallets are available.
