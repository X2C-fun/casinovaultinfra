import { PublicKey } from "@solana/web3.js";

/** Program ID of the public devnet demo deployment. */
export const DEFAULT_PROGRAM_ID = "DdpfHbMEYWqZM9yzPvyT45qLPfiLP6yKaPNTgqx7navY";

/** On-chain program ID. Override per deployment with NEXT_PUBLIC_VAULT_PROGRAM_ID. */
export const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID?.trim() || DEFAULT_PROGRAM_ID,
);

export const VAULT_STATE_SEED = Buffer.from("vault_state_v2");
export const POOL_VAULT_SEED = Buffer.from("pool_vault");
/** Seed of the PDA Anchor's `emit_cpi!` signs with. */
export const EVENT_AUTHORITY_SEED = Buffer.from("__event_authority");

export const SOLANA_RPC =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ??
  "https://api.devnet.solana.com";

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
