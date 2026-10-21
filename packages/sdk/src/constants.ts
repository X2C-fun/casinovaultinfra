import { PublicKey } from "@solana/web3.js";

/**
 * Program ID of this repository's canonical devnet deployment.
 *
 * Override it per deployment by passing your own `programId` to the helpers,
 * or by reading an env var in your app and handing it in. The SDK never reads
 * `process.env` itself, so it is safe in a browser bundle.
 */
export const DEFAULT_PROGRAM_ID = new PublicKey(
  "EXTH5XRAqc45efhoL5UjwhhLFV4smgaB4m6QVG74Vqa7",
);

/** Seed of the singleton vault-state PDA (`["vault_state_v2"]`). */
export const VAULT_STATE_SEED = Buffer.from("vault_state_v2");

/** Seed of the singleton pool-vault PDA that custodies every lamport. */
export const POOL_VAULT_SEED = Buffer.from("pool_vault");

/** Seed of the PDA Anchor's `emit_cpi!` signs with (`["__event_authority"]`). */
export const EVENT_AUTHORITY_SEED = Buffer.from("__event_authority");

/** The upgradeable BPF loader, owner of every program-data account. */
export const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

export const LAMPORTS_PER_SOL = 1_000_000_000n;
