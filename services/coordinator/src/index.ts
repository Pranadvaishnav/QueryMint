import { createPublicClient } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { http, createPublicClient as createViemPublicClient, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { whitechainSepolia } from "@querymint/shared";
import { createCoordinatorApp } from "./api.js";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

async function main(): Promise<void> {
  const arkivChain = rabdi({ accessKey: env("ARKIV_ACCESS_KEY") });
  const arkivClient = createPublicClient({ chain: arkivChain, transport: http(process.env.ARKIV_RPC_URL) });
  const whitechainClient = createViemPublicClient({ chain: whitechainSepolia, transport: http(env("WHITECHAIN_RPC_URL")) });
  const coordinatorAccount = privateKeyToAccount(env("COORDINATOR_PRIVATE_KEY") as Hex);
  const configuredAddress = process.env.COORDINATOR_ADDRESS;
  if (configuredAddress && configuredAddress.toLowerCase() !== coordinatorAccount.address.toLowerCase()) {
    throw new Error("COORDINATOR_ADDRESS does not match COORDINATOR_PRIVATE_KEY");
  }
  const settlementAddress = env("QUERYMINT_SETTLEMENT_ADDRESS") as Address;
  const encryptionKey = env("DEMO_ENCRYPTION_KEY") as Hex;
  const app = createCoordinatorApp({ arkivClient, whitechainClient, coordinatorAccount, settlementAddress, encryptionKey,
    ...(process.env.QUERYMINT_DEPLOYMENT_BLOCK ? { deploymentBlock: BigInt(process.env.QUERYMINT_DEPLOYMENT_BLOCK) } : {}),
    quoteTtlSeconds: Number(process.env.QUOTE_TTL_SECONDS ?? "300"),
    corsOrigin: process.env.COORDINATOR_CORS_ORIGIN ?? "http://localhost:5173",
  });
  const port = Number(process.env.COORDINATOR_PORT ?? "3001");
  app.listen(port, "127.0.0.1", () => console.log(`QueryMint coordinator listening on http://127.0.0.1:${port}`));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Coordinator startup failed");
  process.exitCode = 1;
});
