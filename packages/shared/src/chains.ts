import { defineChain, type Chain } from "viem";

export const whitechainSepolia: Chain = defineChain({
  id: 1874,
  name: "Whitechain Sepolia",
  nativeCurrency: { name: "WhiteBIT Token", symbol: "WBT", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.whitechain.io"] } },
  blockExplorers: { default: { name: "Whitechain Explorer", url: "https://explorer.testnet.whitechain.io" } },
  testnet: true,
});

export const arkivRabdi: Chain = defineChain({
  id: 7_794_095,
  name: "Arkiv Rabdi",
  nativeCurrency: { name: "Test GLM", symbol: "tGLM", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.rabdi.db-chain.testnet.arkiv.network"] } },
  blockExplorers: { default: { name: "Arkiv Explorer", url: "https://rabdi.explorer.arkiv.network" } },
  testnet: true,
});

export const WHITECHAIN_USDT = "0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7" as const;
