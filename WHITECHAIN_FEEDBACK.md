# Whitechain Sepolia integration notes

## Verified

- Chain ID: `1874`.
- USDT address: `0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7`.
- The address has deployed bytecode and is a proxy. The EIP-1967 implementation slot resolved to `0x26425662d126412128967ecf0a02ec48573026f7` at the time of inspection.
- Read-only calls returned `decimals() = 6`, `symbol() = USDT`, and `balanceOf(0x0000000000000000000000000000000000000000) = 0`.
- `approve()` returned true in `eth_call` (this checks call behavior only; it does not persist an allowance).

## Not verified

No funded wallet was available. No state-changing approval, `transferFrom`, publisher payout, settlement deployment, or explorer verification has been performed. Contract tests use a local mock ERC-20 and do not establish that the deployed token has the same runtime behavior. The contract uses OpenZeppelin `SafeERC20` to handle standard return values safely.

## Suggested feedback

For hackathon integrations, publish a canonical testnet token page that states proxy/implementation details, decimals, faucet availability, and a minimal `approve` + `transferFrom` example. This is a developer suggestion; no testnet transaction failure is being reported.
