import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { hexToBytes, keccak256, toBytes, type Hex } from "viem";

export interface EncryptedPayload {
  iv: Hex;
  tag: Hex;
  ciphertext: Hex;
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function encryptPayload(keyHex: Hex, plaintext: string): Uint8Array {
  const key = hexToBytes(keyHex);
  if (key.length !== 32) throw new Error("DEMO_ENCRYPTION_KEY must contain exactly 32 bytes");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const envelope: EncryptedPayload = {
    iv: `0x${iv.toString("hex")}`,
    tag: `0x${cipher.getAuthTag().toString("hex")}`,
    ciphertext: `0x${ciphertext.toString("hex")}`,
  };
  return toBytes(JSON.stringify(envelope));
}

export function decryptPayload(keyHex: Hex, encryptedBytes: Hex): string {
  const key = hexToBytes(keyHex);
  if (key.length !== 32) throw new Error("DEMO_ENCRYPTION_KEY must contain exactly 32 bytes");
  const envelope = JSON.parse(new TextDecoder().decode(hexToBytes(encryptedBytes))) as EncryptedPayload;
  const decipher = createDecipheriv("aes-256-gcm", key, hexToBytes(envelope.iv));
  decipher.setAuthTag(hexToBytes(envelope.tag));
  return Buffer.concat([
    decipher.update(hexToBytes(envelope.ciphertext)),
    decipher.final(),
  ]).toString("utf8");
}

export function contentHash(plaintext: string): Hex {
  return keccak256(toBytes(plaintext));
}

export function encryptedPayloadHash(payload: Uint8Array): Hex {
  return keccak256(payload);
}
