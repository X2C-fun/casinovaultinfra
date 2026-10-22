// Explicit import: `Buffer` is not a browser global. Node resolves this to its
// built-in module; bundlers resolve it to the `buffer` package (a dependency).
import { Buffer } from "buffer";
import type { Program as AnchorProgram, Provider } from "@coral-xyz/anchor";
import {
  PublicKey,
  type TransactionResponse,
  type VersionedTransactionResponse,
} from "@solana/web3.js";
import { BN, EventParser, Program, bs58 } from "./anchor";
import type { CasinoVault } from "./idl/casino_vault";
import { CASINO_VAULT_IDL } from "./idl";
import { DEFAULT_PROGRAM_ID } from "./constants";
import { deriveEventAuthorityPda } from "./pdas";

/**
 * Event payloads, mirroring the program's `#[event]` structs. Lamport and
 * timestamp fields are normalized to `bigint`.
 *
 * `DepositEvent` and `WithdrawEvent` are emitted TWICE per instruction — once
 * in the logs (`emit!`) and once as a self-CPI (`emit_cpi!`); the admin events
 * are emitted in the logs only. Consume ONE source. Event contents are NOT
 * unique, so de-duplicate on {@link vaultEventKey}, never on fields.
 */
export interface VaultInitializedEvent {
  authority: PublicKey;
  admin: PublicKey;
  vaultBump: number;
  rentReserve: bigint;
  vaultBalance: bigint;
  timestamp: bigint;
}

export interface DepositEvent {
  user: PublicKey;
  amount: bigint;
  vaultBalance: bigint;
  timestamp: bigint;
}

export interface WithdrawEvent {
  user: PublicKey;
  admin: PublicKey;
  requestId: bigint;
  amount: bigint;
  vaultBalance: bigint;
  timestamp: bigint;
}

export interface PauseStateChangedEvent {
  admin: PublicKey;
  paused: boolean;
  timestamp: bigint;
}

export interface AdminProposedEvent {
  authority: PublicKey;
  currentAdmin: PublicKey;
  pendingAdmin: PublicKey | null;
  timestamp: bigint;
}

export interface AdminChangedEvent {
  previousAdmin: PublicKey;
  newAdmin: PublicKey;
  timestamp: bigint;
}

export interface LimitsUpdatedEvent {
  authority: PublicKey;
  maxWithdrawPerTx: bigint;
  maxWithdrawPerWindow: bigint;
  windowSeconds: number;
  timestamp: bigint;
}

/** Maps an event name to its decoded payload type. */
export interface VaultEventMap {
  vaultInitializedEvent: VaultInitializedEvent;
  depositEvent: DepositEvent;
  withdrawEvent: WithdrawEvent;
  pauseStateChangedEvent: PauseStateChangedEvent;
  adminProposedEvent: AdminProposedEvent;
  adminChangedEvent: AdminChangedEvent;
  limitsUpdatedEvent: LimitsUpdatedEvent;
}

export type VaultEventName = keyof VaultEventMap;

/** A decoded event tagged with its name. */
export type DecodedVaultEvent = {
  [K in VaultEventName]: { name: K; data: VaultEventMap[K] };
}[VaultEventName];

/** Where an event was read from: program logs (`emit!`) or the self-CPI (`emit_cpi!`). */
export type VaultEventSource = "log" | "cpi";

/**
 * A decoded event plus its position in the transaction. `(signature, source,
 * instructionIndex, eventIndex)` identifies it uniquely; see {@link vaultEventKey}.
 */
export type VaultEventRecord = {
  [K in VaultEventName]: {
    name: K;
    data: VaultEventMap[K];
    source: VaultEventSource;
    /** Index of the TOP-LEVEL instruction the event belongs to. */
    instructionIndex: number;
    /** 0-based ordinal of the event within that top-level instruction, for this source. */
    eventIndex: number;
  };
}[VaultEventName];

/**
 * The transaction (or the part of it the requested source needs) is missing:
 * `null` from `getTransaction`, `meta: null`, no `logMessages`/
 * `innerInstructions`, truncated logs, or unresolved address-table lookups.
 * Retry the fetch; never treat this as "no events".
 */
export class MissingTransactionDataError extends Error {
  readonly signature?: string;
  constructor(message: string, signature?: string) {
    super(message);
    this.name = "MissingTransactionDataError";
    this.signature = signature;
  }
}

/**
 * A payload emitted by the vault program could not be decoded with the v0.2
 * IDL (e.g. a v0.1-layout event, or an unknown discriminator). Raised instead
 * of silently dropping the event: decode such transactions with the matching
 * IDL, or reconcile them by hand.
 */
export class UndecodableEventError extends Error {
  readonly signature?: string;
  readonly instructionIndex?: number;
  constructor(message: string, signature?: string, instructionIndex?: number) {
    super(message);
    this.name = "UndecodableEventError";
    this.signature = signature;
    this.instructionIndex = instructionIndex;
  }
}

/**
 * The only safe de-duplication key for a vault event: where it came from.
 * Two identical deposits in one transaction produce identical payloads, so
 * de-duplicating on fields drops one.
 *
 * @deprecated Use {@link vaultEventKey}, which also includes the source.
 */
export interface EventSourceKey {
  signature: string;
  instructionIndex: number;
  eventIndex: number;
}

/** @deprecated Use {@link vaultEventKey}, which also includes the source. */
export function eventSourceKey(key: EventSourceKey): string {
  return `${key.signature}:${key.instructionIndex}:${key.eventIndex}`;
}

/**
 * Unique, restart-safe key for a decoded event:
 * `${signature}:${source}:${instructionIndex}:${eventIndex}`. Store it with a
 * UNIQUE constraint and upsert on it.
 */
export function vaultEventKey(signature: string, ev: VaultEventRecord): string {
  return `${signature}:${ev.source}:${ev.instructionIndex}:${ev.eventIndex}`;
}

function normalize(value: unknown): unknown {
  if (value instanceof BN) return BigInt((value as BN).toString());
  return value;
}

// Fields that must be surfaced as bigint regardless of source.
const BIGINT_FIELDS = new Set([
  "amount",
  "vaultBalance",
  "rentReserve",
  "requestId",
  "timestamp",
  "maxWithdrawPerTx",
  "maxWithdrawPerWindow",
  "windowStart",
  "windowWithdrawn",
]);

function normalizeEvent(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = BIGINT_FIELDS.has(k) ? normalize(v) : v;
  }
  return out;
}

/**
 * Anchor's `EVENT_IX_TAG` (`0x1d9acb512ea545e4` as little-endian bytes): the
 * prefix of every `emit_cpi!` self-CPI's instruction data.
 */
export const EVENT_IX_TAG = Uint8Array.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

type VaultCoder = AnchorProgram<CasinoVault>["coder"];
let cachedCoder: VaultCoder | undefined;

/** The program's own Borsh coder (camelCased IDL), built once without a connection. */
function vaultCoder(): VaultCoder {
  if (!cachedCoder) {
    // The Program constructor only stores the provider; nothing here touches it.
    cachedCoder = new Program<CasinoVault>(CASINO_VAULT_IDL, {} as Provider).coder;
  }
  return cachedCoder;
}

/**
 * Decodes one event payload (8-byte event discriminator + Borsh fields) with
 * the v0.2 IDL. Throws {@link UndecodableEventError} on an unknown
 * discriminator, a short payload, or trailing bytes — all signs of a
 * different layout.
 */
function decodeEventPayload(
  payload: Uint8Array,
  signature: string | undefined,
  instructionIndex: number,
): DecodedVaultEvent {
  const coder = vaultCoder();
  const fail = (why: string): never => {
    throw new UndecodableEventError(
      `vault event in instruction ${instructionIndex}${signature ? ` of ${signature}` : ""} ` +
        `cannot be decoded with the v0.2 IDL (${why}); it may be a v0.1-layout event`,
      signature,
      instructionIndex,
    );
  };
  let decoded: { name: string; data: unknown } | null = null;
  try {
    decoded = coder.events.decode(Buffer.from(payload).toString("base64"));
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
  if (!decoded) return fail("unknown event discriminator");
  // Anchor ignores trailing bytes; re-encode to insist on an exact layout match.
  let encodedLen = -1;
  try {
    encodedLen = coder.types.encode(decoded.name, decoded.data).length;
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
  if (encodedLen !== payload.length - 8) {
    fail(`payload is ${payload.length - 8} bytes, layout is ${encodedLen}`);
  }
  return {
    name: decoded.name as VaultEventName,
    data: normalizeEvent(decoded.data as Record<string, unknown>),
  } as unknown as DecodedVaultEvent;
}

function startsWith(data: Uint8Array, prefix: Uint8Array): boolean {
  if (data.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (data[i] !== prefix[i]) return false;
  return true;
}

type AnyTxResponse = TransactionResponse | VersionedTransactionResponse;

/** Static keys, then `loadedAddresses` writable, then readonly (v0 order). */
function resolveAccountKeys(tx: AnyTxResponse, signature: string | undefined): PublicKey[] {
  const message = tx.transaction.message as {
    staticAccountKeys?: PublicKey[];
    accountKeys?: PublicKey[];
    addressTableLookups?: unknown[];
  };
  const statics = message.staticAccountKeys ?? message.accountKeys;
  if (!statics) {
    throw new MissingTransactionDataError("transaction message has no account keys", signature);
  }
  const keys = statics.map((k) => new PublicKey(k));
  const loaded = tx.meta?.loadedAddresses;
  if ((message.addressTableLookups?.length ?? 0) > 0 && !loaded) {
    throw new MissingTransactionDataError(
      "v0 transaction uses address-table lookups but meta.loadedAddresses is missing",
      signature,
    );
  }
  if (loaded) {
    for (const k of loaded.writable ?? []) keys.push(new PublicKey(k));
    for (const k of loaded.readonly ?? []) keys.push(new PublicKey(k));
  }
  return keys;
}

function decodeCpiEvents(
  tx: AnyTxResponse,
  programId: PublicKey,
  signature: string | undefined,
): VaultEventRecord[] {
  const inner = tx.meta!.innerInstructions;
  if (inner == null) {
    throw new MissingTransactionDataError(
      "meta.innerInstructions is missing; cannot read emit_cpi! events",
      signature,
    );
  }
  const keys = resolveAccountKeys(tx, signature);
  const [eventAuthority] = deriveEventAuthorityPda(programId);
  const out: VaultEventRecord[] = [];
  const groups = [...inner].sort((a, b) => a.index - b.index);
  for (const group of groups) {
    let eventIndex = 0;
    for (const ix of group.instructions) {
      const program = keys[ix.programIdIndex];
      if (!program || !program.equals(programId)) continue;
      const first = ix.accounts.length > 0 ? keys[ix.accounts[0]] : undefined;
      if (!first || !first.equals(eventAuthority)) continue;
      const data = bs58.decode(ix.data);
      if (!startsWith(data, EVENT_IX_TAG)) continue;
      const ev = decodeEventPayload(data.subarray(EVENT_IX_TAG.length), signature, group.index);
      out.push({
        ...ev,
        source: "cpi",
        instructionIndex: group.index,
        eventIndex: eventIndex++,
      } as VaultEventRecord);
    }
  }
  return out;
}

const INVOKE_RE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[(\d+)\]$/;
const SUCCESS_RE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) success$/;
const FAILED_RE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) failed/;
const PROGRAM_DATA = "Program data: ";

function decodeLogEvents(
  tx: AnyTxResponse,
  programId: PublicKey,
  signature: string | undefined,
): VaultEventRecord[] {
  const logs = tx.meta!.logMessages;
  if (logs == null) {
    throw new MissingTransactionDataError(
      "meta.logMessages is missing; cannot read emit! events",
      signature,
    );
  }
  const vault = programId.toBase58();
  const out: VaultEventRecord[] = [];
  const stack: string[] = [];
  let instructionIndex = -1;
  let eventIndex = 0;
  for (const log of logs) {
    if (log === "Log truncated") {
      throw new MissingTransactionDataError(
        'transaction logs are truncated; events may be missing (use source "cpi")',
        signature,
      );
    }
    const invoke = INVOKE_RE.exec(log);
    if (invoke) {
      const depth = Number(invoke[2]);
      if (depth === 1) {
        instructionIndex++;
        eventIndex = 0;
        stack.length = 0;
      } else if (stack.length !== depth - 1) {
        throw new MissingTransactionDataError(
          `inconsistent invoke depth in logs: "${log}"`,
          signature,
        );
      }
      stack.push(invoke[1]);
      continue;
    }
    if (SUCCESS_RE.test(log) || FAILED_RE.test(log)) {
      stack.pop();
      continue;
    }
    if (log.startsWith(PROGRAM_DATA) && stack[stack.length - 1] === vault) {
      const payload = Buffer.from(log.slice(PROGRAM_DATA.length), "base64");
      const ev = decodeEventPayload(payload, signature, instructionIndex);
      out.push({
        ...ev,
        source: "log",
        instructionIndex,
        eventIndex: eventIndex++,
      } as VaultEventRecord);
    }
  }
  return out;
}

/**
 * Decodes every vault event in a fetched transaction — the API a
 * balance-authoritative listener should use.
 *
 * - `tx` (or `tx.meta`) `null` → throws {@link MissingTransactionDataError}.
 *   Retry; never treat it as "no events".
 * - `meta.err` set → returns `[]`. A failed transaction is rolled back, but its
 *   logs AND inner instructions still contain the events emitted before the
 *   failure; crediting them would hand out free balance.
 * - `source: "cpi"` (default, recommended): reads the `emit_cpi!` self-CPIs
 *   from `meta.innerInstructions` — only inner instructions to the vault
 *   program whose first account is its `__event_authority` PDA and whose data
 *   starts with Anchor's `EVENT_IX_TAG`. Immune to log truncation. Only
 *   `DepositEvent` and `WithdrawEvent` are emitted this way.
 * - `source: "log"`: reads `Program data:` lines from `meta.logMessages`,
 *   counting only lines emitted while the vault program is executing.
 *   Throws {@link MissingTransactionDataError} if logs are missing or
 *   truncated.
 * - A vault payload that the v0.2 IDL cannot decode (e.g. a v0.1-layout event)
 *   throws {@link UndecodableEventError} instead of being dropped.
 *
 * Consume ONE source and key rows with {@link vaultEventKey}.
 * Fetch with `maxSupportedTransactionVersion: 0` so v0 transactions resolve.
 */
export function decodeVaultTransactionEvents(
  tx: TransactionResponse | VersionedTransactionResponse | null,
  opts: { programId?: PublicKey; source?: VaultEventSource } = {},
): VaultEventRecord[] {
  if (!tx) throw new MissingTransactionDataError("transaction not found (null response)");
  const signature = tx.transaction?.signatures?.[0];
  if (!tx.meta) {
    throw new MissingTransactionDataError("transaction has no meta", signature);
  }
  if (tx.meta.err) return [];
  const programId = opts.programId ?? DEFAULT_PROGRAM_ID;
  const source = opts.source ?? "cpi";
  if (source === "cpi") return decodeCpiEvents(tx, programId, signature);
  if (source === "log") return decodeLogEvents(tx, programId, signature);
  throw new TypeError(`unknown event source: ${String(source)}`);
}

/**
 * LOW-LEVEL helper: parses vault events out of raw log messages with Anchor's
 * `EventParser`.
 *
 * It does NOT check `meta.err` (a failed transaction's logs still contain the
 * events emitted before the failure), does NOT detect truncated logs, gives no
 * instruction attribution, and silently skips payloads it cannot decode. For
 * settlement use {@link decodeVaultTransactionEvents} instead.
 */
export function parseVaultEventsFromLogs(
  program: AnchorProgram<CasinoVault>,
  logs: string[],
): DecodedVaultEvent[] {
  const parser = new EventParser(program.programId, program.coder);
  const out: DecodedVaultEvent[] = [];
  for (const event of parser.parseLogs(logs)) {
    out.push({
      name: event.name as VaultEventName,
      data: normalizeEvent(event.data as Record<string, unknown>),
    } as unknown as DecodedVaultEvent);
  }
  return out;
}

/**
 * Subscribes to one vault event over the websocket (fast, UI-grade — NOT for
 * balances). Returns the listener id; pass it to `program.removeEventListener`.
 */
export function onVaultEvent<K extends VaultEventName>(
  program: AnchorProgram<CasinoVault>,
  name: K,
  handler: (data: VaultEventMap[K], slot: number, signature: string) => void,
): number {
  return program.addEventListener(name as never, (data, slot, signature) => {
    handler(
      normalizeEvent(data as Record<string, unknown>) as unknown as VaultEventMap[K],
      slot,
      signature,
    );
  });
}
