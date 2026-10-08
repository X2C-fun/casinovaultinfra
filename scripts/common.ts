/**
 * Shared PDA helpers and Anchor provider wiring for the casino vault scripts.
 */

import * as fs from "fs";
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Commitment,
  Connection,
  Keypair,
  PublicKey,
  SendTransactionError,
} from "@solana/web3.js";
import { CasinoVault } from "../target/types/casino_vault";

export const PROGRAM_ID = new PublicKey(
  "DdpfHbMEYWqZM9yzPvyT45qLPfiLP6yKaPNTgqx7navY",
);

export const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

export const VAULT_STATE_SEED = Buffer.from("vault_state_v2");
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

/** Derives the program data account that records the upgrade authority. */
export function deriveProgramDataAddress(
  programId: PublicKey = PROGRAM_ID,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
  )[0];
}

/**
 * Reads the program's upgrade authority, or `null` if the program is
 * immutable. Layout of `UpgradeableLoaderState::ProgramData`: u32 variant tag
 * (3), u64 slot, then `Option<Pubkey>`.
 */
export async function fetchUpgradeAuthority(
  connection: Connection,
  programId: PublicKey = PROGRAM_ID,
): Promise<PublicKey | null> {
  const info = await connection.getAccountInfo(
    deriveProgramDataAddress(programId),
  );
  if (!info || !info.owner.equals(BPF_LOADER_UPGRADEABLE_PROGRAM_ID)) {
    throw new Error(
      `program ${programId.toBase58()} is not deployed with the upgradeable loader`,
    );
  }
  if (info.data.readUInt32LE(0) !== 3) {
    throw new Error("unexpected program data account layout");
  }
  return info.data[12] === 1 ? new PublicKey(info.data.subarray(13, 45)) : null;
}

/** Loads a keypair from a Solana CLI JSON file (64-number array). */
export function loadKeypair(path: string): Keypair {
  let secret: unknown;
  try {
    secret = JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`cannot read keypair ${path}: ${(err as Error).message}`);
  }
  if (!Array.isArray(secret) || secret.length !== 64) {
    throw new Error(
      `${path} is not a Solana keypair (expected a JSON array of 64 numbers)`,
    );
  }
  return Keypair.fromSecretKey(Uint8Array.from(secret as number[]));
}

const LAMPORTS_PER_SOL_BIGINT = BigInt(1_000_000_000);
const U64_MAX = BigInt("18446744073709551615");

/**
 * Parses a plain decimal SOL amount ("0.5", "12", ".25") to exact lamports.
 * Rejects exponents, signs, more than 9 decimals, zero, and values above u64.
 */
export function solToLamports(input: string): bigint {
  const value = input.trim();
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) {
    throw new Error(`invalid SOL amount "${input}"`);
  }
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > 9) {
    throw new Error(`"${input}" has more than 9 decimal places`);
  }
  const lamports =
    BigInt(whole || "0") * LAMPORTS_PER_SOL_BIGINT +
    BigInt(fraction.padEnd(9, "0") || "0");
  if (lamports < BigInt(1))
    throw new Error("amount must be at least 1 lamport");
  if (lamports > U64_MAX) throw new Error("amount exceeds u64");
  return lamports;
}

/** Parses a non-negative integer that must fit in a u64. */
export function parseU64(input: string, label: string): bigint {
  if (!/^\d+$/.test(input.trim())) {
    throw new Error(`${label} must be a non-negative integer, got "${input}"`);
  }
  const value = BigInt(input.trim());
  if (value > U64_MAX) throw new Error(`${label} exceeds u64`);
  return value;
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
