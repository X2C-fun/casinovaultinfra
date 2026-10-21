import type { Hold, SettleOutcome } from "./types";

/**
 * The matching rules for a WithdrawEvent against the hold its `request_id`
 * names, shared by both ledgers so they cannot drift. Returns `settled` when
 * the caller may apply the settlement; every other kind except `already` is an
 * incident.
 *
 * - no hold                                   → notfound
 * - released hold (we refunded it already)    → released
 * - settled hold:
 *     same tx signature, same event key (when known), same user/amount
 *                                             → already (idempotent replay)
 *     anything else                           → replay (a SECOND payout)
 * - open hold whose user/amount differ        → mismatch
 * - open house hold whose user is not admin   → mismatch
 */
export function evaluateSettle(
  hold: Hold | null,
  ev: { user: string; amount: bigint; txSignature: string; eventKey?: string },
  adminKey: string | undefined,
): SettleOutcome {
  if (!hold) return { kind: "notfound" };
  if (hold.status === "released") return { kind: "released", hold };
  const fieldsMatch = hold.destination === ev.user && hold.amount === ev.amount;
  if (hold.status === "settled") {
    const sameEvent =
      hold.txSignature === ev.txSignature &&
      (ev.eventKey === undefined ||
        hold.settledEventKey === null ||
        hold.settledEventKey === ev.eventKey);
    return sameEvent && fieldsMatch ? { kind: "already" } : { kind: "replay", hold };
  }
  if (!fieldsMatch) return { kind: "mismatch", hold };
  if (hold.isHouse && (adminKey === undefined || ev.user !== adminKey)) {
    return { kind: "mismatch", hold };
  }
  return { kind: "settled", hold };
}
