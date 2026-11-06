import { createPublicClient, createWalletClient, ExpirationTime } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { and, asc, eq, gt } from "@arkiv-network/sdk/query";
import { addr, bytes, key, u256 } from "@arkiv-network/sdk/schema";
import { hexToBytes, http, keccak256, toBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { contentHash, decryptPayload, encryptPayload, encryptedPayloadHash, stableJson } from "../src/arkiv/encryption.js";
import { DatasetManifest, DatasetRecord, PublisherProfile } from "../src/arkiv/schema.js";

const MAX_PAGES = 100;
const PAGE_SIZE = 2; // Small on purpose so the demo exercises the documented keyset paging path.
const RETENTION = ExpirationTime.fromDays(30);

interface DemoRecord {
  label: string;
  preview: string;
  payload: Record<string, string | number>;
}

interface DemoPublisher {
  name: string;
  slug: string;
  payout: Address;
  records: DemoRecord[];
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

async function main(): Promise<void> {
  // The SDK supports the public Rabdi endpoint with an empty key (rate limited).
  const accessKey = process.env.ARKIV_ACCESS_KEY ?? "";
  const encryptionKey = required("DEMO_ENCRYPTION_KEY") as Hex;
  const accountA = privateKeyToAccount(required("PUBLISHER_A_PRIVATE_KEY") as Hex);
  const accountB = privateKeyToAccount(required("PUBLISHER_B_PRIVATE_KEY") as Hex);
  const chain = rabdi({ accessKey });
  const publicClient = createPublicClient({ chain, transport: http() });
  const walletA = createWalletClient({ chain, transport: http(), account: accountA });
  const walletB = createWalletClient({ chain, transport: http(), account: accountB });

  const publishers: DemoPublisher[] = [
    {
      name: "QueryMint Synthetic Liquidity Publisher",
      slug: "synthetic-liquidity-v1",
      payout: accountA.address,
      records: [
        {
          label: "Synthetic ETH-USDC depth",
          preview: "Synthetic demo observation for an ETH-USDC pool.",
          payload: { sampleType: "synthetic", pool: "ETH-USDC", liquidityUsd: 12_450_000, observedAt: "2026-11-06T00:00:00Z" },
        },
        {
          label: "Synthetic WBTC-USDC depth",
          preview: "Synthetic demo observation for a WBTC-USDC pool.",
          payload: { sampleType: "synthetic", pool: "WBTC-USDC", liquidityUsd: 8_125_000, observedAt: "2026-11-06T00:00:00Z" },
        },
      ],
    },
    {
      name: "QueryMint Synthetic Lending Publisher",
      slug: "synthetic-lending-v1",
      payout: accountB.address,
      records: [
        {
          label: "Synthetic ETH utilization",
          preview: "Synthetic demo utilization observation for a lending pool.",
          payload: { sampleType: "synthetic", market: "ETH", utilizationBps: 7421, observedAt: "2026-11-06T00:00:00Z" },
        },
        {
          label: "Synthetic USDC utilization",
          preview: "Synthetic demo utilization observation for a lending pool.",
          payload: { sampleType: "synthetic", market: "USDC", utilizationBps: 6812, observedAt: "2026-11-06T00:00:00Z" },
        },
      ],
    },
  ];

  const accounts = [accountA, accountB];
  const writers = [walletA, walletB];
  const publisherForDataset = new Map<string, Address>();
  const writtenRecords: Array<{ owner: Address; contentHash: Hex; payloadHash: Hex }> = [];

  for (let i = 0; i < publishers.length; i++) {
    const publisher = publishers[i]!;
    const account = accounts[i]!;
    const wallet = writers[i]!;
    const datasetId = keccak256(toBytes(`${account.address.toLowerCase()}:querymint:${publisher.slug}`));
    publisherForDataset.set(datasetId.toLowerCase(), account.address);

    const profile = await wallet.createEntity(
      PublisherProfile,
      {
        wallet: addr(account.address),
        status: "active",
        displayName: publisher.name,
        payoutAddress: addr(publisher.payout),
      },
      { expiration: RETENTION },
    );

    const manifest = await wallet.createEntity(
      DatasetManifest,
      {
        datasetId: key(datasetId),
        publisher: addr(account.address),
        category: "defi",
        status: "active",
        title: publisher.name,
        description: "Synthetic hackathon data. Values are generated for the QueryMint demo and are not live market data.",
        schemaVersion: "querymint.record.v1",
        pricePerRecord: u256(1_000_000n),
        maxRecordsPerQuery: u256(50n),
      },
      { expiration: RETENTION },
    );

    console.log(JSON.stringify({
      publisher: account.address,
      profileEntityKey: profile.entityKey,
      profileTxHash: profile.txHash,
      datasetId,
      manifestEntityKey: manifest.entityKey,
      manifestTxHash: manifest.txHash,
    }));

    for (const record of publisher.records) {
      const plaintext = stableJson(record.payload);
      const encrypted = encryptPayload(encryptionKey, plaintext);
      const hash = contentHash(plaintext);
      const encryptedHash = encryptedPayloadHash(encrypted);
      const created = await wallet.createEntity(
        DatasetRecord,
        {
          datasetId: key(datasetId),
          category: "defi",
          contentHash: key(hash),
          payloadHash: key(encryptedHash),
          label: record.label,
          preview: record.preview,
          encryptedPayload: bytes(encrypted),
        },
        { expiration: RETENTION },
      );
      writtenRecords.push({ owner: account.address, contentHash: hash, payloadHash: encryptedHash });
      console.log(JSON.stringify({ owner: account.address, entityKey: created.entityKey, txHash: created.txHash, datasetId }));
    }
  }

  const seen = new Set<string>();
  const retrieved: Array<{ entityKey: Hex; owner: Address; datasetId: Hex; contentHash: Hex }> = [];
  let cursor: Hex | undefined;
  for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex++) {
    const predicate = cursor
      ? and(eq("category", "defi"), gt("$key", key(cursor)))
      : eq("category", "defi");
    const page = await publicClient
      .select({
        $key: true,
        $owner: true,
        datasetId: true,
        contentHash: true,
        payloadHash: true,
        encryptedPayload: true,
      })
      .from(DatasetRecord, { onMismatch: "throw" })
      .where(predicate)
      .orderBy(asc("$key"))
      .limit(PAGE_SIZE)
      .fetch();

    if (page.entities.length === 0) break;
    for (const row of page.entities) {
      cursor = row.$key;
      const expectedOwner = publisherForDataset.get(row.datasetId.value.toLowerCase());
      if (!expectedOwner || row.$owner.toLowerCase() !== expectedOwner.toLowerCase()) {
        throw new Error(`Arkiv owner mismatch for entity ${row.$key}`);
      }
      const hash = row.contentHash.value;
      const encrypted = row.encryptedPayload.value;
      const actualPayloadHash = keccak256(hexToBytes(encrypted));
      if (actualPayloadHash.toLowerCase() !== row.payloadHash.value.toLowerCase()) {
        throw new Error(`Encrypted payload hash mismatch for entity ${row.$key}`);
      }
      const plaintext = decryptPayload(encryptionKey, encrypted);
      if (contentHash(plaintext).toLowerCase() !== hash.toLowerCase()) {
        throw new Error(`Decrypted record content hash mismatch for entity ${row.$key}`);
      }
      if (seen.has(hash.toLowerCase())) continue;
      seen.add(hash.toLowerCase());
      retrieved.push({ entityKey: row.$key, owner: row.$owner, datasetId: row.datasetId.value, contentHash: hash });
    }
    if (page.entities.length < PAGE_SIZE) break;
  }

  if (retrieved.length !== writtenRecords.length) {
    throw new Error(`Expected ${writtenRecords.length} unique demo records, received ${retrieved.length}`);
  }
  console.log(JSON.stringify({
    query: { category: "defi", orderBy: "$key asc", pageSize: PAGE_SIZE, pagination: "keyset gt($key, key(lastKey))" },
    returnedUniqueRecords: retrieved.length,
    owners: [...new Set(retrieved.map((record) => record.owner))],
    records: retrieved,
  }, null, 2));
}

main().catch((error: unknown) => {
  const secret = process.env.ARKIV_ACCESS_KEY;
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(secret ? message.replaceAll(secret, "[redacted access key]") : message);
  process.exitCode = 1;
});
