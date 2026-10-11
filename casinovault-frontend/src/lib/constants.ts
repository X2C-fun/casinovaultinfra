import { PublicKey } from "@solana/web3.js";

/** Program ID of this repository's devnet deployment. */
export const DEFAULT_PROGRAM_ID = "EXTH5XRAqc45efhoL5UjwhhLFV4smgaB4m6QVG74Vqa7";

/** On-chain program ID. Override per deployment with NEXT_PUBLIC_VAULT_PROGRAM_ID. */
export const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID?.trim() || DEFAULT_PROGRAM_ID,
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
