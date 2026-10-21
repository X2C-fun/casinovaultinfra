import { Keypair, PublicKey, Connection } from "@solana/web3.js";
import { utils } from "@coral-xyz/anchor";
import { getReadonlyProgram, fetchVaultState } from "@x2c-fun/casinovault-sdk";

/**
 * Loads the admin keypair from `ADMIN_SECRET_KEY`. Accepts either a JSON array
 * of 64 numbers (the contents of a Solana keypair file) or a base58 string.
 * Server-side only — never expose this in a `NEXT_PUBLIC_*` variable.
 */
export function loadAdminKeypair(secret: string): Keypair {
  const trimmed = secret.trim();
  if (trimmed.startsWith("[")) {
    const bytes = JSON.parse(trimmed) as number[];
    if (!Array.isArray(bytes) || bytes.length !== 64) {
      throw new Error("ADMIN_SECRET_KEY JSON array must have 64 numbers");
    }
    return Keypair.fromSecretKey(Uint8Array.from(bytes));
  }
  // base58 (uses Anchor's bundled bs58)
  const decoded = utils.bytes.bs58.decode(trimmed);
  return Keypair.fromSecretKey(Uint8Array.from(decoded));
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
