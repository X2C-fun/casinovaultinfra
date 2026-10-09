/**
 * Shared test helpers: PDA derivation, funding, event parsing and error
 * assertions. Kept free of `describe`/`it` so it can be imported by any spec.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { assert } from "chai";

import { CasinoVault } from "../target/types/casino_vault";

/** Seeds, mirrored from `programs/casino_vault/src/constants.rs`. */
export const VAULT_STATE_SEED = Buffer.from("vault_state");
export const POOL_VAULT_SEED = Buffer.from("pool_vault");

/** Byte length of `VaultState`: discriminator + admin + bump + paused flag. */
export const VAULT_STATE_SIZE = 8 + 32 + 1 + 1;

/** Derives the singleton vault state PDA. */
export function deriveVaultStatePda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([VAULT_STATE_SEED], programId);
}

/** Derives the singleton pool vault PDA. */
export function derivePoolVaultPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([POOL_VAULT_SEED], programId);
}

/** Airdrops `lamports` to `target` and waits for confirmation. */
export async function airdrop(
  provider: anchor.AnchorProvider,
  target: PublicKey,
  lamports: number,
): Promise<void> {
  const signature = await provider.connection.requestAirdrop(target, lamports);
  const blockhash = await provider.connection.getLatestBlockhash();
  await provider.connection.confirmTransaction(
    { signature, ...blockhash },
    "confirmed",
  );
}

/**
 * Funds `target` from the provider wallet. Much faster than an airdrop per
 * account, which matters because most tests work with a fresh wallet.
 */
export async function fund(
  provider: anchor.AnchorProvider,
  target: PublicKey,
  lamports: number,
): Promise<void> {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: provider.wallet.publicKey,
      toPubkey: target,
      lamports,
    }),
  );
  await provider.sendAndConfirm(tx, [], { commitment: "confirmed" });
}

/** Creates a new keypair already holding `lamports`. */
export async function newFundedWallet(
  provider: anchor.AnchorProvider,
  lamports: number,
): Promise<Keypair> {
  const wallet = Keypair.generate();
  await fund(provider, wallet.publicKey, lamports);
  return wallet;
}

/** Details of a confirmed transaction needed to assert lamport movements. */
export interface TxDetails {
  /** Lamports charged for the transaction. */
  fee: number;
  /** Account that paid the fee, i.e. the first signer of the message. */
  feePayer: PublicKey;
  /** `meta.err` of the transaction; `null` when it succeeded. */
  err: unknown;
  /** Program events. Always empty for a failed transaction. */
  events: { name: string; data: any }[];
}

/** Fetches the fee paid and the program events emitted by a transaction. */
export async function getTxDetails(
  program: Program<CasinoVault>,
  provider: anchor.AnchorProvider,
  signature: string,
): Promise<TxDetails> {
  const tx = await provider.connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  assert.isNotNull(tx, `transaction ${signature} not found`);

  // A failed transaction is rolled back, but its logs still contain every
  // event emitted before the failing instruction. A listener that parses them
  // would credit deposits that never happened, so failed transactions yield
  // no events at all.
  const err = tx!.meta!.err;
  const parser = new anchor.EventParser(program.programId, program.coder);
  const events = err
    ? []
    : [...parser.parseLogs(tx!.meta!.logMessages!)].map((event) => ({
        name: event.name,
        data: event.data,
      }));

  // The fee payer is always the first signer of the compiled message.
  const feePayer = tx!.transaction.message.staticAccountKeys[0];

  return { fee: tx!.meta!.fee, feePayer, err, events };
}

/**
 * Returns the single event with `name` (matched case-insensitively, since the
 * IDL exposes camelCase names) and fails if it is missing or duplicated.
 */
export function expectEvent(details: TxDetails, name: string): any {
  const matches = details.events.filter(
    (event) => event.name.toLowerCase() === name.toLowerCase(),
  );
  assert.lengthOf(
    matches,
    1,
    `expected exactly one ${name}, got [${details.events
      .map((e) => e.name)
      .join(", ")}]`,
  );
  return matches[0].data;
}

/** Asserts a rejected promise carries the Anchor error code `code`. */
export async function expectAnchorError(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await promise;
  } catch (err) {
    const anchorError = err as anchor.AnchorError;
    assert.equal(
      anchorError?.error?.errorCode?.code,
      code,
      `expected Anchor error ${code}, got: ${err}`,
    );
    return;
  }
  assert.fail(
    `expected the instruction to fail with ${code}, but it succeeded`,
  );
}

/** Asserts a rejected promise failed for a reason matching `pattern`. */
export async function expectFailure(
  promise: Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  try {
    await promise;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    assert.match(message, pattern);
    return;
  }
  assert.fail(
    `expected the instruction to fail with ${pattern}, but it succeeded`,
  );
}

/** Lamport balance of `address`, or 0 when the account does not exist. */
export async function balanceOf(
  provider: anchor.AnchorProvider,
  address: PublicKey,
): Promise<number> {
  const info = await provider.connection.getAccountInfo(address, "confirmed");
  return info?.lamports ?? 0;
}
