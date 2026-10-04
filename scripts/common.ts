/**
 * Shared PDA helpers and Anchor provider wiring for the casino vault scripts.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Commitment,
  Connection,
  PublicKey,
  SendTransactionError,
} from "@solana/web3.js";
import { CasinoVault } from "../target/types/casino_vault";

export const PROGRAM_ID = new PublicKey(
  "DdpfHbMEYWqZM9yzPvyT45qLPfiLP6yKaPNTgqx7navY",
);

export const VAULT_STATE_SEED = Buffer.from("vault_state");
export const POOL_VAULT_SEED = Buffer.from("pool_vault");

const DEFAULT_COMMITMENT: Commitment = "confirmed";

/** Derives the singleton vault state PDA. */
export function deriveVaultStatePda(
  programId: PublicKey = PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([VAULT_STATE_SEED], programId);
}

/** Derives the singleton pool vault PDA. */
export function derivePoolVaultPda(
  programId: PublicKey = PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([POOL_VAULT_SEED], programId);
}

/**
 * Builds an Anchor provider from `ANCHOR_PROVIDER_URL` + `ANCHOR_WALLET`.
 *
 * Public Solana RPCs often return a blockhash from one node that another node
 * has already expired. We pin commitment to `confirmed` and prefer a single
 * HTTP endpoint for both fetch and submit.
 */
export function loadProvider(): anchor.AnchorProvider {
  const url = process.env.ANCHOR_PROVIDER_URL;
  const walletPath = process.env.ANCHOR_WALLET;
  if (!url) {
    throw new Error(
      "ANCHOR_PROVIDER_URL is not set. Example: https://api.devnet.solana.com",
    );
  }
  if (!walletPath) {
    throw new Error("ANCHOR_WALLET is not set. Example: ./keys/admin.json");
  }

  const connection = new Connection(url, {
    commitment: DEFAULT_COMMITMENT,
    confirmTransactionInitialTimeout: 60_000,
  });
  const wallet = anchor.Wallet.local();
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: DEFAULT_COMMITMENT,
    preflightCommitment: DEFAULT_COMMITMENT,
    skipPreflight: false,
  });
  anchor.setProvider(provider);
  return provider;
}

/** Loads the typed program client from the workspace IDL. */
export function loadProgram(
  provider: anchor.AnchorProvider = loadProvider(),
): Program<CasinoVault> {
  return anchor.workspace.casinoVault as Program<CasinoVault>;
}

/** Lamports → SOL for human-readable logs. */
export function lamportsToSol(lamports: number | bigint): string {
  return (Number(lamports) / 1e9).toFixed(9);
}

function isTransientRpcError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /blockhash not found|block height exceeded|node is behind|too many requests|429|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(
    message,
  );
}

/**
 * Runs an Anchor `.rpc()` builder with retries for flaky public RPCs.
 */
export async function sendWithRetry(
  send: () => Promise<string>,
  label: string,
  attempts = 5,
): Promise<string> {
  let lastError: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await send();
    } catch (err) {
      lastError = err;
      if (!isTransientRpcError(err) || i === attempts) {
        if (err instanceof SendTransactionError) {
          try {
            console.error("tx logs:", err.logs ?? []);
          } catch {
            // ignore
          }
        }
        throw err;
      }
      const waitMs = 400 * i;
      console.warn(
        `${label}: transient RPC error (attempt ${i}/${attempts}), retrying in ${waitMs}ms…`,
      );
      console.warn(String(err instanceof Error ? err.message : err));
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastError;
}
