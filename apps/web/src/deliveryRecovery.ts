/** True only for a complete 32-byte EVM transaction hash. */
export function isValidDeliveryTransactionHash(value: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(value.trim());
}
