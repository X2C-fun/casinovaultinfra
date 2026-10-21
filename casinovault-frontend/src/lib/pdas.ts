import { PublicKey } from "@solana/web3.js";
import {
  deriveVaultStatePda as sdkVaultStatePda,
  derivePoolVaultPda as sdkPoolVaultPda,
  deriveEventAuthorityPda as sdkEventAuthorityPda,
} from "@x2c-fun/casinovault-sdk";
import { PROGRAM_ID } from "./constants";

// Thin wrappers over the SDK derivers that default to this app's configured
// PROGRAM_ID (which honours NEXT_PUBLIC_VAULT_PROGRAM_ID).

export function deriveVaultStatePda(
  programId: PublicKey = PROGRAM_ID,
): [PublicKey, number] {
  return sdkVaultStatePda(programId);
}

export function derivePoolVaultPda(
  programId: PublicKey = PROGRAM_ID,
): [PublicKey, number] {
  return sdkPoolVaultPda(programId);
}

export function deriveEventAuthorityPda(
  programId: PublicKey = PROGRAM_ID,
): [PublicKey, number] {
  return sdkEventAuthorityPda(programId);
}
