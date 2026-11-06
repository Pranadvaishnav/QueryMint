import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { rabdi } from "@arkiv-network/sdk/chains";
import { whitechainSepolia } from "@querymint/shared";

export const config = createConfig({
  chains: [whitechainSepolia, rabdi({ accessKey: "" })],
  connectors: [injected()],
  transports: {
    [whitechainSepolia.id]: http(import.meta.env.VITE_WHITECHAIN_RPC_URL || undefined),
    [7794095]: http(import.meta.env.VITE_ARKIV_RPC_URL || undefined),
  },
});
