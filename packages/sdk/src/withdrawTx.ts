import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import type { Program } from "@coral-xyz/anchor";
import type { CasinoVault } from "./idl/casino_vault";
import { DEFAULT_PROGRAM_ID } from "./constants";
import {
  deriveEventAuthorityPda,
  derivePoolVaultPda,
  deriveVaultStatePda,
} from "./pdas";
import { buildWithdrawIx } from "./instructions";

/** 8-byte discriminator + u64 amount + u64 request_id. */
const WITHDRAW_DATA_LEN = 24;

/**
 * Highest priority fee the user may be asked to pay, in lamports. The user is
 * the fee payer, so an unbounded compute-unit price set by a compromised
 * server would drain the wallet through fees alone.
 */
export const MAX_PRIORITY_FEE_LAMPORTS = 1_000_000n; // 0.001 SOL
const MAX_COMPUTE_UNITS = 1_400_000n;
const MAX_COMPUTE_BUDGET_IXS = 4;
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

/**
 * Builds the complete withdraw transaction a backend co-signs: optional
 * ComputeBudget instructions followed by exactly one `withdraw`, with `user`
 * as fee payer. Build it yourself and never co-sign a transaction you did not
 * build — a user-built one could wrap `withdraw` in other instructions your
 * settlement logic would not see.
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
    /** Compute-unit limit to request alongside a priority fee. */
    computeUnitLimit?: number;
  },
): Promise<Transaction> {
  const tx = new Transaction();
  if (params.computeUnitPriceMicroLamports !== undefined) {
    if (params.computeUnitLimit !== undefined) {
      tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({
          units: params.computeUnitLimit,
        }),
      );
    }
    tx.add(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: params.computeUnitPriceMicroLamports,
      }),
    );
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
    const data = Buffer.from(ix.data);
    switch (data[0]) {
      case CB_SET_UNIT_LIMIT:
        if (data.length !== 5) fail("malformed compute unit limit");
        unitLimit = BigInt(data.readUInt32LE(1));
        break;
      case CB_SET_UNIT_PRICE:
        if (data.length !== 9) fail("malformed compute unit price");
        microLamportsPerUnit = data.readBigUInt64LE(1);
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
  // Priority fee = ceil(price (micro-lamports per unit) * units / 1e6).
  const fee = (microLamportsPerUnit * units + 999_999n) / 1_000_000n;
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
 */
export function assertSafeWithdrawTx(
  tx: Transaction,
  opts: {
    user: PublicKey;
    expectedLamports: bigint;
    expectedRequestId: bigint;
    expectedAdmin: PublicKey | null;
    programId?: PublicKey;
  },
): void {
  const { user, expectedLamports, expectedRequestId, expectedAdmin } = opts;
  const programId = opts.programId ?? DEFAULT_PROGRAM_ID;

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
  const amount = Buffer.from(data).readBigUInt64LE(8);
  if (amount !== expectedLamports) {
    fail(`amount ${amount} lamports does not match the ${expectedLamports} you requested`);
  }
  const requestId = Buffer.from(data).readBigUInt64LE(16);
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
