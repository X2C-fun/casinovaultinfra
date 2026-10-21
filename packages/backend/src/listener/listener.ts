import type { ServiceContext } from "../context";
import { settleTransaction, type SettlementHandlers } from "../services/settlement";
import { pauseVault } from "../services/pause";

/**
 * How far past a hold's `lastValidBlockHeight` the finalized tip must be before
 * the hold is released. The transaction can no longer land past its
 * `lastValidBlockHeight`; the margin only guards against the listener lagging.
 */
const RELEASE_SAFETY_BLOCKS = 150;

export interface ListenerOptions {
  /** Poll interval in ms. */
  intervalMs?: number;
  /** Max signatures to fetch per poll. */
  pageSize?: number;
}

/**
 * The finalized settlement listener. Each cycle:
 *  1. fetch new finalized signatures for the program since the last cursor,
 *  2. settle each (credit deposits, settle withdrawals, raise incidents),
 *  3. advance the cursor,
 *  4. release holds that have expired and were never seen.
 *
 * A single long-lived loop; call {@link runListener} to start it. State lives in
 * the ledger (via the SqliteLedger cursor), so a restart resumes cleanly.
 */
export async function pollOnce(
  ctx: ServiceContext,
  getCursor: () => string | null,
  setCursor: (sig: string) => void,
  pageSize = 200,
): Promise<number> {
  const handlers: SettlementHandlers = {
    onIncident: async (reason, detail) => {
      console.error(`[INCIDENT] ${reason}`, detail);
      try {
        const sig = await pauseVault(ctx);
        console.error(`[INCIDENT] vault paused (${sig})`);
      } catch (err) {
        console.error("[INCIDENT] FAILED TO PAUSE — pause manually now", err);
      }
    },
  };

  const until = getCursor() ?? undefined;
  const sigs = await ctx.connection.getSignaturesForAddress(
    ctx.config.programId,
    { until, limit: pageSize },
    "finalized",
  );
  if (sigs.length === 0) return 0;

  // getSignaturesForAddress returns newest-first; process oldest-first so the
  // cursor only advances over fully-processed transactions.
  const ordered = [...sigs].reverse();
  let processed = 0;
  for (const info of ordered) {
    if (info.err) {
      // Failed on chain: its events are rolled back. Skip, but still advance
      // the cursor past it.
      setCursor(info.signature);
      continue;
    }
    await settleTransaction(ctx, info.signature, handlers);
    setCursor(info.signature);
    processed++;
  }
  return processed;
}

/** Releases open holds whose transaction can no longer land. */
export async function releaseExpiredHolds(ctx: ServiceContext): Promise<number> {
  const tip = await ctx.connection.getBlockHeight("finalized");
  let released = 0;
  for (const hold of ctx.ledger.listOpenHolds()) {
    if (tip > hold.lastValidBlockHeight + RELEASE_SAFETY_BLOCKS) {
      // The listener has settled every finalized tx up to the cursor; if this
      // hold is still open, its WithdrawEvent never landed. Safe to release.
      if (ctx.ledger.releaseHold(hold.requestId) === "released") released++;
    }
  }
  return released;
}

export async function runListener(
  ctx: ServiceContext,
  getCursor: () => string | null,
  setCursor: (sig: string) => void,
  opts: ListenerOptions = {},
): Promise<void> {
  const interval = opts.intervalMs ?? 4_000;
  console.log(
    `listener started for ${ctx.config.programId.toBase58()} on ${ctx.config.rpcUrl}`,
  );
  for (;;) {
    try {
      const n = await pollOnce(ctx, getCursor, setCursor, opts.pageSize);
      if (n > 0) console.log(`settled ${n} transaction(s)`);
      const released = await releaseExpiredHolds(ctx);
      if (released > 0) console.log(`released ${released} expired hold(s)`);
    } catch (err) {
      console.error("listener cycle error:", err);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}
