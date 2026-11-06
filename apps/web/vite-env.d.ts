/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_COORDINATOR_API_URL?: string;
  readonly VITE_QUERYMINT_SETTLEMENT_ADDRESS?: `0x${string}`;
  readonly VITE_COORDINATOR_ADDRESS?: `0x${string}`;
  readonly VITE_WHITECHAIN_RPC_URL?: string;
}
