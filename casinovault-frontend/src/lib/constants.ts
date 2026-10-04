import { PublicKey } from "@solana/web3.js";

/** On-chain program ID (devnet deployment). */
export const PROGRAM_ID = new PublicKey(
  "DdpfHbMEYWqZM9yzPvyT45qLPfiLP6yKaPNTgqx7navY",
);

export const VAULT_STATE_SEED = Buffer.from("vault_state");
export const POOL_VAULT_SEED = Buffer.from("pool_vault");

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
