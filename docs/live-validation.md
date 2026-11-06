# QueryMint live validation

Updated: 2026-11-06. This checklist separates read-only live RPC observations from mocked tests and state-changing operations. No transaction has been submitted, and no private or access key was printed or copied.

| Test name | Network | Actual result | Transaction/entity reference | Status | Remaining issue |
|---|---|---|---|---|---|
| RPC chain ID | Whitechain Sepolia | Read-only `eth_chainId` returned `0x752` (1874), matching configuration. | None | PASS | None for chain identification. |
| Required USDT bytecode | Whitechain Sepolia | `eth_getCode` at the required USDT address returned nonempty bytecode. | Token `0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7` | PASS | No state-changing token interaction has been run. |
| USDT decimals | Whitechain Sepolia | Read-only `decimals()` returned 6. | Token address above | PASS | Funded-wallet approval/transferFrom still unverified live. |
| USDT symbol | Whitechain Sepolia | Read-only `symbol()` returned `USDT`. | Token address above | PASS | None for read-only symbol call. |
| QueryMint settlement deployment lookup | Whitechain Sepolia | No `QUERYMINT_SETTLEMENT_ADDRESS` is configured, and the repository contains no deployment broadcast record. I therefore cannot identify a QueryMint deployment to check for bytecode. | None | BLOCKED | Supply/deploy a known settlement address; deployment needs explicit transaction approval. |
| Publisher A/B registrations and dataset policies | Whitechain Sepolia | Not attempted. No publisher wallets or settlement deployment address are configured. | None | BLOCKED | Two independent publisher wallets, deployed contract, and explicit approval for each state-changing setup transaction. |
| Buyer USDT balance | Whitechain Sepolia | Not checked; there is no buyer address or connected wallet. | None | BLOCKED | Funded buyer wallet/address and deployed settlement contract. |
| Exact USDT approval | Whitechain Sepolia | Not submitted. | None | BLOCKED | Buyer wallet connection and explicit approval for the `approve` transaction. |
| Settlement and two publisher payouts | Whitechain Sepolia | Not submitted. No approval or settlement transactions have been made. | None | BLOCKED | Funded buyer, deployed contract, registered publishers/policies/grants, and explicit approval for approval and settlement transactions. |
| RPC chain ID | Arkiv Rabdi | Read-only `eth_chainId` returned `0x76edaf` (7794095), matching configuration. | None | PASS | None for chain identification. |
| Two-publisher Arkiv roundtrip | Arkiv Rabdi | Not run. The local environment has no Arkiv access key or publisher A/B wallets. | No entity keys or transaction references exist yet. | BLOCKED | Configure credentials locally in `.env`; do not paste secrets into chat. |
| Owner, indexed filter, pagination, and payload hash verification | Arkiv Rabdi | Automated mocked helper tests pass; no live entities were available to query. | Mock test results only; not live references. | PENDING LIVE | Run the roundtrip with two independent publisher wallets and capture returned entity keys/tx hashes. |
| Signed quote against live publisher policies | Arkiv + Whitechain | Coordinator/API behavior is covered by mocked tests; no deployed contract or live Arkiv data is available. | No live query ID. | BLOCKED | Complete Arkiv roundtrip and deploy/configure the settlement contract and coordinator key. |
| Delivery blocked before settlement / succeeds after settlement | Whitechain integration | Both cases pass in mocked integration tests; no live transaction has been made. | Mock tests only; no live tx hash. | PENDING LIVE | Requires a deployed contract, funded buyer, actual quote, and explicit transaction approvals. |

## Deployment preparation

`QueryMintSettlement` is implemented and the Foundry contract suite passes locally. The intended constructor argument is the verified Whitechain Sepolia USDT address above; the deployment chain is 1874. The deployment artifact/source is ready, but there is no configured deployment wallet, funding balance, or known contract address. No signed transaction, deployment calldata broadcast, or deployment command using a private key has been run. I will request approval for the specific deployment transaction after a funded deployer wallet is connected; the private key must remain local and must not be pasted into chat.

## Credential and access audit

At inspection, `.env` did not exist and none of these variables were present in the process environment: `ARKIV_ACCESS_KEY`, `PUBLISHER_A_PRIVATE_KEY`, `PUBLISHER_B_PRIVATE_KEY`, `DEMO_ENCRYPTION_KEY`, `COORDINATOR_PRIVATE_KEY`, `COORDINATOR_ADDRESS`, `QUERYMINT_SETTLEMENT_ADDRESS`, `WHITECHAIN_RPC_URL`, or `ARKIV_RPC_URL`. The example file contains public RPC defaults and USDT address only. No wallet application/session was connected, so buyer funding and balances cannot be determined.

## State-changing operation gate

Before any state-changing operation, request a separate explicit approval identifying the exact transaction(s), chain, contract address, function and arguments. This includes deployment, publisher registration, dataset registration/policy updates, coordinator grants, USDT approval, and settlement. Credentials should remain in the local environment; never send them through chat or commit `.env`.
