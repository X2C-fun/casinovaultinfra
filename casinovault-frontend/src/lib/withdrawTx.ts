import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";

import { VAULT_IDL } from "./program";
import { PROGRAM_ID } from "./constants";
import {
  deriveEventAuthorityPda,
  derivePoolVaultPda,
  deriveVaultStatePda,
} from "./pdas";

const WITHDRAW_IX = VAULT_IDL.instructions.find((ix) => ix.name === "withdraw");
if (!WITHDRAW_IX) {
  throw new Error("IDL is missing the withdraw instruction");
}
const WITHDRAW_DISCRIMINATOR = Uint8Array.from(WITHDRAW_IX.discriminator);
// 8-byte discriminator + u64 amount + u64 request_id (both little-endian).
const WITHDRAW_DATA_LEN = 24;

export class UnsafeWithdrawTxError extends Error {
  constructor(reason: string) {
    super(`Refusing to sign: server returned an unexpected transaction (${reason}).`);
  }
}

function fail(reason: string): never {
  throw new UnsafeWithdrawTxError(reason);
}

/**
 * Asserts the server-built transaction is exactly one vault `withdraw` paying
 * `expectedLamports` to the connected wallet under `expectedRequestId`, before
 * the wallet is asked to sign it. A compromised or misconfigured server could otherwise return any
 * transaction (e.g. a System transfer draining the user) for the user to sign.
 */
export function assertSafeWithdrawTx(
  tx: Transaction,
  opts: {
    user: PublicKey;
    expectedLamports: bigint;
    expectedRequestId: bigint;
    expectedAdmin: PublicKey | null;
  },
): void {
  const { user, expectedLamports, expectedRequestId, expectedAdmin } = opts;

  if (!tx.feePayer || !tx.feePayer.equals(user)) {
    fail("fee payer is not your wallet");
  }
  if (tx.instructions.length !== 1) {
    fail(`expected 1 instruction, got ${tx.instructions.length}`);
  }

  const [ix] = tx.instructions;
  if (!ix.programId.equals(PROGRAM_ID)) {
    fail("instruction targets a different program");
  }

  const data = ix.data;
  if (data.length !== WITHDRAW_DATA_LEN) {
    fail("instruction data has the wrong length");
  }
  for (let i = 0; i < WITHDRAW_DISCRIMINATOR.length; i++) {
    if (data[i] !== WITHDRAW_DISCRIMINATOR[i]) {
      fail("instruction is not withdraw");
    }
  }
  const amount = Buffer.from(data).readBigUInt64LE(8);
  if (amount !== expectedLamports) {
    fail(`amount ${amount} lamports does not match the ${expectedLamports} you requested`);
  }
  const requestId = Buffer.from(data).readBigUInt64LE(16);
  if (requestId !== expectedRequestId) {
    fail("request ID does not match the approval");
  }

  // Account order follows the IDL: user, admin, vault_state, pool_vault,
  // system_program, then event_authority and program (added by #[event_cpi]).
  if (ix.keys.length !== 7) {
    fail("unexpected account list");
  }
  const [userKey, adminKey, stateKey, poolKey, systemKey, eventAuthorityKey, programKey] =
    ix.keys;
  if (!userKey.pubkey.equals(user) || !userKey.isSigner || !userKey.isWritable) {
    fail("recipient is not your wallet");
  }
  if (!adminKey.isSigner) {
    fail("admin is not a signer");
  }
  if (expectedAdmin && !adminKey.pubkey.equals(expectedAdmin)) {
    fail("admin does not match the on-chain vault admin");
  }
  if (!stateKey.pubkey.equals(deriveVaultStatePda(PROGRAM_ID)[0])) {
    fail("vault state account mismatch");
  }
  if (!poolKey.pubkey.equals(derivePoolVaultPda(PROGRAM_ID)[0])) {
    fail("pool vault account mismatch");
  }
  if (!systemKey.pubkey.equals(SystemProgram.programId)) {
    fail("system program mismatch");
  }
  if (!eventAuthorityKey.pubkey.equals(deriveEventAuthorityPda(PROGRAM_ID)[0])) {
    fail("event authority mismatch");
  }
  if (!programKey.pubkey.equals(PROGRAM_ID)) {
    fail("program account mismatch");
  }
  if (ix.keys.slice(2).some((key) => key.isSigner)) {
    fail("unexpected signer account");
  }

  const signers = new Set(tx.signatures.map((s) => s.publicKey.toBase58()));
  const allowed = new Set([user.toBase58(), adminKey.pubkey.toBase58()]);
  if (signers.size !== allowed.size || [...signers].some((s) => !allowed.has(s))) {
    fail("unexpected signer set");
  }
}
