import type { Hold, Ledger } from "../ledger/types";

/**
 * Open holds named by a `WithdrawEvent mismatch` incident: a WithdrawEvent
 * carried their request_id but a different user/amount. The hold stays OPEN
 * (it was not the expected settlement), so once the kill-switch is cleared the
 * listener would RELEASE it on expiry — handing back a balance whose request
 * id was already used on chain. The operator must resolve each one first.
 */
export function openMismatchedHolds(ledger: Ledger): Hold[] {
  const ids = new Set<string>();
  for (const r of ledger.listIncidents()) {
    if (r.reason !== "WithdrawEvent mismatch") continue;
    try {
      const detail = JSON.parse(r.detail) as { requestId?: unknown };
      if (typeof detail.requestId === "string" && /^\d+$/.test(detail.requestId)) {
        ids.add(detail.requestId);
      }
    } catch {
      // Unparseable detail: nothing to match.
    }
  }
  const holds: Hold[] = [];
  for (const id of ids) {
    const hold = ledger.getHold(BigInt(id));
    if (hold?.status === "open") holds.push(hold);
  }
  return holds;
}

export type ClearIncidentResult =
  | { kind: "cleared" | "not_open" }
  | { kind: "refused"; holds: Hold[] };

/**
 * `npm run incident -- clear`: refuses while a mismatched hold is still open
 * (see {@link openMismatchedHolds}) unless `force` is set.
 */
export function clearIncidentChecked(
  ledger: Ledger,
  opts: { force?: boolean } = {},
): ClearIncidentResult {
  const holds = openMismatchedHolds(ledger);
  if (holds.length > 0 && !opts.force) return { kind: "refused", holds };
  return { kind: ledger.clearIncident() ? "cleared" : "not_open" };
}
