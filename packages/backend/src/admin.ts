import { Keypair, PublicKey, Connection } from "@solana/web3.js";
import * as anchorNs from "@coral-xyz/anchor";
import { getReadonlyProgram, fetchVaultState } from "@x2c-fun/casinovault-sdk";

// Anchor ships CommonJS only; under Node ESM its names may live on `default`.
const anchor: typeof anchorNs =
  typeof anchorNs.utils?.bytes?.bs58?.decode === "function"
    ? anchorNs
    : (anchorNs as unknown as { default: typeof anchorNs }).default;

/**
 * Loads the admin keypair from `ADMIN_SECRET_KEY`. Accepts either a JSON array
 * of 64 numbers (the contents of a Solana keypair file) or a base58 string.
 * Server-side only — never expose this in a `NEXT_PUBLIC_*` variable.
 *
 * Every failure throws a FIXED message: parser errors (e.g. `JSON.parse`'s
 * "Unexpected token … in JSON at position …") can quote the secret, and the
 * caller logs whatever this throws.
 */
export function loadAdminKeypair(secret: string): Keypair {
  const trimmed = secret.trim();
  let bytes: Uint8Array;
  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error("ADMIN_SECRET_KEY is not a valid JSON array");
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 64 ||
      !parsed.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ) {
      throw new Error("ADMIN_SECRET_KEY JSON array must have 64 byte values");
    }
    bytes = Uint8Array.from(parsed as number[]);
  } else {
    try {
      bytes = Uint8Array.from(anchor.utils.bytes.bs58.decode(trimmed));
    } catch {
      throw new Error("ADMIN_SECRET_KEY is not valid base58");
    }
  }
  try {
    return Keypair.fromSecretKey(bytes);
  } catch {
    throw new Error("ADMIN_SECRET_KEY is not a valid ed25519 secret key");
  }
}

/**
 * Verifies the loaded admin key is the one registered on-chain. A mismatch
 * means the backend would co-sign withdrawals the program rejects (or, worse,
 * that you are pointed at the wrong deployment).
 */
export async function assertAdminMatchesOnChain(
  connection: Connection,
  programId: PublicKey,
  admin: PublicKey,
): Promise<void> {
  const program = getReadonlyProgram(connection, programId);
  const state = await fetchVaultState(program, programId);
  if (!state) {
    throw new Error(`vault ${programId.toBase58()} is not initialized`);
  }
  if (!state.admin.equals(admin)) {
    throw new Error(
      `ADMIN_SECRET_KEY does not match on-chain admin (${state.admin.toBase58()})`,
    );
  }
}

/**
 * Removes credentials from text that may end up in logs: the configured
 * RPC_URL (provider URLs often embed an API key in the path), URL userinfo
 * (`://user:pass@`, `://token@`), and secret-looking query parameters.
 */
export function redactSecrets(text: string, rpcUrl = process.env.RPC_URL?.trim()): string {
  let out = text;
  if (rpcUrl) out = out.split(rpcUrl).join("[RPC_URL]");
  out = out.replace(/(:\/\/)[^\s/@]+@/g, "$1[REDACTED]@");
  out = out.replace(
    /([?&](?:api[-_]?key|apikey|access[-_]?token|token|key|secret|auth)=)[^&#\s"']+/gi,
    "$1[REDACTED]",
  );
  return out;
}

/** Logs an error without its stack/cause chain (which may quote inputs), redacted. */
export function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) return redactSecrets(`${err.name}: ${err.message}`);
  return "unknown error";
}
