import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import type { Program } from "@coral-xyz/anchor";
import type { CasinoVault } from "./idl/casino_vault";
import { DEFAULT_PROGRAM_ID } from "./constants";
import { CASINO_VAULT_IDL } from "./idl";
import {
  deriveEventAuthorityPda,
  derivePoolVaultPda,
  deriveVaultStatePda,
} from "./pdas";
import { buildWithdrawIx } from "./instructions";

const WITHDRAW_IX = CASINO_VAULT_IDL.instructions.find((ix) => ix.name === "withdraw");
if (!WITHDRAW_IX) {
  throw new Error("IDL is missing the withdraw instruction");
}
/** Anchor discriminator of `withdraw`, taken from the committed IDL. */
const WITHDRAW_DISCRIMINATOR = Uint8Array.from(WITHDRAW_IX.discriminator);
/** 8-byte discriminator + u64 amount + u64 request_id (both little-endian). */
const WITHDRAW_DATA_LEN = 24;
const U64_MAX = (1n << 64n) - 1n;

/**
 * Highest priority fee the user may be asked to pay, in lamports. The user is
 * the fee payer, so an unbounded compute-unit price set by a compromised
 * server would drain the wallet through fees alone.
 */
export const MAX_PRIORITY_FEE_LAMPORTS = 1_000_000n; // 0.001 SOL
/** Compute units Solana allows per transaction (the worst case if unset). */
const MAX_COMPUTE_UNITS = 1_400_000n;
const MAX_COMPUTE_BUDGET_IXS = 4;
// ComputeBudget instruction tags (first data byte).
const CB_REQUEST_HEAP_FRAME = 1;
const CB_SET_UNIT_LIMIT = 2;
const CB_SET_UNIT_PRICE = 3;
const CB_SET_LOADED_ACCOUNTS_DATA_SIZE = 4;

export class UnsafeWithdrawTxError extends Error {
  constructor(reason: string) {
    super(`Refusing to sign: server returned an unexpected transaction (${reason}).`);
    this.name = "UnsafeWithdrawTxError";
  }
}

function fail(reason: string): never {
  throw new UnsafeWithdrawTxError(reason);
}

/** Little-endian reads without `Buffer`, which is not a browser global. */
function view(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

/** Worst-case priority fee in lamports: ceil(price * units / 1e6). */
function priorityFeeLamports(microLamportsPerUnit: bigint, units: bigint): bigint {
  return (microLamportsPerUnit * units + 999_999n) / 1_000_000n;
}

/**
 * Builds the complete withdraw transaction a backend co-signs: optional
 * ComputeBudget instructions followed by exactly one `withdraw`, with `user`
 * as fee payer. Build it yourself and never co-sign a transaction you did not
 * build — a user-built one could wrap `withdraw` in other instructions your
 * settlement logic would not see.
 *
 * The builder enforces the same priority-fee ceiling as
 * {@link assertSafeWithdrawTx}, so it never produces a transaction the client
 * would refuse: the worst-case fee `ceil(price * (computeUnitLimit ?? 1.4M) / 1e6)`
 * must not exceed {@link MAX_PRIORITY_FEE_LAMPORTS}, otherwise it throws a
 * `RangeError`. `computeUnitLimit` is honoured with or without a price.
 *
 * Leaves `recentBlockhash`/`lastValidBlockHeight` unset; set them, then
 * partial-sign with the admin key and return it to the user to sign and submit.
 */
export async function buildWithdrawTransaction(
  program: Program<CasinoVault>,
  params: {
    user: PublicKey;
    admin: PublicKey;
    amountLamports: bigint;
    requestId: bigint;
    /** Optional priority fee, in micro-lamports per compute unit. */
    computeUnitPriceMicroLamports?: bigint;
    /** Optional compute-unit limit (1 to 1,400,000). Also bounds the priority fee. */
    computeUnitLimit?: number;
  },
): Promise<Transaction> {
  const { computeUnitLimit, computeUnitPriceMicroLamports: price } = params;
  if (
    computeUnitLimit !== undefined &&
    (!Number.isInteger(computeUnitLimit) ||
      computeUnitLimit < 1 ||
      BigInt(computeUnitLimit) > MAX_COMPUTE_UNITS)
  ) {
    throw new RangeError(
      `computeUnitLimit must be an integer from 1 to ${MAX_COMPUTE_UNITS}, got ${computeUnitLimit}`,
    );
  }
  if (price !== undefined) {
    if (typeof price !== "bigint" || price < 0n || price > U64_MAX) {
      throw new RangeError("computeUnitPriceMicroLamports must be a u64 bigint");
    }
    const units =
      computeUnitLimit !== undefined ? BigInt(computeUnitLimit) : MAX_COMPUTE_UNITS;
    const fee = priorityFeeLamports(price, units);
    if (fee > MAX_PRIORITY_FEE_LAMPORTS) {
      throw new RangeError(
        `priority fee of up to ${fee} lamports is above MAX_PRIORITY_FEE_LAMPORTS ` +
          `(${MAX_PRIORITY_FEE_LAMPORTS}); lower the price or set a smaller computeUnitLimit`,
      );
    }
  }

  const tx = new Transaction();
  if (computeUnitLimit !== undefined) {
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }));
  }
  if (price !== undefined) {
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }));
  }
  tx.add(
    await buildWithdrawIx(program, {
      user: params.user,
      admin: params.admin,
      amountLamports: params.amountLamports,
      requestId: params.requestId,
    }),
  );
  tx.feePayer = params.user;
  return tx;
}

/**
 * Checks the ComputeBudget instructions placed before the withdraw: only known
 * kinds, no accounts, and a worst-case priority fee within the allowed bound.
 */
function assertComputeBudget(ixs: TransactionInstruction[]): void {
  if (ixs.length > MAX_COMPUTE_BUDGET_IXS) {
    fail(`too many ComputeBudget instructions (${ixs.length})`);
  }
  let unitLimit: bigint | null = null;
  let microLamportsPerUnit = 0n;
  for (const ix of ixs) {
    if (!ix.programId.equals(ComputeBudgetProgram.programId)) {
      fail("unexpected instruction before withdraw");
    }
    if (ix.keys.length !== 0) fail("ComputeBudget instruction with accounts");
    const data = ix.data;
    switch (data[0]) {
      case CB_SET_UNIT_LIMIT:
        if (data.length !== 5) fail("malformed compute unit limit");
        unitLimit = BigInt(view(data).getUint32(1, true));
        break;
      case CB_SET_UNIT_PRICE:
        if (data.length !== 9) fail("malformed compute unit price");
        microLamportsPerUnit = view(data).getBigUint64(1, true);
        break;
      case CB_REQUEST_HEAP_FRAME:
      case CB_SET_LOADED_ACCOUNTS_DATA_SIZE:
        if (data.length !== 5) fail("malformed ComputeBudget instruction");
        break;
      default:
        fail("unknown ComputeBudget instruction");
    }
  }
  const units = unitLimit ?? MAX_COMPUTE_UNITS;
  const fee = priorityFeeLamports(microLamportsPerUnit, units);
  if (fee > MAX_PRIORITY_FEE_LAMPORTS) {
    fail(
      `priority fee of up to ${fee} lamports is above the allowed ${MAX_PRIORITY_FEE_LAMPORTS}`,
    );
  }
}

/**
 * Asserts the server-built transaction is exactly one vault `withdraw` paying
 * `expectedLamports` to `user` under `expectedRequestId`, before the wallet is
 * asked to sign. Call this in the browser on any withdraw transaction a backend
 * hands you. A compromised or misconfigured server could otherwise return a
 * System transfer draining the user, or an extreme priority fee.
 *
 * Checks: the fee payer is `user`; only ComputeBudget instructions (at most
 * four, known kinds, no accounts, worst-case priority fee within
 * {@link MAX_PRIORITY_FEE_LAMPORTS}) precede a final instruction to
 * `programId` that carries the `withdraw` discriminator, the expected amount
 * and request ID, and exactly the expected accounts; the signer set is
 * exactly `{user, admin}`.
 *
 * SECURITY: `programId` (and `expectedAdmin`) must be client-side values — a
 * constant bundled with your app, or read from chain — NEVER taken from the
 * server response being checked. A server that picks the program ID can point
 * the whole check at a program of its own.
 *
 * Only legacy `Transaction`s are accepted. A `VersionedTransaction` is
 * rejected with {@link UnsafeWithdrawTxError}: its address-table lookups cannot
 * be verified offline.
 */
export function assertSafeWithdrawTx(
  tx: Transaction,
  opts: {
    user: PublicKey;
    expectedLamports: bigint;
    expectedRequestId: bigint;
    expectedAdmin: PublicKey | null;
    /** Client-side constant, never taken from the server. Defaults to DEFAULT_PROGRAM_ID. */
    programId?: PublicKey;
  },
): void {
  const { user, expectedLamports, expectedRequestId, expectedAdmin } = opts;
  const programId = opts.programId ?? DEFAULT_PROGRAM_ID;

  const raw = tx as unknown;
  if (
    raw === null ||
    typeof raw !== "object" ||
    raw instanceof VersionedTransaction ||
    "version" in raw ||
    "message" in raw ||
    !Array.isArray((raw as { instructions?: unknown }).instructions)
  ) {
    fail("expected a legacy Transaction; VersionedTransaction is not supported");
  }

  if (!tx.feePayer || !tx.feePayer.equals(user)) {
    fail("fee payer is not your wallet");
  }
  if (tx.instructions.length === 0) fail("transaction has no instructions");
  // The withdraw must be last; anything before it must be ComputeBudget.
  const ix = tx.instructions[tx.instructions.length - 1];
  assertComputeBudget(tx.instructions.slice(0, -1));
  if (!ix.programId.equals(programId)) {
    fail("instruction targets a different program");
  }

  const data = ix.data;
  if (data.length !== WITHDRAW_DATA_LEN) {
    fail("instruction data has the wrong length");
  }
  for (let i = 0; i < WITHDRAW_DISCRIMINATOR.length; i++) {
    if (data[i] !== WITHDRAW_DISCRIMINATOR[i]) fail("instruction is not withdraw");
  }
  const amount = view(data).getBigUint64(8, true);
  if (amount !== expectedLamports) {
    fail(`amount ${amount} lamports does not match the ${expectedLamports} you requested`);
  }
  const requestId = view(data).getBigUint64(16, true);
  if (requestId !== expectedRequestId) {
    fail("request ID does not match the approval");
  }

  // Account order: user, admin, vault_state, pool_vault, system_program, then
  // event_authority and program (added by #[event_cpi]).
  if (ix.keys.length !== 7) fail("unexpected account list");
  const [userKey, adminKey, stateKey, poolKey, systemKey, eventAuthorityKey, programKey] =
    ix.keys;
  if (!userKey.pubkey.equals(user) || !userKey.isSigner || !userKey.isWritable) {
    fail("recipient is not your wallet");
  }
  if (!adminKey.isSigner) fail("admin is not a signer");
  if (expectedAdmin && !adminKey.pubkey.equals(expectedAdmin)) {
    fail("admin does not match the on-chain vault admin");
  }
  if (!stateKey.pubkey.equals(deriveVaultStatePda(programId)[0])) {
    fail("vault state account mismatch");
  }
  if (!poolKey.pubkey.equals(derivePoolVaultPda(programId)[0])) {
    fail("pool vault account mismatch");
  }
  if (!systemKey.pubkey.equals(SystemProgram.programId)) {
    fail("system program mismatch");
  }
  if (!eventAuthorityKey.pubkey.equals(deriveEventAuthorityPda(programId)[0])) {
    fail("event authority mismatch");
  }
  if (!programKey.pubkey.equals(programId)) fail("program account mismatch");
  if (ix.keys.slice(2).some((key) => key.isSigner)) {
    fail("unexpected signer account");
  }

  const signers = new Set(tx.signatures.map((s) => s.publicKey.toBase58()));
  const allowed = new Set([user.toBase58(), adminKey.pubkey.toBase58()]);
  if (signers.size !== allowed.size || [...signers].some((s) => !allowed.has(s))) {
    fail("unexpected signer set");
  }
}
