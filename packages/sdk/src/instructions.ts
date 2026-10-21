import { BN, type Program } from "./anchor";
import {
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
} from "@solana/web3.js";
import type { CasinoVault } from "./idl/casino_vault";
import {
  deriveProgramDataAddress,
  derivePoolVaultPda,
  deriveVaultStatePda,
} from "./pdas";

const U64_MAX = (1n << 64n) - 1n;
const U32_MAX = 0xffff_ffff;

/**
 * Converts a u64 argument to a `BN`, rejecting anything outside
 * `0 ..= 2^64 - 1`. `BN` would otherwise silently encode a negative value as
 * its magnitude and truncate an oversized one, so `-5n` would move 5 lamports.
 */
export function toU64Bn(name: string, value: bigint | number): BN {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new RangeError(`${name} must be an integer, got ${value}`);
  }
  if (typeof value !== "bigint" && typeof value !== "number") {
    throw new TypeError(`${name} must be a bigint`);
  }
  const v = BigInt(value);
  if (v < 0n || v > U64_MAX) {
    throw new RangeError(`${name} must be a u64 (0 to 2^64-1), got ${v}`);
  }
  return new BN(v.toString());
}

function toU32(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > U32_MAX) {
    throw new RangeError(`${name} must be a u32 (0 to 2^32-1), got ${value}`);
  }
  return value;
}

/**
 * `deposit(amount)` — move `amountLamports` from `depositor` into the shared
 * pool. The depositor signs and funds it. Emits a `DepositEvent` the backend
 * credits.
 */
export function buildDepositIx(
  program: Program<CasinoVault>,
  params: { depositor: PublicKey; amountLamports: bigint },
): Promise<TransactionInstruction> {
  const programId = program.programId;
  const [vaultState] = deriveVaultStatePda(programId);
  const [poolVault] = derivePoolVaultPda(programId);
  return program.methods
    .deposit(toU64Bn("amountLamports", params.amountLamports))
    .accountsPartial({
      depositor: params.depositor,
      vaultState,
      poolVault,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

/**
 * `withdraw(amount, requestId)` — release `amountLamports` from the pool to
 * `user`. Requires both `user` and `admin` to sign. `requestId` is echoed in
 * the `WithdrawEvent` so the backend settles the matching hold exactly.
 *
 * Prefer {@link buildWithdrawTransaction} on a backend: it assembles the whole
 * message (with any ComputeBudget instructions) so you co-sign only what you
 * built.
 */
export function buildWithdrawIx(
  program: Program<CasinoVault>,
  params: { user: PublicKey; admin: PublicKey; amountLamports: bigint; requestId: bigint },
): Promise<TransactionInstruction> {
  const programId = program.programId;
  const [vaultState] = deriveVaultStatePda(programId);
  const [poolVault] = derivePoolVaultPda(programId);
  return program.methods
    .withdraw(
      toU64Bn("amountLamports", params.amountLamports),
      toU64Bn("requestId", params.requestId),
    )
    .accountsPartial({
      user: params.user,
      admin: params.admin,
      vaultState,
      poolVault,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

/**
 * `initialize()` — create the singleton vault state and set the admin. Only the
 * program's upgrade authority may run it, exactly once. `authority` and `admin`
 * both sign.
 */
export function buildInitializeIx(
  program: Program<CasinoVault>,
  params: { authority: PublicKey; admin: PublicKey },
): Promise<TransactionInstruction> {
  const programId = program.programId;
  const [vaultState] = deriveVaultStatePda(programId);
  const [poolVault] = derivePoolVaultPda(programId);
  return program.methods
    .initialize()
    .accountsPartial({
      authority: params.authority,
      admin: params.admin,
      programData: deriveProgramDataAddress(programId),
      vaultState,
      poolVault,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

/** `set_paused(paused)` — flip the emergency switch. Admin signs. */
export function buildSetPausedIx(
  program: Program<CasinoVault>,
  params: { admin: PublicKey; paused: boolean },
): Promise<TransactionInstruction> {
  const [vaultState] = deriveVaultStatePda(program.programId);
  return program.methods
    .setPaused(params.paused)
    .accountsPartial({ admin: params.admin, vaultState })
    .instruction();
}

/**
 * `propose_admin(newAdmin)` — begin (or, with `null`, cancel) a two-step admin
 * rotation. The upgrade authority signs; the new admin accepts separately.
 */
export function buildProposeAdminIx(
  program: Program<CasinoVault>,
  params: { authority: PublicKey; newAdmin: PublicKey | null },
): Promise<TransactionInstruction> {
  const programId = program.programId;
  const [vaultState] = deriveVaultStatePda(programId);
  return program.methods
    .proposeAdmin(params.newAdmin)
    .accountsPartial({
      authority: params.authority,
      programData: deriveProgramDataAddress(programId),
      vaultState,
    })
    .instruction();
}

/** `accept_admin()` — the pending admin accepts and takes over. It signs. */
export function buildAcceptAdminIx(
  program: Program<CasinoVault>,
  params: { newAdmin: PublicKey },
): Promise<TransactionInstruction> {
  const [vaultState] = deriveVaultStatePda(program.programId);
  return program.methods
    .acceptAdmin()
    .accountsPartial({ newAdmin: params.newAdmin, vaultState })
    .instruction();
}

/**
 * `set_limits(...)` — set the withdrawal caps. The upgrade authority signs.
 * `maxWithdrawPerWindow` and `windowSeconds` must both be zero (disabled) or
 * both non-zero (enabled).
 */
export function buildSetLimitsIx(
  program: Program<CasinoVault>,
  params: {
    authority: PublicKey;
    maxWithdrawPerTx: bigint;
    maxWithdrawPerWindow: bigint;
    windowSeconds: number;
  },
): Promise<TransactionInstruction> {
  const programId = program.programId;
  const [vaultState] = deriveVaultStatePda(programId);
  return program.methods
    .setLimits(
      toU64Bn("maxWithdrawPerTx", params.maxWithdrawPerTx),
      toU64Bn("maxWithdrawPerWindow", params.maxWithdrawPerWindow),
      toU32("windowSeconds", params.windowSeconds),
    )
    .accountsPartial({
      authority: params.authority,
      programData: deriveProgramDataAddress(programId),
      vaultState,
    })
    .instruction();
}
