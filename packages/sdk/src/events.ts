import { BN, EventParser, type Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import type { CasinoVault } from "./idl/casino_vault";

/**
 * Event payloads, mirroring the program's `#[event]` structs. Lamport and
 * timestamp fields are normalized to `bigint`.
 *
 * Every event is emitted TWICE per instruction — once in the logs (`emit!`) and
 * once as a self-CPI (`emit_cpi!`). Consume ONE source. Event contents are NOT
 * unique, so de-duplicate on {@link EventSourceKey}, never on fields.
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

/**
 * The only safe de-duplication key for a vault event: where it came from.
 * Two identical deposits in one transaction produce identical payloads, so
 * de-duplicating on fields drops one; use `${signature}:${ixIndex}:${eventIndex}`.
 */
export interface EventSourceKey {
  signature: string;
  instructionIndex: number;
  eventIndex: number;
}

export function eventSourceKey(key: EventSourceKey): string {
  return `${key.signature}:${key.instructionIndex}:${key.eventIndex}`;
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
 * Parses every vault event out of a finalized transaction's log messages.
 *
 * Use this for the balance-authoritative listener: fetch finalized
 * transactions, SKIP any whose `meta.err` is set, and feed `meta.logMessages`
 * here. Anchor's websocket `addEventListener` already skips failed
 * transactions and is fine for fast UI updates, but not for balances.
 */
export function parseVaultEventsFromLogs(
  program: Program<CasinoVault>,
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
  program: Program<CasinoVault>,
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
