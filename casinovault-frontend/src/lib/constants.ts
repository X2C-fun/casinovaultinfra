/**
 * Frontend-only configuration: which deployment, RPC and explorer this app
 * talks to, read from `NEXT_PUBLIC_*` env vars at build time. Everything about
 * the program itself (IDL, PDAs, seeds, builders, the withdraw-tx check) comes
 * from `@x2c-fun/casinovault-sdk`, which never reads `process.env`.
 */
import { PublicKey } from "@solana/web3.js";
import { DEFAULT_PROGRAM_ID } from "@x2c-fun/casinovault-sdk";

/**
 * On-chain program ID, bundled into the client. Override per deployment with
 * NEXT_PUBLIC_VAULT_PROGRAM_ID; defaults to the SDK's devnet deployment.
 *
 * Pass it explicitly to every SDK helper: the SDK's own default is
 * DEFAULT_PROGRAM_ID, not this override. It is also the client-side constant
 * `assertSafeWithdrawTx` checks against, so it must never come from the server.
 */
export const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID?.trim() || DEFAULT_PROGRAM_ID.toBase58(),
);

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
