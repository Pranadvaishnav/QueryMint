# QueryMint public deployment guide

This guide prepares the existing web applications for Vercel and the coordinator for Railway. It does not deploy services or change the deployed Whitechain contract. The settlement network remains Whitechain Sepolia (chain 1874); Arkiv Rabdi (chain 7794095) remains the publisher-data store.

Current production endpoints reported/observed: coordinator `https://querymint-production.up.railway.app`, marketplace `https://web-rczjtwpqc-pranad.vercel.app`. The marketplace origin's CORS preflight and coordinator discovery were observed working on 2026-11-07. Hosting control panels and the SDK demo's production URL were not available for this verification. Re-check these before public demo day; do not infer Railway secret values from a successful API response.

## Deployable workspaces

| Workspace | Purpose | Build | Production start / output |
|---|---|---|---|
| `services/coordinator` | Coordinator HTTP API, Arkiv access and quote/settlement verification | `npm run build --workspace @querymint/coordinator` | `npm start --workspace @querymint/coordinator`; binds `0.0.0.0:$PORT` |
| `apps/web` | Marketplace and publisher console | `npm run build --workspace @querymint/web` | Static Vite output at `apps/web/dist` |
| `apps/demo` | Buyer SDK integration demo | `npm run build --workspace @querymint/demo` | Static Vite output at `apps/demo/dist` |

Root workspace uses npm workspaces and `package-lock.json` (lockfile v3). The root requires Node.js `>=22.10.0`; the development environment used for this readiness pass is Node 22.18.0 and npm 10.9.3. Use Node 22.18.x and npm 10.9.3 for reproducible builds. Run `npm ci` from the repository root. There are no existing Dockerfiles. The repository `.npmrc` sets `ignore-scripts=true`; retain this setting unless dependency installation/build behavior has been reviewed deliberately.

`packages/shared` and `packages/sdk` are workspace dependencies imported as TypeScript source. The coordinator therefore uses `tsx` at runtime; it is a production dependency. Its production start does not load the repository `.env`. Local `npm run dev --workspace @querymint/coordinator` continues to load root `.env`.

## Railway coordinator

Create a Railway service from the repository and use the repository root as the service root so npm can resolve all workspaces and the root lockfile.

- Build command: `npm ci && npm run build --workspace @querymint/coordinator`
- Start command: `npm start --workspace @querymint/coordinator`
- Healthcheck path: `/health`
- Set `NODE_ENV=production`. Railway supplies `PORT`; the coordinator prefers it and listens on `0.0.0.0`.
- Use one replica. Do not enable autoscaling or multiple replicas with the current in-memory quote and rate-limit stores.
- Configure `TRUST_PROXY_HOPS=1` for Railway. Behind that trusted proxy the rate limiter keys on Railway's injected `X-Real-IP` header; set it to `0` for direct/local hosting. Never enable this setting when the service is directly reachable without a trusted proxy.
- Set `COORDINATOR_CORS_ORIGINS` to the exact HTTPS origins of both Vercel projects, comma-separated, with no path or trailing slash. Example shape: `https://marketplace.example,https://sdk-demo.example`. Add preview origins only when they are intentionally allowed.
- Attach a Railway HTTPS domain or a custom domain and use that public base URL for both Vercel projects.

`/health` is a liveness response (`{"ok":true}`); it does not probe Whitechain or Arkiv. A green healthcheck means the process is serving, not that upstream services are available. Confirm dependencies with the read-only smoke checks below.

## Vercel projects

Create two Vercel projects pointing at the same repository. Keep **Root Directory** at the repository root so workspace installation and `package-lock.json` remain available. Configure each project separately:

| Setting | Marketplace / publisher console | SDK demo |
|---|---|---|
| Install command | `npm ci` | `npm ci` |
| Build command | `npm run build --workspace @querymint/web` | `npm run build --workspace @querymint/demo` |
| Output directory | `apps/web/dist` | `apps/demo/dist` |

The root `vercel.json` rewrites SPA routes to `index.html`. Define the applicable `VITE_` variables below in each Vercel project's production build environment, then redeploy after any change. Vite embeds these values in public JavaScript; only public URLs and public addresses belong there. The frontends use localhost API fallback only in Vite development; a production build without `VITE_COORDINATOR_API_URL` cannot reach the API and reports/disables that integration.

## Environment-variable inventory

Values are intentionally omitted. Create secrets directly in the Railway variable manager or local secret store; never place secrets in Vercel settings or variables prefixed `VITE_`.

### Railway coordinator

| Variable | Required | Secret? | Safe production default / notes |
|---|---:|---:|---|
| `NODE_ENV` | Yes | No | Set `production`. |
| `PORT` | Platform | No | Injected by Railway; app binds this port. Do not set a conflicting fixed port. |
| `WHITECHAIN_RPC_URL` | Yes | Usually no | HTTPS Whitechain Sepolia RPC. Protect provider credentials if embedded in URL; do not log it. Chain is configured as 1874 in shared code. |
| `QUERYMINT_SETTLEMENT_ADDRESS` | Yes | No | Existing deployed QueryMintSettlement address; must match the intended chain. |
| `QUERYMINT_DEPLOYMENT_BLOCK` | No | No | Set to deployment block `12366015` for bounded event scanning where configured; omission falls back to existing behavior. |
| `COORDINATOR_PRIVATE_KEY` | Yes | **Yes** | Stable signer key; store only in Railway secrets. It must continue deriving the same coordinator address after restarts for signed quote and delivery recovery verification. |
| `COORDINATOR_ADDRESS` | Recommended | No | Public address corresponding to `COORDINATOR_PRIVATE_KEY`; startup verifies a provided value. |
| `DEMO_ENCRYPTION_KEY` | Yes | **Yes** | Server-only symmetric key in the exact format accepted by current encryption code (32-byte hex). Keep stable; never expose to browser. |
| `ARKIV_ACCESS_KEY` | Strongly recommended | **Yes** | Server-only Arkiv Hub key. Without it the SDK uses the rate-limited public endpoint and startup warns. Never use a `VITE_` name. |
| `COORDINATOR_CORS_ORIGINS` | Yes in production | No | Exact Vercel HTTPS origins, comma-separated. No production localhost default. |
| `TRUST_PROXY_HOPS` | Recommended | No | `1` behind Railway's single proxy hop; `0` locally/direct. Bounded to 0–5. |
| `COORDINATOR_RATE_LIMIT_PER_MINUTE` | No | No | Defaults to `60` per client IP; valid range 1–10000. In-memory and per instance. |
| `QUOTE_TTL_SECONDS` | No | No | Defaults to 300 seconds. |

`COORDINATOR_PORT` is a local-development fallback only; Railway should supply `PORT`. `COORDINATOR_CORS_ORIGIN` remains as a compatibility fallback, but configure the plural variable in production.

### Vercel public build variables

| Variable | Web | Demo | Secret? | Required / notes |
|---|---:|---:|---:|---|
| `VITE_COORDINATOR_API_URL` | Yes | Yes | No | Public Railway HTTPS base URL (`https://querymint-production.up.railway.app`); set in both Vercel projects. The SDK demo disables quote actions when this value is absent. |
| `VITE_QUERYMINT_SETTLEMENT_ADDRESS` | Yes | Yes | No | Public address of the already deployed contract. |
| `VITE_WHITECHAIN_RPC_URL` | Yes | Yes | No* | Public Whitechain Sepolia RPC used by browser wallet/client reads. If provider URL contains a credential, treat it as public and use a restricted key. |
| `VITE_COORDINATOR_ADDRESS` | Yes | No | No | Public signer address used by publisher authorization flows. |
| `VITE_ARKIV_RPC_URL` | Yes | No | No* | Public Rabdi RPC for browser-side publishing. Must not contain an unrestricted secret credential. |

Never configure `COORDINATOR_PRIVATE_KEY`, publisher private keys, `DEMO_ENCRYPTION_KEY`, or `ARKIV_ACCESS_KEY` in Vercel. `WHITECHAIN_USDT_ADDRESS` is deployment-script configuration; runtime settlement uses the official address defined by shared source. `WHITECHAIN_CHAIN_ID` and `ARKIV_INDEXER_URL` are present in the example environment but are not coordinator runtime inputs. `DEPLOYER_PRIVATE_KEY`, `PUBLISHER_A_PRIVATE_KEY`, `PUBLISHER_B_PRIVATE_KEY`, and `WHITECHAIN_EXPLORER_API_KEY` are local deployment/test tooling only and are not production service variables.

## Persistence and security limits

- Quote manifests and pre-settlement publisher approvals are stored in coordinator process memory. Restarting the service or moving a request to another replica loses that state; buyers may need to request a fresh quote and publishers may need to repeat a quote-specific approval.
- The rate limiter is an in-memory IP map. It resets on restart and is not shared between replicas.
- Confirmed settlement and post-settlement delivery recovery are reconstructed from Whitechain transaction/receipt/log data and Arkiv records. The buyer's transaction hash plus EIP-712 delivery authorization is used for recovery; this path does not depend on the quote cache.
- A stable coordinator signing key is required. Rotating it can make older signed manifests/delivery recovery fail identity checks.
- A database is not required for the current single-replica hackathon deployment because settlement recovery is chain-derived. A persistent store becomes necessary if uninterrupted pre-settlement approvals/quotes, shared rate limits, or multi-replica operation become requirements.
- Arkiv and Whitechain are upstream dependencies; `/health` does not establish their availability. Arkiv public access can be rate limited, so configure `ARKIV_ACCESS_KEY`.
- CORS is browser policy, not authentication. API security still relies on typed signatures, chain/policy checks, ownership validation and request limits.
- The current rate limiter is process-local; for public traffic, monitor load and abuse and revisit edge-level limits before increasing replicas.

## First deployment sequence and smoke test

1. Deploy Railway first with its production variables, one replica, healthcheck `/health`, and a Railway/custom HTTPS domain.
2. Confirm Railway reports ready and `GET https://<coordinator-domain>/health` returns `{"ok":true}`. Check logs contain only startup event/port and no secret or payload values.
3. Create the two Vercel projects with the settings above. Set exact frontend variables, especially the deployed coordinator URL and contract address. Set Railway CORS to both final Vercel origins, then redeploy Railway if changed.
4. Open both Vercel sites and check browser devtools for successful `GET /publishers` and `GET /datasets` responses from the Railway domain. Confirm no request targets `localhost` and no CORS errors appear.
5. Connect a test wallet on Whitechain Sepolia. Use marketplace discovery and quote preview; do not settle unless a separately approved live test is intended. Verify the quote's chain, contract, allocations, amount and expiry.
6. In publisher console, confirm Rabdi connection and public publishing RPC, wallet chain prompts, coordinator address and onboarding references. For a controlled test, publish only approved test data and verify ownership/indexer discovery.
7. Run the SDK demo's quote/preview flow. Treat approval and settlement as real token transactions; require separate explicit operational authorization before using them.

For read-only upstream checks, query coordinator discovery endpoints and compare the contract address/network in the browser. Do not interpret an empty response as upstream health unless the coordinator returned a successful discovery response.

## Rollback

Vercel: use the project's Deployments view to promote the last known-good deployment. Railway: redeploy the previous successful deployment/revision and restore its known-good variables. Keep contract and coordinator signer configuration unchanged during rollback. If a bad frontend has reached production, roll it back first; if coordinator behavior is unsafe, stop or roll back the Railway service. Do not roll signer keys or contract configuration casually, because old signed quote and recovery verification depends on them.

No hosting deployment, transaction, publisher mutation, or dataset write is performed by this guide.
