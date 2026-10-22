import { PublicKey } from "@solana/web3.js";
import idlJson from "./idl/casino_vault.json";
import type { CasinoVault } from "./idl/casino_vault";
import { DEFAULT_PROGRAM_ID } from "./constants";

export type { CasinoVault } from "./idl/casino_vault";

/** The committed program IDL, as shipped on-chain. */
export const CASINO_VAULT_IDL = idlJson as CasinoVault;

/**
 * Returns the IDL with its `address` pointed at `programId`, which is what
 * `@coral-xyz/anchor`'s `Program` constructor reads. Pass your own deployment's
 * program ID here to target it.
 */
export function loadVaultIdl(
  programId: PublicKey = DEFAULT_PROGRAM_ID,
): CasinoVault {
  return {
    ...CASINO_VAULT_IDL,
    address: programId.toBase58() as CasinoVault["address"],
  };
}
