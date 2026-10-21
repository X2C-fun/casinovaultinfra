import { PublicKey } from "@solana/web3.js";
import {
  DEFAULT_PROGRAM_ID as SDK_DEFAULT_PROGRAM_ID,
  VAULT_STATE_SEED,
  POOL_VAULT_SEED,
  EVENT_AUTHORITY_SEED,
} from "@x2c-fun/casinovault-sdk";

// PDA seeds and the canonical program ID now come from the SDK (single source
// of truth). The env-based overrides and explorer helpers below are
// frontend-specific and stay here.

/** Program ID of this repository's devnet deployment (base58). */
export const DEFAULT_PROGRAM_ID = SDK_DEFAULT_PROGRAM_ID.toBase58();

/** On-chain program ID. Override per deployment with NEXT_PUBLIC_VAULT_PROGRAM_ID. */
export const PROGRAM_ID = process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID?.trim()
  ? new PublicKey(process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID.trim())
  : SDK_DEFAULT_PROGRAM_ID;

export { VAULT_STATE_SEED, POOL_VAULT_SEED, EVENT_AUTHORITY_SEED };

export const SOLANA_RPC =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

export const CLUSTER_LABEL =
  process.env.NEXT_PUBLIC_SOLANA_CLUSTER ?? "devnet";

export const EXPLORER_CLUSTER =
  CLUSTER_LABEL === "mainnet-beta" ? "" : `?cluster=${CLUSTER_LABEL}`;

export function explorerTx(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}${EXPLORER_CLUSTER}`;
}

export function explorerAddress(address: string): string {
  return `https://explorer.solana.com/address/${address}${EXPLORER_CLUSTER}`;
}

export const LAMPORTS_PER_SOL = 1_000_000_000;
