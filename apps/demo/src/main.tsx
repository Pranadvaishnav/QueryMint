import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { whitechainSepolia } from "@querymint/shared";
import { App } from "./App";
import "./styles.css";

const config = createConfig({ chains: [whitechainSepolia], connectors: [injected()], transports: { [whitechainSepolia.id]: http(import.meta.env.VITE_WHITECHAIN_RPC_URL || undefined) } });
const queryClient = new QueryClient();
createRoot(document.getElementById("root")!).render(<React.StrictMode><WagmiProvider config={config}><QueryClientProvider client={queryClient}><App /></QueryClientProvider></WagmiProvider></React.StrictMode>);
