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
  requestId: bigint;
  ownerKey: string;
  amount: bigint;
  destination: string;
  lastValidBlockHeight: number;
  status: HoldStatus;
  /** True for a house withdrawal (admin is both user and admin). */
  isHouse: boolean;
  createdAt: number;
  /** Set once settled from a finalized WithdrawEvent. */
  txSignature: string | null;
}

export type SettleOutcome =
  | { kind: "settled"; hold: Hold }
  | { kind: "already" } // idempotent: this hold was already settled
  | { kind: "mismatch"; hold: Hold } // request_id matched but user/amount did not
  | { kind: "notfound" }; // no hold for this request_id — possible leaked approval

export interface Ledger {
  ensureUser(ownerKey: string): void;
  getBalance(ownerKey: string): Balance;

  /**
   * Credits a deposit. Idempotent on `sourceKey` (the event's
   * `signature:ixIndex:eventIndex`): a replay or backfill of the same event
   * does not credit twice. Returns whether it was applied.
   */
  credit(ownerKey: string, amount: bigint, sourceKey: string): "credited" | "duplicate";

  /**
   * Atomically checks `available >= amount` and moves `amount` from
   * `available` to `pending`, allocating a fresh `requestId`. Throws
   * {@link InsufficientFundsError} if the balance is too low. This is the
   * debit-at-approval point.
   */
  placeHold(params: {
    ownerKey: string;
    amount: bigint;
    destination: string;
    lastValidBlockHeight: number;
  }): Hold;

  /**
   * Registers a house withdrawal (admin pays itself). No user balance is
   * touched, but it still gets a `requestId` so the listener can match its
   * WithdrawEvent and not treat it as a leaked approval.
   */
  placeHouseHold(params: {
    amount: bigint;
    destination: string;
    lastValidBlockHeight: number;
  }): Hold;

  /**
   * Settles a hold from a finalized, successful WithdrawEvent. On a match,
   * removes the pending amount (the debit is now final) and records the
   * signature. Idempotent. A `mismatch`/`notfound` is an incident: the caller
   * should pause the vault.
   */
  settleHold(params: {
    requestId: bigint;
    user: string;
    amount: bigint;
    txSignature: string;
  }): SettleOutcome;

  /** Returns `pending` to `available` for an expired, never-seen hold. */
  releaseHold(requestId: bigint): "released" | "cannot";

  getHold(requestId: bigint): Hold | null;
  listOpenHolds(): Hold[];

  /** Records a listener event source key; returns whether it is new. */
  recordEventSeen(sourceKey: string): "new" | "seen";

  /** Sum of every owner's `available` and `pending`, for reconciliation. */
  totals(): { available: bigint; pending: bigint };
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
