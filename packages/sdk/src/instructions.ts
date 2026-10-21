import { BN, type Program } from "@coral-xyz/anchor";
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

const bn = (v: bigint | number) => new BN(v.toString());

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
    .deposit(bn(params.amountLamports))
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
    .withdraw(bn(params.amountLamports), bn(params.requestId))
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
      bn(params.maxWithdrawPerTx),
      bn(params.maxWithdrawPerWindow),
      params.windowSeconds,
    )
    .accountsPartial({
      authority: params.authority,
      programData: deriveProgramDataAddress(programId),
      vaultState,
    })
    .instruction();
}
