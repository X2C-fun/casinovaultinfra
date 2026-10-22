import { vaultEventKey, type VaultEventRecord } from "@x2c-fun/casinovault-sdk";
import { isIncidentOutcome, type Ledger } from "../ledger/types";

export interface SettlementHandlers {
  /**
   * Raised when a WithdrawEvent does not match an open hold (unknown
   * request_id, user/amount differ, a second payout for a settled hold, a
   * payout for a released hold, or a house hold paid to a non-admin). This is
   * exactly what a leaked admin key produces. By the time this runs the ledger
   * has ALREADY set the durable kill-switch (in the same DB transaction that
   * recorded the event); the handler alerts and pauses the vault on chain.
   */
  onIncident(reason: string, detail: Record<string, unknown>): void | Promise<void>;
  /** Optional: observe each applied event (logging/metrics). */
  onEvent?(event: VaultEventRecord, sourceKey: string): void;
}

/**
 * Applies a finalized, successful transaction's decoded events (from ONE
 * source — the listener uses emit_cpi) to the ledger. Pure w.r.t. the chain,
 * so it is unit-testable without a validator.
 *
 * Rules enforced here (docs/backend-integration.md):
 * - De-duplicate by source position `vaultEventKey(signature, ev)` =
 *   `${signature}:${source}:${instructionIndex}:${eventIndex}`, never by content.
 * - Seen-marking and the balance effect are ONE atomic ledger operation
 *   (`applyDepositEvent` / `applyWithdrawEvent`), so a crash cannot mark an
 *   event seen without applying it, or apply it twice.
 * - Deposits from the admin wallet credit the house bankroll, not a player.
 * - Any WithdrawEvent that is not the expected settlement of an open hold is
 *   an incident.
 *
 * The CALLER must have dropped failed transactions (`meta.err`) and fetched at
 * `finalized` commitment.
 */
export async function applyVaultEvents(
  ledger: Ledger,
  signature: string,
  events: VaultEventRecord[],
  handlers: SettlementHandlers,
): Promise<{ incidents: number }> {
  let incidents = 0;
  for (const ev of events) {
    const sourceKey = vaultEventKey(signature, ev);
    handlers.onEvent?.(ev, sourceKey);

    if (ev.name === "depositEvent") {
      ledger.applyDepositEvent(sourceKey, {
        user: ev.data.user.toBase58(),
        amount: ev.data.amount,
      });
      continue;
    }

    if (ev.name === "withdrawEvent") {
      const outcome = ledger.applyWithdrawEvent(sourceKey, {
        requestId: ev.data.requestId,
        user: ev.data.user.toBase58(),
        amount: ev.data.amount,
        txSignature: signature,
      });
      if (isIncidentOutcome(outcome)) {
        incidents++;
        await handlers.onIncident(`unmatched WithdrawEvent (${outcome.kind})`, {
          signature,
          sourceKey,
          requestId: ev.data.requestId.toString(),
          user: ev.data.user.toBase58(),
          amount: ev.data.amount.toString(),
          outcome: outcome.kind,
        });
      }
      continue;
    }

    // pause / admin / limits events are informational; record them for dedup.
    ledger.recordEventSeen(sourceKey);
  }
  return { incidents };
}
