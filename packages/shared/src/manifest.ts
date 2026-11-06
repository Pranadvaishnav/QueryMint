import {
  concat,
  encodeAbiParameters,
  hashTypedData,
  keccak256,
  toBytes,
  type Address,
  type Hex,
} from "viem";

export interface Allocation {
  publisher: Address;
  datasetId: Hex;
  publisherNonce: bigint;
  policyNonce: bigint;
  grantNonce: bigint;
  recordCount: number;
  recordHashes: readonly Hex[];
  payoutAmount: bigint;
  publisherSignature: Hex;
}

export interface QueryManifest {
  queryId: Hex;
  buyer: Address;
  coordinator: Address;
  token: Address;
  totalAmount: bigint;
  deadline: bigint;
  resultRoot: Hex;
  allocations: readonly Allocation[];
  coordinatorSignature: Hex;
}

export interface Eip712Domain {
  name: "QueryMint";
  version: "1";
  chainId: 1874;
  verifyingContract: Address;
}

export const allocationTypes = {
  Allocation: [
    { name: "publisher", type: "address" },
    { name: "datasetId", type: "bytes32" },
    { name: "publisherNonce", type: "uint64" },
    { name: "policyNonce", type: "uint64" },
    { name: "grantNonce", type: "uint64" },
    { name: "recordCount", type: "uint32" },
    { name: "recordHashesHash", type: "bytes32" },
    { name: "payoutAmount", type: "uint128" },
  ],
} as const;

export const queryManifestTypes = {
  QueryManifest: [
    { name: "queryId", type: "bytes32" },
    { name: "buyer", type: "address" },
    { name: "coordinator", type: "address" },
    { name: "token", type: "address" },
    { name: "totalAmount", type: "uint128" },
    { name: "deadline", type: "uint64" },
    { name: "resultRoot", type: "bytes32" },
    { name: "allocationsHash", type: "bytes32" },
  ],
} as const;

export const publisherApprovalTypes = {
  PublisherApproval: [
    { name: "queryId", type: "bytes32" },
    { name: "publisher", type: "address" },
    { name: "datasetId", type: "bytes32" },
    { name: "publisherNonce", type: "uint64" },
    { name: "policyNonce", type: "uint64" },
    { name: "grantNonce", type: "uint64" },
    { name: "recordCount", type: "uint32" },
    { name: "recordHashesHash", type: "bytes32" },
    { name: "payoutAmount", type: "uint128" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

const allocationTypeHash = keccak256(toBytes(
  "Allocation(address publisher,bytes32 datasetId,uint64 publisherNonce,uint64 policyNonce,uint64 grantNonce,uint32 recordCount,bytes32 recordHashesHash,uint128 payoutAmount)",
));

export function hashRecordHashes(recordHashes: readonly Hex[]): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32[]" }], [recordHashes]));
}

export function hashAllocation(domain: Eip712Domain, allocation: Allocation): Hex {
  // Solidity hashes each Allocation as an EIP-712 struct hash inside the parent
  // QueryManifest. The domain separator is applied once to QueryManifest only.
  void domain;
  return keccak256(encodeAbiParameters(
    [
      { type: "bytes32" }, { type: "address" }, { type: "bytes32" }, { type: "uint64" },
      { type: "uint64" }, { type: "uint64" }, { type: "uint32" }, { type: "bytes32" }, { type: "uint128" },
    ],
    [allocationTypeHash, allocation.publisher, allocation.datasetId, allocation.publisherNonce, allocation.policyNonce,
      allocation.grantNonce, allocation.recordCount, hashRecordHashes(allocation.recordHashes), allocation.payoutAmount],
  ));
}

export function hashAllocations(domain: Eip712Domain, allocations: readonly Allocation[]): Hex {
  const hashes = allocations.map((allocation) => hashAllocation(domain, allocation));
  return keccak256(concat(hashes));
}

export function hashResultRoot(allocations: readonly Allocation[]): Hex {
  const leaves = allocations.flatMap((allocation) =>
    allocation.recordHashes.map((recordHash) =>
      keccak256(
        encodeAbiParameters(
          [{ type: "address" }, { type: "bytes32" }, { type: "bytes32" }],
          [allocation.publisher, allocation.datasetId, recordHash],
        ),
      ),
    ),
  );
  return keccak256(concat(leaves));
}

export function hashQueryManifest(domain: Eip712Domain, manifest: QueryManifest): Hex {
  return hashTypedData({
    domain,
    types: queryManifestTypes,
    primaryType: "QueryManifest",
    message: {
      queryId: manifest.queryId,
      buyer: manifest.buyer,
      coordinator: manifest.coordinator,
      token: manifest.token,
      totalAmount: manifest.totalAmount,
      deadline: manifest.deadline,
      resultRoot: manifest.resultRoot,
      allocationsHash: hashAllocations(domain, manifest.allocations),
    },
  });
}

export function hashPublisherApproval(
  domain: Eip712Domain,
  queryId: Hex,
  allocation: Allocation,
  deadline: bigint,
): Hex {
  return hashTypedData({
    domain,
    types: publisherApprovalTypes,
    primaryType: "PublisherApproval",
    message: {
      queryId,
      publisher: allocation.publisher,
      datasetId: allocation.datasetId,
      publisherNonce: allocation.publisherNonce,
      policyNonce: allocation.policyNonce,
      grantNonce: allocation.grantNonce,
      recordCount: allocation.recordCount,
      recordHashesHash: hashRecordHashes(allocation.recordHashes),
      payoutAmount: allocation.payoutAmount,
      deadline,
    },
  });
}
