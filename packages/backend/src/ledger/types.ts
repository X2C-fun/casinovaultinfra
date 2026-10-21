/**
 * The ledger is the component that actually keeps the pool solvent. The vault
 * program is custody-only: it cannot tell whether two withdrawal approvals
 * spend the same off-chain balance, so every balance rule lives here.
 *
 * The interface is intentionally SYNCHRONOUS. `placeHold` must check the
 * balance and move it to `pending` with no `await` in between, or a user could
 * race two approvals through the gap (see docs/backend-integration.md). A
 * synchronous store (in-memory, or better-sqlite3) makes that critical section
 * trivially correct. A real async database must reproduce the same atomicity
 * with a transaction / `SELECT … FOR UPDATE`.
 *
 * The HTTP API, the listener and the reconcile job MUST share one durable
 * ledger (the same SQLite file): holds placed by the API are settled and
 * released by the listener, and the incident kill-switch set by the listener
 * must block approvals in the API.
 */

/** An owner's off-chain balance, in lamports. */
export interface Balance {
  ownerKey: string;
  /** Spendable now. */
  available: bigint;
  /** Locked behind an open withdrawal hold. */
  pending: bigint;
}

export type HoldStatus = "open" | "settled" | "released";

/**
 * A withdrawal hold. Its `requestId` is passed to the program as the withdraw
 * `request_id` and echoed in `WithdrawEvent`, so the listener settles exactly
 * this hold instead of guessing by amount.
 */
export interface Hold {
  /** Random u64, unique in the ledger (never sequential, never reused). */
  requestId: bigint;
  ownerKey: string;
  amount: bigint;
  /** Always equal to `ownerKey` (player hold) or the admin key (house hold). */
  destination: string;
  lastValidBlockHeight: number;
  status: HoldStatus;
  /** True for a house withdrawal (admin is both user and admin). */
  isHouse: boolean;
  createdAt: number;
  /** Set once settled from a finalized WithdrawEvent. */
  txSignature: string | null;
  /** The exact event source key (`sig:ix:event`) that settled this hold. */
  settledEventKey: string | null;
}

export type SettleOutcome =
  | { kind: "settled"; hold: Hold }
  /** Idempotent replay of the very event that settled this hold. */
  | { kind: "already" }
  /** request_id matched an open hold but user/amount did not (or a house hold paid a non-admin). */
  | { kind: "mismatch"; hold: Hold }
  /** request_id of a hold that was already settled by a DIFFERENT event: a second payout. */
  | { kind: "replay"; hold: Hold }
  /** request_id of a hold that was released as expired: a payout we already refunded. */
  | { kind: "released"; hold: Hold }
  /** No hold for this request_id — possible leaked approval. */
  | { kind: "notfound" };

/** Outcomes of {@link Ledger.applyWithdrawEvent} that mean "pause the vault". */
export function isIncidentOutcome(
  o: SettleOutcome | { kind: "duplicate" },
): o is Extract<SettleOutcome, { kind: "mismatch" | "replay" | "released" | "notfound" }> {
  return o.kind === "mismatch" || o.kind === "replay" || o.kind === "released" || o.kind === "notfound";
}

/** The durable local kill-switch. While open, no withdrawal is approved. */
export interface IncidentState {
  reason: string;
  openedAt: number;
}

/** One entry in the append-only incident log. */
export interface IncidentRecord {
  at: number;
  reason: string;
  detail: string;
}

export interface ListenerProgress {
  /** Signature of the newest fully processed transaction. */
  cursor: string | null;
  /** Slot of that transaction. */
  slot: number | null;
  /**
   * Finalized block height measured at the start of the newest cycle that
   * drained the backlog completely (see listener.ts for why this is safe).
   */
  drainedThroughBlockHeight: number | null;
}

export interface LedgerOptions {
  /**
   * The vault admin's public key (base58). Required for house withdrawals
   * (destination must equal it) and to route admin-wallet deposits to the
   * house bankroll instead of a player balance.
   */
  adminKey?: string;
  /** Request-ID source. Default: a cryptographically random non-zero u64. */
  requestIdGenerator?: () => bigint;
  /**
   * TEST HOOK: called between the steps of an atomic section. Throwing from it
   * simulates a crash; the section must then leave no partial effect.
   */
  failpoint?: (step: string) => void;
}

export interface Ledger {
  ensureUser(ownerKey: string): void;
  getBalance(ownerKey: string): Balance;

  /**
   * Credits a deposit to a player balance. Idempotent on `sourceKey`, atomic.
   * Prefer {@link applyDepositEvent}, which also routes admin deposits.
   */
  credit(ownerKey: string, amount: bigint, sourceKey: string): "credited" | "duplicate";

  /**
   * Atomically: de-duplicate on `sourceKey`, then credit the depositor — or the
   * house bankroll when the depositor is the admin wallet.
   */
  applyDepositEvent(
    sourceKey: string,
    event: { user: string; amount: bigint },
  ): "credited" | "house" | "duplicate";

  /**
   * Atomically: de-duplicate on `sourceKey`, settle the matching hold, and —
   * when the outcome is an incident — open the kill-switch, all in ONE
   * transaction. A crash leaves either all of it or none of it.
   */
  applyWithdrawEvent(
    sourceKey: string,
    event: { requestId: bigint; user: string; amount: bigint; txSignature: string },
  ): SettleOutcome | { kind: "duplicate" };

  /**
   * Atomically checks `available >= amount` and moves `amount` from
   * `available` to `pending`, allocating a fresh random `requestId`. Throws
   * {@link InsufficientFundsError} if the balance is too low,
   * {@link IncidentOpenError} while the kill-switch is set, and
   * {@link DestinationMismatchError} unless `destination === ownerKey`.
   */
  placeHold(params: {
    ownerKey: string;
    amount: bigint;
    destination: string;
    lastValidBlockHeight: number;
  }): Hold;

  /**
   * Registers a house withdrawal (admin pays itself) against the tracked house
   * bankroll. Throws unless `destination` is the configured admin key.
   */
  placeHouseHold(params: {
    amount: bigint;
    destination: string;
    lastValidBlockHeight: number;
  }): Hold;

  /**
   * Settles a hold from a finalized, successful WithdrawEvent. `already` only
   * for a replay of the same transaction (and, when given, the same event
   * key); any other event for a settled/released/unknown request_id is an
   * incident. Prefer {@link applyWithdrawEvent}.
   */
  settleHold(params: {
    requestId: bigint;
    user: string;
    amount: bigint;
    txSignature: string;
    eventKey?: string;
  }): SettleOutcome;

  /** Returns `pending` to `available` for an expired, never-seen hold. */
  releaseHold(requestId: bigint): "released" | "cannot";

  getHold(requestId: bigint): Hold | null;
  listOpenHolds(): Hold[];

  /** Records a listener event source key; returns whether it is new. */
  recordEventSeen(sourceKey: string): "new" | "seen";

  /** House bankroll tracked from admin deposits minus house withdrawals. */
  houseBalance(): { available: bigint; pending: bigint };

  /** Sum of every PLAYER's `available` and `pending` (house excluded). */
  totals(): { available: bigint; pending: bigint };

  // --- incident kill-switch -------------------------------------------------
  getIncident(): IncidentState | null;
  /** Sets the kill-switch (keeps the first reason) and logs the incident. */
  openIncident(reason: string, detail?: Record<string, unknown>): void;
  /** Manual operator action only. Returns whether it was open. */
  clearIncident(): boolean;
  listIncidents(): IncidentRecord[];

  // --- listener progress ------------------------------------------------------
  getProgress(): ListenerProgress;
  getCursor(): string | null;
  /** Advances the cursor to a fully processed signature (and its slot). */
  setCursor(signature: string, slot?: number): void;
  setDrainedThroughBlockHeight(height: number): void;

  // --- listener lease ---------------------------------------------------------
  /**
   * Takes or renews the single-listener lease: succeeds when it is free,
   * expired, or already held by `holder`; the expiry becomes `now + ttlMs`.
   * Two listeners on one ledger would race the cursor, so only the holder may
   * run a cycle.
   */
  acquireListenerLease(holder: string, ttlMs: number, now?: number): boolean;
  /** Gives the lease up (only if `holder` holds it). */
  releaseListenerLease(holder: string): void;

  close(): void;
}

export class InsufficientFundsError extends Error {
  constructor(
    readonly ownerKey: string,
    readonly requested: bigint,
    readonly available: bigint,
  ) {
    super(
      `insufficient funds for ${ownerKey}: requested ${requested}, available ${available}`,
    );
    this.name = "InsufficientFundsError";
  }
}

export class IncidentOpenError extends Error {
  constructor(readonly reason: string) {
    super(`withdrawals are blocked: incident open (${reason})`);
    this.name = "IncidentOpenError";
  }
}

export class DestinationMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DestinationMismatchError";
  }
}

/** Cryptographically random, non-zero u64 for `request_id`. */
export function randomRequestId(): bigint {
  const buf = new BigUint64Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(buf);
    if (buf[0] !== 0n) return buf[0];
  }
}

export const U64_MAX = (1n << 64n) - 1n;

export function assertU64RequestId(id: bigint): void {
  if (id <= 0n || id > U64_MAX) throw new Error("request id must be a non-zero u64");
}
