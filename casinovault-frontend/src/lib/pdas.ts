import { PublicKey } from "@solana/web3.js";
import { POOL_VAULT_SEED, PROGRAM_ID, VAULT_STATE_SEED } from "./constants";

export function deriveVaultStatePda(
  programId: PublicKey = PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([VAULT_STATE_SEED], programId);
}

export function derivePoolVaultPda(
  programId: PublicKey = PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([POOL_VAULT_SEED], programId);
}
