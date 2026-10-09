/**
 * Shared PDA helpers and Anchor provider wiring for the casino vault scripts.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Commitment,
  Connection,
  Keypair,
  PublicKey,
  SendTransactionError,
  Transaction,
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

/** Errors after which the RPC call can be repeated without side effects. */
function isTransientRpcError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /blockhash not found|node is behind|too many requests|429|fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|timed? ?out/i.test(
    message,
  );
}

function isAlreadyProcessed(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /already been processed|AlreadyProcessed/i.test(message);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Repeats a read-only RPC call on transient errors. */
async function readWithRetry<T>(
  read: () => Promise<T>,
  label: string,
  attempts = 5,
): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await read();
    } catch (err) {
      if (!isTransientRpcError(err) || i >= attempts) throw err;
      console.warn(
        `${label}: transient RPC error, retrying (${i}/${attempts})…`,
      );
      await sleep(400 * i);
    }
  }
}

/** Confirmation status of `signature`: landed, failed, or not seen. */
async function signatureStatus(
  connection: Connection,
  signature: string,
): Promise<"landed" | "missing" | { err: unknown }> {
  try {
    const { value } = await connection.getSignatureStatuses([signature]);
    const status = value[0];
    if (!status) return "missing";
    if (status.err) return { err: status.err };
    return status.confirmationStatus === "confirmed" ||
      status.confirmationStatus === "finalized"
      ? "landed"
      : "missing";
  } catch (err) {
    if (isTransientRpcError(err)) return "missing";
    throw err;
  }
}

export interface SendOptions {
  /** Fresh transactions to build, each only after the previous one expired. */
  maxBuilds?: number;
  /** Delay between re-sends of the same signed transaction. */
  resendIntervalMs?: number;
}

/**
 * Signs `build()`'s transaction ONCE and keeps re-sending those exact bytes
 * until it confirms or its blockhash expires.
 *
 * Re-sending identical bytes is idempotent: they carry one signature, and the
 * runtime processes a signature at most once. A fresh transaction (new
 * blockhash, new signature) is built only after the previous one is proven
 * expired: the cluster's block height is past its `lastValidBlockHeight` and
 * the signature never landed. A timeout or dropped connection after a
 * successful send can therefore never cause a second deposit or withdrawal.
 *
 * `extraSigners` are signers other than the provider wallet, which always
 * signs and pays the fee.
 */
export async function sendWithRetry(
  provider: anchor.AnchorProvider,
  build: () => Promise<Transaction>,
  extraSigners: Keypair[],
  label: string,
  { maxBuilds = 3, resendIntervalMs = 2_000 }: SendOptions = {},
): Promise<string> {
  const connection = provider.connection;
  const payer = provider.wallet.publicKey;
  const others = extraSigners.filter((k) => !k.publicKey.equals(payer));

  for (let buildNo = 1; buildNo <= maxBuilds; buildNo++) {
    const { blockhash, lastValidBlockHeight } = await readWithRetry(
      () => connection.getLatestBlockhash(DEFAULT_COMMITMENT),
      `${label}: getLatestBlockhash`,
    );
    const unsigned = await build();
    unsigned.feePayer = payer;
    unsigned.recentBlockhash = blockhash;
    unsigned.lastValidBlockHeight = lastValidBlockHeight;
    if (others.length > 0) unsigned.partialSign(...others);
    const tx = await provider.wallet.signTransaction(unsigned);
    const raw = tx.serialize();
    const signature = anchor.utils.bytes.bs58.encode(tx.signature!);

    let simulated = false;
    for (;;) {
      try {
        // Simulate on the first send so program errors surface with logs;
        // re-sends skip it (the bytes are identical).
        await connection.sendRawTransaction(raw, {
          skipPreflight: simulated,
          preflightCommitment: DEFAULT_COMMITMENT,
          maxRetries: 0,
        });
        simulated = true;
      } catch (err) {
        if (!isTransientRpcError(err) && !isAlreadyProcessed(err)) {
          // Before reporting a failure, make sure an earlier send of these
          // same bytes has not already landed.
          if ((await signatureStatus(connection, signature)) === "landed") {
            return signature;
          }
          if (err instanceof SendTransactionError) {
            console.error("tx logs:", err.logs ?? []);
          }
          throw err;
        }
        console.warn(
          `${label}: ${err instanceof Error ? err.message : String(err)} — re-sending the same transaction`,
        );
      }

      await sleep(resendIntervalMs);

      const status = await signatureStatus(connection, signature);
      if (status === "landed") return signature;
      if (typeof status === "object") {
        throw new Error(
          `${label}: transaction ${signature} failed on-chain: ${JSON.stringify(status.err)}`,
        );
      }

      let height: number | null = null;
      try {
        height = await connection.getBlockHeight(DEFAULT_COMMITMENT);
      } catch (err) {
        if (!isTransientRpcError(err)) throw err;
      }
      if (height !== null && height > lastValidBlockHeight) {
        // Expired. One last look: it can no longer land after this.
        if ((await signatureStatus(connection, signature)) === "landed") {
          return signature;
        }
        console.warn(
          `${label}: transaction ${signature} expired without landing` +
            (buildNo < maxBuilds ? "; building a new one" : ""),
        );
        break;
      }
    }
  }
  throw new Error(
    `${label}: no transaction landed after ${maxBuilds} attempts; nothing was executed`,
  );
}
