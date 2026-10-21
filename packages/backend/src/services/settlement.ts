import {
  parseVaultEventsFromLogs,
  type DecodedVaultEvent,
} from "@x2c-fun/casinovault-sdk";
import type { Ledger } from "../ledger/types";
import type { ServiceContext } from "../context";

export interface SettlementHandlers {
  /**
   * Raised when a WithdrawEvent does not match an open hold (wrong/unknown
   * request_id, or user/amount differ). This is exactly what a leaked admin
   * key produces — pause the vault and alert BEFORE anything else.
   */
  onIncident(reason: string, detail: Record<string, unknown>): void | Promise<void>;
  /** Optional: observe each applied event (logging/metrics). */
  onEvent?(event: DecodedVaultEvent, sourceKey: string): void;
}

/**
 * Applies a finalized transaction's decoded events to the ledger. PURE w.r.t.
 * the chain (takes already-parsed events), so it is unit-testable without a
 * validator.
 *
 * Rules enforced here (docs/backend-integration.md):
 * - Credit deposits and settle withdrawals only; both idempotent.
 * - De-duplicate by source position `${signature}:${index}`, never by content.
 * - An unmatched WithdrawEvent is an incident.
 *
 * The CALLER must have already dropped transactions whose `meta.err` is set and
 * fetched these at `finalized` commitment.
 */
export async function applyParsedEvents(
  ledger: Ledger,
  signature: string,
  events: DecodedVaultEvent[],
  handlers: SettlementHandlers,
): Promise<void> {
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const sourceKey = `${signature}:${i}`;
    handlers.onEvent?.(event, sourceKey);

    if (event.name === "depositEvent") {
      ledger.credit(event.data.user.toBase58(), event.data.amount, sourceKey);
      continue;
    }

    if (event.name === "withdrawEvent") {
      if (ledger.recordEventSeen(sourceKey) === "seen") continue;
      const outcome = ledger.settleHold({
        requestId: event.data.requestId,
        user: event.data.user.toBase58(),
        amount: event.data.amount,
        txSignature: signature,
      });
      if (outcome.kind === "notfound" || outcome.kind === "mismatch") {
        await handlers.onIncident("unmatched WithdrawEvent", {
          signature,
          requestId: event.data.requestId.toString(),
          user: event.data.user.toBase58(),
          amount: event.data.amount.toString(),
          outcome: outcome.kind,
        });
      }
      continue;
    }

    // pause / admin / limits events are informational; record them for dedup.
    ledger.recordEventSeen(sourceKey);
  }
}

/**
 * Fetches a finalized transaction, drops it if it failed, parses its events and
 * applies them. Returns false when the transaction was not found or failed.
 */
export async function settleTransaction(
  ctx: ServiceContext,
  signature: string,
  handlers: SettlementHandlers,
): Promise<boolean> {
  const tx = await ctx.connection.getTransaction(signature, {
    commitment: "finalized",
    maxSupportedTransactionVersion: 0,
  });
  // Ignore every transaction whose meta.err is set: its events are rolled back
  // but still present in the logs, and crediting them hands out free balance.
  if (!tx || tx.meta?.err || !tx.meta?.logMessages) return false;
  const events = parseVaultEventsFromLogs(ctx.program, tx.meta.logMessages);
  await applyParsedEvents(ctx.ledger, signature, events, handlers);
  return true;
}
