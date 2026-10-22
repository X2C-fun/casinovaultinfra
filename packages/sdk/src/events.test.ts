import { describe, it, expect } from "vitest";
import { BN, bs58 } from "./anchor";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  MessageV0,
  PublicKey,
  SystemProgram,
  type CompiledInstruction,
  type TransactionResponse,
  type VersionedTransactionResponse,
} from "@solana/web3.js";
import {
  DEFAULT_PROGRAM_ID,
  EVENT_IX_TAG,
  MissingTransactionDataError,
  UndecodableEventError,
  decodeVaultTransactionEvents,
  deriveEventAuthorityPda,
  derivePoolVaultPda,
  deriveVaultStatePda,
  getReadonlyProgram,
  vaultEventKey,
  type VaultEventRecord,
} from "./index";

// The program's own coder encodes every synthetic payload.
const program = getReadonlyProgram(new Connection("http://localhost:8899"));

const programId = DEFAULT_PROGRAM_ID;
const [eventAuthority] = deriveEventAuthorityPda(programId);
const [vaultState] = deriveVaultStatePda(programId);
const [poolVault] = derivePoolVaultPda(programId);
const user = Keypair.generate().publicKey;
const admin = Keypair.generate().publicKey;
const SIG = "5igSynthSignature1111111111111111111111111111111111111111111111111";
const VAULT = programId.toBase58();
const CB = ComputeBudgetProgram.programId.toBase58();
const SYS = SystemProgram.programId.toBase58();

function encodeEvent(name: string, data: Record<string, unknown>): Buffer {
  const def = program.idl.events!.find((e) => e.name === name)!;
  return Buffer.concat([Buffer.from(def.discriminator), program.coder.types.encode(name, data)]);
}

const deposit1 = encodeEvent("depositEvent", {
  user,
  amount: new BN(1_000_000_000),
  vaultBalance: new BN(5_000_000_000),
  timestamp: new BN(1_700_000_000),
});
const withdraw1 = encodeEvent("withdrawEvent", {
  user,
  admin,
  requestId: new BN(42),
  amount: new BN(250_000_000),
  vaultBalance: new BN(4_750_000_000),
  timestamp: new BN(1_700_000_001),
});
// v0.1 WithdrawEvent layout: no request_id.
const withdrawV01 = Buffer.concat([
  Buffer.from(program.idl.events!.find((e) => e.name === "withdrawEvent")!.discriminator),
  user.toBuffer(),
  admin.toBuffer(),
  new BN(250_000_000).toArrayLike(Buffer, "le", 8),
  new BN(4_750_000_000).toArrayLike(Buffer, "le", 8),
  new BN(1_700_000_001).toArrayLike(Buffer, "le", 8),
]);

// Legacy account keys: indices used by the compiled inner instructions below.
const LEGACY_KEYS = [
  user, // 0
  admin, // 1
  vaultState, // 2
  poolVault, // 3
  SystemProgram.programId, // 4
  eventAuthority, // 5
  programId, // 6
  ComputeBudgetProgram.programId, // 7
];
const PROGRAM_IX = 6;
const EVENT_AUTH_IX = 5;

function eventCpi(payload: Buffer, programIdIndex = PROGRAM_IX, authIndex = EVENT_AUTH_IX): CompiledInstruction {
  return {
    programIdIndex,
    accounts: [authIndex],
    data: bs58.encode(Buffer.concat([Buffer.from(EVENT_IX_TAG), payload])),
  };
}

const sysCpi: CompiledInstruction = { programIdIndex: 4, accounts: [0, 3], data: bs58.encode(Buffer.alloc(12)) };

/** Logs for one top-level vault instruction emitting `payloads` (log + self-CPI each). */
function vaultIxLogs(name: string, payloads: Buffer[]): string[] {
  const out = [`Program ${VAULT} invoke [1]`, `Program log: Instruction: ${name}`];
  out.push(`Program ${SYS} invoke [2]`, `Program ${SYS} success`);
  for (const p of payloads) {
    out.push(`Program data: ${p.toString("base64")}`);
    out.push(`Program ${VAULT} invoke [2]`, `Program ${VAULT} consumed 2000 of 150000 compute units`, `Program ${VAULT} success`);
  }
  out.push(`Program ${VAULT} consumed 20000 of 200000 compute units`, `Program ${VAULT} success`);
  return out;
}

const CB_LOGS = [`Program ${CB} invoke [1]`, `Program ${CB} success`];

function legacyResponse(meta: Partial<NonNullable<TransactionResponse["meta"]>>): TransactionResponse {
  return {
    slot: 1,
    blockTime: null,
    transaction: {
      signatures: [SIG],
      message: { accountKeys: LEGACY_KEYS, staticAccountKeys: LEGACY_KEYS } as never,
    },
    meta: {
      fee: 5000,
      preBalances: [],
      postBalances: [],
      err: null,
      ...meta,
    },
  };
}

/** [ComputeBudget, deposit, withdraw]: one event per vault instruction. */
function happyTx(): TransactionResponse {
  return legacyResponse({
    logMessages: [
      ...CB_LOGS,
      ...vaultIxLogs("Deposit", [deposit1]),
      ...vaultIxLogs("Withdraw", [withdraw1]),
    ],
    innerInstructions: [
      { index: 2, instructions: [sysCpi, eventCpi(withdraw1)] },
      { index: 1, instructions: [sysCpi, eventCpi(deposit1)] },
    ],
  });
}

const position = (e: VaultEventRecord) => [e.name, e.instructionIndex, e.eventIndex];
const keysOf = (evs: VaultEventRecord[]) => evs.map((e) => vaultEventKey(SIG, e));

describe("decodeVaultTransactionEvents", () => {
  it("decodes cpi and log sources to the same events and positions", () => {
    const tx = happyTx();
    const cpi = decodeVaultTransactionEvents(tx); // default source: cpi
    const log = decodeVaultTransactionEvents(tx, { source: "log" });

    expect(cpi.map(position)).toEqual([
      ["depositEvent", 1, 0],
      ["withdrawEvent", 2, 0],
    ]);
    expect(log.map(position)).toEqual(cpi.map(position));
    expect(cpi.every((e) => e.source === "cpi")).toBe(true);
    expect(log.every((e) => e.source === "log")).toBe(true);
    expect(keysOf(cpi)).toEqual([`${SIG}:cpi:1:0`, `${SIG}:cpi:2:0`]);
    expect(keysOf(log)).toEqual([`${SIG}:log:1:0`, `${SIG}:log:2:0`]);
    expect(log.map((e) => e.data)).toEqual(cpi.map((e) => e.data));

    const [dep, wd] = cpi;
    if (dep.name !== "depositEvent" || wd.name !== "withdrawEvent") throw new Error("order");
    expect(dep.data.amount).toBe(1_000_000_000n);
    expect(dep.data.vaultBalance).toBe(5_000_000_000n);
    expect(dep.data.timestamp).toBe(1_700_000_000n);
    expect(dep.data.user.equals(user)).toBe(true);
    expect(wd.data.requestId).toBe(42n);
    expect(wd.data.admin.equals(admin)).toBe(true);
  });

  it("numbers several events inside one top-level instruction", () => {
    const tx = legacyResponse({
      logMessages: [...vaultIxLogs("Deposit", [deposit1, deposit1]), ...vaultIxLogs("Deposit", [deposit1])],
      innerInstructions: [
        { index: 0, instructions: [eventCpi(deposit1), sysCpi, eventCpi(deposit1)] },
        { index: 1, instructions: [eventCpi(deposit1)] },
      ],
    });
    const expected = [
      ["depositEvent", 0, 0],
      ["depositEvent", 0, 1],
      ["depositEvent", 1, 0],
    ];
    expect(decodeVaultTransactionEvents(tx).map(position)).toEqual(expected);
    expect(decodeVaultTransactionEvents(tx, { source: "log" }).map(position)).toEqual(expected);
    // Identical payloads still get distinct keys.
    expect(new Set(keysOf(decodeVaultTransactionEvents(tx))).size).toBe(3);
  });

  it("returns [] for a failed transaction, for both sources", () => {
    const tx = happyTx();
    tx.meta!.err = { InstructionError: [2, { Custom: 1 }] };
    expect(decodeVaultTransactionEvents(tx)).toEqual([]);
    expect(decodeVaultTransactionEvents(tx, { source: "log" })).toEqual([]);
  });

  it("throws MissingTransactionDataError on null tx, null meta or missing data", () => {
    expect(() => decodeVaultTransactionEvents(null)).toThrow(MissingTransactionDataError);
    const noMeta = { ...happyTx(), meta: null };
    expect(() => decodeVaultTransactionEvents(noMeta)).toThrow(MissingTransactionDataError);
    const noLogs = happyTx();
    noLogs.meta!.logMessages = null;
    expect(() => decodeVaultTransactionEvents(noLogs, { source: "log" })).toThrow(
      MissingTransactionDataError,
    );
    const noInner = happyTx();
    noInner.meta!.innerInstructions = null;
    expect(() => decodeVaultTransactionEvents(noInner)).toThrow(MissingTransactionDataError);
    const truncated = happyTx();
    truncated.meta!.logMessages = [...truncated.meta!.logMessages!.slice(0, 5), "Log truncated"];
    expect(() => decodeVaultTransactionEvents(truncated, { source: "log" })).toThrow(/truncated/);
  });

  it("ignores event-shaped inner instructions from another program or authority", () => {
    const tx = legacyResponse({
      logMessages: [],
      innerInstructions: [
        {
          index: 0,
          instructions: [
            eventCpi(deposit1, 4), // System program, right authority account
            eventCpi(deposit1, PROGRAM_IX, 0), // vault program, wrong first account
            { ...eventCpi(deposit1), data: bs58.encode(deposit1) }, // no EVENT_IX_TAG
          ],
        },
      ],
    });
    expect(decodeVaultTransactionEvents(tx)).toEqual([]);
  });

  it("ignores Program data emitted while another program is executing", () => {
    const other = Keypair.generate().publicKey.toBase58();
    const tx = legacyResponse({
      logMessages: [
        `Program ${other} invoke [1]`,
        `Program data: ${deposit1.toString("base64")}`,
        `Program ${VAULT} invoke [2]`,
        `Program ${VAULT} success`,
        `Program data: ${deposit1.toString("base64")}`,
        `Program ${other} success`,
        ...vaultIxLogs("Deposit", [deposit1]),
      ],
      innerInstructions: [],
    });
    expect(decodeVaultTransactionEvents(tx, { source: "log" }).map(position)).toEqual([
      ["depositEvent", 1, 0],
    ]);
  });

  it("resolves v0 account keys through meta.loadedAddresses", () => {
    const lookupTable = Keypair.generate().publicKey;
    // static: user, admin; loaded writable: vaultState, poolVault;
    // loaded readonly: system, eventAuthority, program.
    const message = new MessageV0({
      header: { numRequiredSignatures: 2, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 },
      staticAccountKeys: [user, admin],
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      compiledInstructions: [
        { programIdIndex: 6, accountKeyIndexes: [0, 1, 2, 3, 4, 5, 6], data: new Uint8Array(24) },
      ],
      addressTableLookups: [
        { accountKey: lookupTable, writableIndexes: [0, 1], readonlyIndexes: [0, 1, 2] },
      ],
    });
    const tx: VersionedTransactionResponse = {
      slot: 1,
      version: 0,
      transaction: { signatures: [SIG], message },
      meta: {
        fee: 5000,
        preBalances: [],
        postBalances: [],
        err: null,
        logMessages: vaultIxLogs("Withdraw", [withdraw1]),
        loadedAddresses: {
          writable: [vaultState, poolVault],
          readonly: [SystemProgram.programId, eventAuthority, programId],
        },
        innerInstructions: [{ index: 0, instructions: [eventCpi(withdraw1, 6, 5)] }],
      },
    };
    const evs = decodeVaultTransactionEvents(tx);
    expect(evs.map(position)).toEqual([["withdrawEvent", 0, 0]]);
    expect(keysOf(evs)).toEqual([`${SIG}:cpi:0:0`]);
    expect(decodeVaultTransactionEvents(tx, { source: "log" }).map(position)).toEqual([
      ["withdrawEvent", 0, 0],
    ]);

    // Without loadedAddresses the indices cannot be resolved: refuse, don't guess.
    const missing = { ...tx, meta: { ...tx.meta!, loadedAddresses: undefined } };
    expect(() => decodeVaultTransactionEvents(missing)).toThrow(MissingTransactionDataError);
  });

  it("throws UndecodableEventError on a v0.1-layout payload instead of dropping it", () => {
    const tx = legacyResponse({
      logMessages: vaultIxLogs("Withdraw", [withdrawV01]),
      innerInstructions: [{ index: 0, instructions: [eventCpi(withdrawV01)] }],
    });
    for (const source of ["cpi", "log"] as const) {
      let err: unknown;
      try {
        decodeVaultTransactionEvents(tx, { source });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(UndecodableEventError);
      expect((err as UndecodableEventError).signature).toBe(SIG);
      expect((err as UndecodableEventError).instructionIndex).toBe(0);
    }
  });

  it("throws UndecodableEventError on trailing bytes or an unknown discriminator", () => {
    const longer = Buffer.concat([deposit1, Buffer.alloc(8)]);
    const unknown = Buffer.concat([Buffer.alloc(8, 7), deposit1.subarray(8)]);
    for (const payload of [longer, unknown]) {
      const tx = legacyResponse({
        logMessages: vaultIxLogs("Deposit", [payload]),
        innerInstructions: [{ index: 0, instructions: [eventCpi(payload)] }],
      });
      expect(() => decodeVaultTransactionEvents(tx)).toThrow(UndecodableEventError);
      expect(() => decodeVaultTransactionEvents(tx, { source: "log" })).toThrow(
        UndecodableEventError,
      );
    }
  });

  it("honours a custom programId", () => {
    const tx = happyTx();
    const other = Keypair.generate().publicKey;
    expect(decodeVaultTransactionEvents(tx, { programId: other })).toEqual([]);
    expect(decodeVaultTransactionEvents(tx, { programId: other, source: "log" })).toEqual([]);
  });
});
