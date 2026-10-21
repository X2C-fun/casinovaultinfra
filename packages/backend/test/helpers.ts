import * as anchorNs from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  type ConfirmedSignatureInfo,
  type VersionedTransactionResponse,
} from "@solana/web3.js";
import {
  CASINO_VAULT_IDL,
  EVENT_IX_TAG,
  deriveEventAuthorityPda,
  type VaultEventRecord,
} from "@x2c-fun/casinovault-sdk";
import { MemoryLedger } from "../src/ledger/memory";
import { SqliteLedger } from "../src/ledger/sqlite";
import type { Ledger, LedgerOptions } from "../src/ledger/types";
import type { ListenerConnection } from "../src/listener/listener";

const anchor: typeof anchorNs =
  typeof anchorNs.utils?.bytes?.bs58?.encode === "function"
    ? anchorNs
    : (anchorNs as unknown as { default: typeof anchorNs }).default;

export const addr = () => Keypair.generate().publicKey;

/** Both ledgers, so every behavioural test runs against each. */
export const LEDGERS: [string, (opts?: LedgerOptions) => Ledger][] = [
  ["MemoryLedger", (opts) => new MemoryLedger(opts)],
  ["SqliteLedger", (opts) => new SqliteLedger(":memory:", opts)],
];

// --- decoded event records (what the SDK decoder returns) --------------------

export function depositRecord(
  user: PublicKey,
  amount: bigint,
  pos: { ix?: number; ev?: number } = {},
): VaultEventRecord {
  return {
    name: "depositEvent",
    data: { user, amount, vaultBalance: amount, timestamp: 0n },
    source: "cpi",
    instructionIndex: pos.ix ?? 0,
    eventIndex: pos.ev ?? 0,
  };
}

export function withdrawRecord(
  user: PublicKey,
  amount: bigint,
  requestId: bigint,
  pos: { ix?: number; ev?: number } = {},
): VaultEventRecord {
  return {
    name: "withdrawEvent",
    data: { user, admin: addr(), requestId, amount, vaultBalance: 0n, timestamp: 0n },
    source: "cpi",
    instructionIndex: pos.ix ?? 0,
    eventIndex: pos.ev ?? 0,
  };
}

// --- raw transactions the REAL SDK decoder can read ---------------------------

function discriminator(name: string): number[] {
  const ev = (CASINO_VAULT_IDL as unknown as { events: { name: string; discriminator: number[] }[] })
    .events.find((e) => e.name === name);
  if (!ev) throw new Error(`no event ${name}`);
  return ev.discriminator;
}

function u64(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}

export type RawEvent =
  | { kind: "deposit"; user: PublicKey; amount: bigint }
  | { kind: "withdraw"; user: PublicKey; admin: PublicKey; requestId: bigint; amount: bigint }
  | { kind: "garbage" };

function encodeEvent(e: RawEvent): Buffer {
  if (e.kind === "deposit") {
    return Buffer.concat([
      Buffer.from(discriminator("DepositEvent")),
      e.user.toBuffer(),
      u64(e.amount),
      u64(e.amount),
      u64(0n),
    ]);
  }
  if (e.kind === "withdraw") {
    return Buffer.concat([
      Buffer.from(discriminator("WithdrawEvent")),
      e.user.toBuffer(),
      e.admin.toBuffer(),
      u64(e.requestId),
      u64(e.amount),
      u64(0n),
      u64(0n),
    ]);
  }
  // A v0.1-style WithdrawEvent: right discriminator, no request_id (too short).
  return Buffer.concat([Buffer.from(discriminator("WithdrawEvent")), Buffer.alloc(64 + 24)]);
}

/**
 * A finalized transaction whose top-level instruction 0 is a vault call that
 * emitted `events` via emit_cpi! (self-CPI to the event authority).
 */
export function fakeTx(
  programId: PublicKey,
  signature: string,
  slot: number,
  events: RawEvent[],
  opts: { err?: unknown } = {},
): VersionedTransactionResponse {
  const [eventAuthority] = deriveEventAuthorityPda(programId);
  const payer = addr();
  const accountKeys = [payer, programId, eventAuthority];
  return {
    slot,
    blockTime: null,
    transaction: {
      signatures: [signature],
      message: { accountKeys, staticAccountKeys: accountKeys } as never,
    },
    meta: {
      err: opts.err ?? null,
      fee: 5000,
      preBalances: [],
      postBalances: [],
      logMessages: [],
      innerInstructions: [
        {
          index: 0,
          instructions: events.map((e) => ({
            programIdIndex: 1,
            accounts: [2],
            data: anchor.utils.bytes.bs58.encode(
              Buffer.concat([Buffer.from(EVENT_IX_TAG), encodeEvent(e)]),
            ),
            stackHeight: 2,
          })),
        },
      ],
    },
  } as unknown as VersionedTransactionResponse;
}

/**
 * A fake `Connection` holding a chronological list of finalized signatures.
 * `getSignaturesForAddress` honours `until`/`before`/`limit` newest-first like
 * the real RPC; `getTransaction` serves `txs` (or null for unknown ones).
 */
export class FakeConnection implements ListenerConnection {
  sigs: ConfirmedSignatureInfo[] = []; // oldest first
  txs = new Map<string, VersionedTransactionResponse | null>();
  blockHeight = 1_000;
  sigCalls = 0;
  txCalls: string[] = [];

  add(
    signature: string,
    slot: number,
    tx: VersionedTransactionResponse | null,
    err: unknown = null,
  ): void {
    this.sigs.push({ signature, slot, err: err as never, memo: null, blockTime: null });
    this.txs.set(signature, tx);
  }

  async getSignaturesForAddress(
    _address: PublicKey,
    options: { until?: string; before?: string; limit?: number } = {},
  ): Promise<ConfirmedSignatureInfo[]> {
    this.sigCalls++;
    const newestFirst = [...this.sigs].reverse();
    let start = 0;
    if (options.before) {
      const i = newestFirst.findIndex((s) => s.signature === options.before);
      start = i < 0 ? newestFirst.length : i + 1;
    }
    const out: ConfirmedSignatureInfo[] = [];
    for (let i = start; i < newestFirst.length; i++) {
      if (newestFirst[i].signature === options.until) break;
      out.push(newestFirst[i]);
      if (out.length >= (options.limit ?? 1000)) break;
    }
    return out;
  }

  async getTransaction(signature: string): Promise<VersionedTransactionResponse | null> {
    this.txCalls.push(signature);
    return this.txs.get(signature) ?? null;
  }

  async getBlockHeight(): Promise<number> {
    return this.blockHeight;
  }
}
