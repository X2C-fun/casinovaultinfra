import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import type {
  ConfirmedSignatureInfo,
  Finality,
  PublicKey,
  SignaturesForAddressOptions,
  VersionedTransactionResponse,
} from "@solana/web3.js";
import {
  decodeVaultTransactionEvents,
  MissingTransactionDataError,
  UndecodableEventError,
} from "@x2c-fun/casinovault-sdk";
import type { ServiceContext } from "../context";
import type { Ledger } from "../ledger/types";
import { applyVaultEvents, type SettlementHandlers } from "../services/settlement";
import { isVaultPaused, pauseVault } from "../services/pause";
import { safeErrorMessage } from "../admin";

/**
 * How far past a hold's `lastValidBlockHeight` the finalized tip (measured
 * BEFORE a complete drain) must be before the hold is released. The margin
 * absorbs disagreement between load-balanced RPC nodes about the finalized
 * tip; correctness comes from the drain (see {@link pollOnce}).
 */
export const RELEASE_SAFETY_BLOCKS = 150;

/** Most signatures collected in one cycle before the listener stops and alerts. */
export const DEFAULT_MAX_BACKLOG = 10_000;

/** Consecutive cycles stuck on the same missing transaction before alerting. */
export const DEFAULT_STUCK_ALERT_CYCLES = 10;

/** Listener lease lifetime; renewed every cycle and after every transaction. */
export const DEFAULT_LEASE_TTL_MS = 120_000;

/** The subset of `Connection` the listener uses (so tests can fake it). */
export interface ListenerConnection {
  getSignaturesForAddress(
    address: PublicKey,
    options?: SignaturesForAddressOptions,
    commitment?: Finality,
  ): Promise<ConfirmedSignatureInfo[]>;
  getTransaction(
    signature: string,
    opts: { commitment?: Finality; maxSupportedTransactionVersion: number },
  ): Promise<VersionedTransactionResponse | null>;
  getBlockHeight(commitment?: Finality): Promise<number>;
}

export interface ListenerDeps {
  connection: ListenerConnection;
  ledger: Ledger;
  programId: PublicKey;
  /** Signatures per getSignaturesForAddress page (RPC max 1000). */
  pageSize?: number;
  releaseSafetyBlocks?: number;
  /** Used as the cursor when the ledger has none yet (skip v0.1 history). */
  startAfterSignature?: string;
  /** Transactions at or before this slot (v0.1 era) are skipped. */
  upgradeSlot?: number;
  /** Stop and alert when more than this many signatures are pending. */
  maxBacklog?: number;
  /** Alert after this many consecutive cycles stuck on one missing tx. */
  stuckAlertCycles?: number;
  /**
   * Lease holder id. When set, a cycle only runs while this holder owns the
   * ledger's single-listener lease (two listeners on one DB race the cursor).
   */
  leaseHolder?: string;
  leaseTtlMs?: number;
  /** Sends `set_paused(true)` with the admin key. */
  pauseVault(): Promise<string>;
  isVaultPaused(): Promise<boolean>;
  /** Page the operator. */
  alert(reason: string, detail: Record<string, unknown>): void;
  /** Override for tests; defaults to the SDK decoder. */
  decode?: typeof decodeVaultTransactionEvents;
  log?: (msg: string) => void;
}

export type HaltReason =
  | "cursor_not_found"
  | "start_not_found"
  | "backlog_exceeded"
  | "lease_held";

export interface CycleResult {
  /** Successful transactions whose events were applied. */
  processed: number;
  /** Failed (`err`) or pre-upgrade transactions skipped. */
  skipped: number;
  /** True only if every pending signature was processed this cycle. */
  drained: boolean;
  /** Signature the cycle stopped at (cursor NOT advanced past it). */
  stoppedAt?: string;
  /** Why the cycle did not even start processing. */
  halted?: HaltReason;
  /** Finalized block height measured before the drain started. */
  tipBefore: number;
  released: number;
}

/** The listener cannot start safely with this configuration. */
export class ListenerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ListenerConfigError";
  }
}

/** Another process holds the listener lease on this ledger. */
export class ListenerLeaseError extends Error {
  constructor() {
    super("another listener holds the lease on this ledger (DB_PATH); run only one listener");
    this.name = "ListenerLeaseError";
  }
}

/**
 * Without a stored cursor, the listener must know where v0.2 history starts:
 * otherwise it would page through the program's ENTIRE history and decode
 * v0.1-era events (crediting old deposits a second time).
 */
export function assertListenerCanStart(deps: ListenerDeps): void {
  if (
    deps.ledger.getCursor() === null &&
    deps.startAfterSignature === undefined &&
    deps.upgradeSlot === undefined
  ) {
    throw new ListenerConfigError(
      "the ledger has no listener cursor: set START_AFTER_SIGNATURE (e.g. the v0.2 upgrade " +
        "transaction) or UPGRADE_SLOT so the listener does not replay the full program history",
    );
  }
}

export type CollectResult =
  | { status: "ok"; sigs: ConfirmedSignatureInfo[] }
  | { status: "cursor_not_found" | "backlog_exceeded"; sigs: [] };

/**
 * Pages BACKWARDS from the newest finalized signature and returns everything
 * newer than the cursor, oldest-first. `getSignaturesForAddress({until})` only
 * returns the newest `limit` entries; stopping there would skip every older
 * one forever once the cursor moved past them.
 *
 * Bounded, so an unknown cursor can never trigger a full-history rescan:
 * - `until` + `floorSlot` (the cursor's slot): an entry OLDER than the floor
 *   means the RPC walked past the cursor without finding it (pruned history,
 *   wrong node, wrong cluster) → `cursor_not_found`, nothing returned.
 * - `stopAtOrBelowSlot` (no cursor, UPGRADE_SLOT only): stop at the upgrade.
 * - more than `maxBacklog` entries → `backlog_exceeded`, nothing returned.
 */
export async function collectNewSignatures(
  connection: ListenerConnection,
  programId: PublicKey,
  opts: {
    until?: string;
    floorSlot?: number;
    stopAtOrBelowSlot?: number;
    pageSize: number;
    maxBacklog: number;
  },
): Promise<CollectResult> {
  const all: ConfirmedSignatureInfo[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await connection.getSignaturesForAddress(
      programId,
      { until: opts.until, before, limit: opts.pageSize },
      "finalized",
    );
    if (page.length === 0) break;
    let done = false;
    for (const s of page) {
      if (opts.until !== undefined && s.signature === opts.until) {
        done = true; // defensive: the RPC excludes `until` itself
        break;
      }
      if (opts.floorSlot !== undefined && s.slot < opts.floorSlot) {
        return { status: "cursor_not_found", sigs: [] };
      }
      if (opts.stopAtOrBelowSlot !== undefined && s.slot <= opts.stopAtOrBelowSlot) {
        done = true;
        break;
      }
      all.push(s);
      if (all.length > opts.maxBacklog) return { status: "backlog_exceeded", sigs: [] };
    }
    if (done) break;
    before = page[page.length - 1].signature;
  }
  // Newest-first from the RPC → oldest-first for processing.
  return { status: "ok", sigs: all.reverse() };
}

/** Per-deps memory of a stuck missing transaction (not persisted on purpose). */
const stuckState = new WeakMap<ListenerDeps, { signature: string; cycles: number }>();

/**
 * One listener cycle.
 *
 * 1. If a lease holder is configured, take/renew the single-listener lease.
 * 2. If the kill-switch is set, (re)try pausing the vault until it reads paused.
 * 3. Measure the finalized block height `tipBefore`, BEFORE fetching anything.
 * 4. Collect every finalized signature newer than the cursor (all pages,
 *    bounded — see {@link collectNewSignatures}). An unknown cursor opens the
 *    kill-switch and processes nothing; an oversized backlog alerts.
 * 5. Oldest-first: skip failed / pre-upgrade ones, fetch + decode the emit_cpi
 *    events of the rest, apply them, and only then advance the cursor to it.
 *    Missing transaction data (RPC returned null / no meta) STOPS the cycle
 *    without advancing — it is retried next poll, and alerts after
 *    `stuckAlertCycles` consecutive cycles. An undecodable event opens the
 *    kill-switch, is recorded, and is skipped (no infinite loop).
 * 6. Only if step 5 drained everything AND no incident is open: release open
 *    holds with `tipBefore > lastValidBlockHeight + margin`.
 *
 * Why step 6 is safe: a withdraw transaction can only land in a block whose
 * height is <= its `lastValidBlockHeight`. `tipBefore` was finalized before
 * the drain began, so every block up to it — including any block that could
 * hold the withdraw — was already finalized when we listed signatures, and a
 * complete drain therefore saw its signature if it exists. A tip check alone
 * (the old behaviour) is not enough when the listener lags or a page is
 * skipped; a drain alone is not enough without a tip measured BEFORE it.
 * Releases are suspended during an incident: the books are suspect, and a
 * release hands balance back that may already have left the pool.
 */
export async function pollOnce(deps: ListenerDeps): Promise<CycleResult> {
  const { connection, ledger, programId } = deps;
  const log = deps.log ?? ((m: string) => console.log(m));
  const decode = deps.decode ?? decodeVaultTransactionEvents;
  const pageSize = deps.pageSize ?? 200;
  const leaseTtl = deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  let pauseAttempted = false;

  const holdsLease = () =>
    deps.leaseHolder === undefined || ledger.acquireListenerLease(deps.leaseHolder, leaseTtl);

  assertListenerCanStart(deps);
  if (!holdsLease()) {
    log("listener: lease held by another listener; skipping cycle");
    return { processed: 0, skipped: 0, drained: false, halted: "lease_held", tipBefore: 0, released: 0 };
  }

  const tryPause = async () => {
    if (pauseAttempted) return;
    pauseAttempted = true;
    try {
      if (await deps.isVaultPaused()) return;
      const sig = await deps.pauseVault();
      deps.alert("vault paused", { signature: sig });
    } catch (err) {
      deps.alert("FAILED TO PAUSE — will retry next cycle; pause manually now", {
        error: safeErrorMessage(err),
      });
    }
  };

  const handlers: SettlementHandlers = {
    onIncident: async (reason, detail) => {
      // The ledger already set the kill-switch atomically with the event.
      deps.alert(reason, detail);
      await tryPause();
    },
  };

  if (ledger.getIncident()) await tryPause();

  const tipBefore = await connection.getBlockHeight("finalized");
  const result: CycleResult = { processed: 0, skipped: 0, drained: false, tipBefore, released: 0 };

  // Where to stop paging.
  const progress = ledger.getProgress();
  let until: string | undefined;
  let floorSlot: number | undefined;
  let stopAtOrBelowSlot: number | undefined;
  if (progress.cursor !== null) {
    until = progress.cursor;
    floorSlot = progress.slot ?? undefined;
  } else if (deps.startAfterSignature !== undefined) {
    until = deps.startAfterSignature;
    const start = await connection.getTransaction(until, {
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
    });
    if (!start) {
      deps.alert("START_AFTER_SIGNATURE not found at finalized; listener waiting", {
        signature: until,
      });
      result.halted = "start_not_found";
      return result;
    }
    floorSlot = start.slot;
  } else {
    stopAtOrBelowSlot = deps.upgradeSlot;
  }

  const collected = await collectNewSignatures(connection, programId, {
    until,
    floorSlot,
    stopAtOrBelowSlot,
    pageSize,
    maxBacklog: deps.maxBacklog ?? DEFAULT_MAX_BACKLOG,
  });
  if (collected.status === "cursor_not_found") {
    ledger.openIncident("listener cursor not found in RPC history", {
      cursor: until,
      slot: floorSlot,
    });
    deps.alert("listener cursor not found in RPC history; NOT rescanning — check RPC_URL / history retention", {
      cursor: until,
      slot: floorSlot,
    });
    await tryPause();
    result.halted = "cursor_not_found";
    return result;
  }
  if (collected.status === "backlog_exceeded") {
    deps.alert("listener backlog exceeds the cap; not processing — raise LISTENER_MAX_BACKLOG deliberately", {
      cap: deps.maxBacklog ?? DEFAULT_MAX_BACKLOG,
      cursor: until,
    });
    result.halted = "backlog_exceeded";
    return result;
  }

  for (const info of collected.sigs) {
    if (deps.upgradeSlot !== undefined && info.slot <= deps.upgradeSlot) {
      ledger.setCursor(info.signature, info.slot); // v0.1 layout: never decode
      result.skipped++;
      continue;
    }
    if (info.err) {
      // Failed on chain: its events are rolled back. Skip it.
      ledger.setCursor(info.signature, info.slot);
      result.skipped++;
      continue;
    }

    const tx = await connection.getTransaction(info.signature, {
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
    });

    let records;
    try {
      // [] when meta.err is set; throws when tx/meta is missing.
      records = decode(tx, { programId, source: "cpi" });
    } catch (err) {
      if (err instanceof MissingTransactionDataError) {
        const prev = stuckState.get(deps);
        const cycles = prev?.signature === info.signature ? prev.cycles + 1 : 1;
        stuckState.set(deps, { signature: info.signature, cycles });
        log(
          `listener: transaction data missing for ${info.signature} (${cycles} cycle(s)); retrying next cycle`,
        );
        const every = deps.stuckAlertCycles ?? DEFAULT_STUCK_ALERT_CYCLES;
        if (cycles % every === 0) {
          deps.alert("listener stuck: transaction data still missing", {
            signature: info.signature,
            cycles,
          });
        }
        result.stoppedAt = info.signature;
        return result; // cursor NOT advanced, no release this cycle
      }
      if (err instanceof UndecodableEventError) {
        // Kill-switch first, then alert + pause. Skip the tx so the listener
        // does not spin on it; the operator reconciles it by hand.
        ledger.openIncident("undecodable vault event", {
          signature: info.signature,
          slot: info.slot,
          error: safeErrorMessage(err),
        });
        deps.alert("undecodable vault event (v0.1 layout? set UPGRADE_SLOT)", {
          signature: info.signature,
          slot: info.slot,
        });
        await tryPause();
        ledger.setCursor(info.signature, info.slot);
        result.skipped++;
        continue;
      }
      throw err;
    }

    // Lost the lease mid-cycle (e.g. this cycle outlived the TTL and another
    // listener took over): stop before writing anything.
    if (!holdsLease()) {
      result.stoppedAt = info.signature;
      result.halted = "lease_held";
      return result;
    }
    await applyVaultEvents(ledger, info.signature, records, handlers);
    ledger.setCursor(info.signature, info.slot);
    result.processed++;
  }

  stuckState.delete(deps);
  result.drained = true;
  ledger.setDrainedThroughBlockHeight(tipBefore);
  result.released = releaseExpiredHolds(
    ledger,
    tipBefore,
    deps.releaseSafetyBlocks ?? RELEASE_SAFETY_BLOCKS,
  );
  return result;
}

/**
 * Releases open holds whose transaction can no longer land. Call ONLY after a
 * cycle that drained every finalized signature, with the finalized block
 * height measured before that drain began (see {@link pollOnce}). Does nothing
 * while the incident kill-switch is set.
 */
export function releaseExpiredHolds(
  ledger: Ledger,
  tipBeforeDrain: number,
  margin = RELEASE_SAFETY_BLOCKS,
): number {
  if (ledger.getIncident()) return 0;
  let released = 0;
  for (const hold of ledger.listOpenHolds()) {
    if (tipBeforeDrain > hold.lastValidBlockHeight + margin) {
      if (ledger.releaseHold(hold.requestId) === "released") released++;
    }
  }
  return released;
}

/** A unique id for this listener process (lease holder). */
export function newLeaseHolderId(): string {
  return `${hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`;
}

/** Wires the listener to the real chain client, admin key and config. */
export function listenerDepsFromContext(ctx: ServiceContext): ListenerDeps {
  return {
    connection: ctx.connection,
    ledger: ctx.ledger,
    programId: ctx.config.programId,
    startAfterSignature: ctx.config.startAfterSignature,
    upgradeSlot: ctx.config.upgradeSlot,
    maxBacklog: ctx.config.listenerMaxBacklog,
    leaseHolder: newLeaseHolderId(),
    pauseVault: () => pauseVault(ctx),
    isVaultPaused: () => isVaultPaused(ctx),
    alert: (reason, detail) => console.error(`[INCIDENT] ${reason}`, detail),
  };
}

/**
 * Runs the listener loop. Fails fast (throws) if the configuration cannot
 * start safely or another listener holds the lease; afterwards a cycle error
 * is logged and retried.
 */
export async function runListener(
  deps: ListenerDeps,
  opts: { intervalMs?: number } = {},
): Promise<void> {
  const interval = opts.intervalMs ?? 4_000;
  assertListenerCanStart(deps);
  if (
    deps.leaseHolder !== undefined &&
    !deps.ledger.acquireListenerLease(deps.leaseHolder, deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS)
  ) {
    throw new ListenerLeaseError();
  }
  console.log(`listener started for ${deps.programId.toBase58()}`);
  for (;;) {
    try {
      const r = await pollOnce(deps);
      if (r.processed > 0) console.log(`settled ${r.processed} transaction(s)`);
      if (r.released > 0) console.log(`released ${r.released} expired hold(s)`);
    } catch (err) {
      console.error("listener cycle error:", safeErrorMessage(err));
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}
