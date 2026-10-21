import type { Program } from "@coral-xyz/anchor";
import { BN } from "./anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import type { CasinoVault } from "./idl/casino_vault";
import {
  BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
  DEFAULT_PROGRAM_ID,
} from "./constants";
import {
  deriveProgramDataAddress,
  derivePoolVaultPda,
  deriveVaultStatePda,
} from "./pdas";

/** Decoded `VaultState` account (lamport fields as `bigint`). */
export interface VaultState {
  admin: PublicKey;
  vaultBump: number;
  paused: boolean;
  pendingAdmin: PublicKey | null;
  maxWithdrawPerTx: bigint;
  maxWithdrawPerWindow: bigint;
  windowSeconds: number;
  windowStart: bigint;
  windowWithdrawn: bigint;
}

function toBigInt(value: BN | number | bigint): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  return BigInt(value.toString());
}

/**
 * Fetches and decodes the vault-state account. Returns `null` when the vault
 * has not been initialized yet.
 */
export async function fetchVaultState(
  program: Program<CasinoVault>,
  programId: PublicKey = program.programId,
): Promise<VaultState | null> {
  const [vaultState] = deriveVaultStatePda(programId);
  const raw = await program.account.vaultState.fetchNullable(vaultState);
  if (!raw) return null;
  return {
    admin: raw.admin,
    vaultBump: raw.vaultBump,
    paused: raw.paused,
    pendingAdmin: raw.pendingAdmin ?? null,
    maxWithdrawPerTx: toBigInt(raw.maxWithdrawPerTx),
    maxWithdrawPerWindow: toBigInt(raw.maxWithdrawPerWindow),
    windowSeconds: raw.windowSeconds,
    windowStart: toBigInt(raw.windowStart),
    windowWithdrawn: toBigInt(raw.windowWithdrawn),
  };
}

/** Returns the pool vault's current lamport balance (rent reserve included). */
export async function getPoolBalance(
  connection: Connection,
  programId: PublicKey = DEFAULT_PROGRAM_ID,
): Promise<bigint> {
  const [poolVault] = derivePoolVaultPda(programId);
  return BigInt(await connection.getBalance(poolVault));
}

/**
 * Returns the lamports the pool can actually pay out: its balance minus the
 * rent-exempt minimum for an empty (data-less) account, which must stay behind.
 */
export async function getWithdrawable(
  connection: Connection,
  programId: PublicKey = DEFAULT_PROGRAM_ID,
): Promise<bigint> {
  const [balance, rent] = await Promise.all([
    getPoolBalance(connection, programId),
    connection.getMinimumBalanceForRentExemption(0),
  ]);
  const withdrawable = balance - BigInt(rent);
  return withdrawable > 0n ? withdrawable : 0n;
}

/**
 * Reads the program's on-chain upgrade authority, or `null` if the program is
 * immutable. Layout of `UpgradeableLoaderState::ProgramData`: a u32 variant tag
 * (`3`), a u64 slot, then an `Option<Pubkey>`.
 */
export async function fetchUpgradeAuthority(
  connection: Connection,
  programId: PublicKey = DEFAULT_PROGRAM_ID,
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
    throw new Error("unexpected program-data account layout");
  }
  return info.data[12] === 1
    ? new PublicKey(info.data.subarray(13, 45))
    : null;
}
