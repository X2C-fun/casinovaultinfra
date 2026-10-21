import { PublicKey } from "@solana/web3.js";
import {
  BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
  DEFAULT_PROGRAM_ID,
  EVENT_AUTHORITY_SEED,
  POOL_VAULT_SEED,
  VAULT_STATE_SEED,
} from "./constants";

/**
 * Derives the singleton vault-state PDA, the account that stores the admin,
 * pause flag and withdrawal caps.
 */
export function deriveVaultStatePda(
  programId: PublicKey = DEFAULT_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([VAULT_STATE_SEED], programId);
}

/**
 * Derives the singleton pool-vault PDA. Every lamport the program custodies —
 * player funds and house bankroll alike — sits in this one system-owned
 * account.
 */
export function derivePoolVaultPda(
  programId: PublicKey = DEFAULT_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([POOL_VAULT_SEED], programId);
}

/** Derives the event-authority PDA used by Anchor's `emit_cpi!`. */
export function deriveEventAuthorityPda(
  programId: PublicKey = DEFAULT_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([EVENT_AUTHORITY_SEED], programId);
}

/**
 * Derives the program-data account that records the upgrade authority. Reading
 * it is how {@link fetchUpgradeAuthority} learns who may run the
 * authority-gated instructions.
 */
export function deriveProgramDataAddress(
  programId: PublicKey = DEFAULT_PROGRAM_ID,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
  )[0];
}
