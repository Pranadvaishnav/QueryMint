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
  const production = process.env.NODE_ENV === "production";
  const arkivAccessKey = process.env.ARKIV_ACCESS_KEY?.trim() ?? "";
  if (!arkivAccessKey) {
    console.warn("ARKIV_ACCESS_KEY is not configured; Rabdi requests will use the rate-limited public endpoint.");
  }
  const arkivChain = rabdi({ accessKey: arkivAccessKey });
  // http() uses the URL built by the SDK, including its access-key path segment.
  // Supplying the bare ARKIV_RPC_URL here would override and discard that segment.
  const arkivClient = createPublicClient({
    chain: arkivChain,
    transport: http(undefined, { timeout: 6_000, retryCount: 0 }),
  });
  const whitechainClient = createViemPublicClient({ chain: whitechainSepolia, transport: http(env("WHITECHAIN_RPC_URL")) });
  const coordinatorAccount = privateKeyToAccount(env("COORDINATOR_PRIVATE_KEY") as Hex);
  const configuredAddress = process.env.COORDINATOR_ADDRESS;
  if (configuredAddress && configuredAddress.toLowerCase() !== coordinatorAccount.address.toLowerCase()) {
    throw new Error("COORDINATOR_ADDRESS does not match COORDINATOR_PRIVATE_KEY");
  }
  const settlementAddress = env("QUERYMINT_SETTLEMENT_ADDRESS") as Address;
  const encryptionKey = env("DEMO_ENCRYPTION_KEY") as Hex;
  const configuredOrigins = (process.env.COORDINATOR_CORS_ORIGINS ?? process.env.COORDINATOR_CORS_ORIGIN ?? (production ? "" : "http://localhost:5173,http://localhost:5174"))
    .split(",").map((origin) => origin.trim()).filter(Boolean);
  if (production && configuredOrigins.length === 0) throw new Error("COORDINATOR_CORS_ORIGINS is required in production");
  const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? "0");
  if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0 || trustProxyHops > 5) throw new Error("TRUST_PROXY_HOPS must be an integer from 0 to 5");
  const rateLimitPerMinute = Number(process.env.COORDINATOR_RATE_LIMIT_PER_MINUTE ?? "60");
  if (!Number.isInteger(rateLimitPerMinute) || rateLimitPerMinute < 1 || rateLimitPerMinute > 10_000) throw new Error("COORDINATOR_RATE_LIMIT_PER_MINUTE must be an integer from 1 to 10000");
  const app = createCoordinatorApp({ arkivClient, whitechainClient, coordinatorAccount, settlementAddress, encryptionKey,
    ...(process.env.QUERYMINT_DEPLOYMENT_BLOCK ? { deploymentBlock: BigInt(process.env.QUERYMINT_DEPLOYMENT_BLOCK) } : {}),
    quoteTtlSeconds: Number(process.env.QUOTE_TTL_SECONDS ?? "300"),
    corsOrigins: configuredOrigins,
    trustProxyHops,
    rateLimitPerMinute,
  });
  const port = Number(process.env.PORT ?? process.env.COORDINATOR_PORT ?? "3001");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be a valid TCP port");
  const server = app.listen(port, "0.0.0.0", () => console.info(JSON.stringify({ event: "coordinator_listening", port })));
  const shutdown = (signal: string) => {
    console.info(JSON.stringify({ event: "coordinator_shutdown", signal }));
    server.close((error) => { if (error) process.exitCode = 1; });
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Coordinator startup failed";
  console.error(JSON.stringify({ event: "coordinator_startup_failed", reason: message.replace(/https?:\/\/[^\s)]+/gi, "upstream service") }));
  process.exitCode = 1;
});
