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
import { checkPoolSolvency, type SolvencyConnection } from "../services/solvency";

/**
 * How far past a hold's `lastValidBlockHeight` the finalized tip (measured
 * BEFORE a complete drain) must be before the hold is released. The margin
 * absorbs disagreement between load-balanced RPC nodes about the finalized
 * tip; correctness comes from the drain (see {@link pollOnce}).
 */
export const RELEASE_SAFETY_BLOCKS = 150;

/**
 * Alert threshold for pending signatures in one cycle. With a stored cursor a
 * larger backlog is still processed completely in the same cycle (no
 * re-paging), with an alert; without a cursor (first start) it is refused.
 */
export const DEFAULT_MAX_BACKLOG = 10_000;

/**
 * Hard safety cap on signatures collected in one cycle (only signature + slot
 * + err are kept per entry). Beyond it the listener halts with an alert
 * instead of paging further.
 */
export const DEFAULT_HARD_BACKLOG_CAP = 1_000_000;

/** getSignaturesForAddress page size (the RPC maximum). */
export const DEFAULT_PAGE_SIZE = 1000;
/** The RPC's maximum `limit`; also the most signatures one slot may hold. */
export const MAX_PAGE_SIZE = 1000;

/** Consecutive cycles stuck on the same missing transaction before alerting. */
export const DEFAULT_STUCK_ALERT_CYCLES = 10;

/** Consecutive failed cycles (errors / halts) before alerting. */
export const DEFAULT_FAILURE_ALERT_CYCLES = 5;

/**
 * Consecutive cycles in which the cursor is not found before the listener
 * opens an incident and pauses the vault (~40 s at the default 4 s poll). One
 * flaky node must not pause everyone; refusing to release is already safe.
 */
export const DEFAULT_NOT_FOUND_INCIDENT_CYCLES = 10;

/**
 * Consecutive cycles in which the solvency gate blocked releases before the
 * listener alerts (a withdraw legitimately in flight between the listing and
 * the balance read can cause a one-off shortfall).
 */
export const DEFAULT_SHORTFALL_ALERT_CYCLES = 5;

/** Listener lease lifetime; renewed every cycle and after every transaction. */
export const DEFAULT_LEASE_TTL_MS = 120_000;

/** The subset of `Connection` the listener uses (so tests can fake it). */
export interface ListenerConnection extends SolvencyConnection {
  getSignaturesForAddress(
    address: PublicKey,
    options?: SignaturesForAddressOptions,
    commitment?: Finality,
  ): Promise<ConfirmedSignatureInfo[]>;
  getTransaction(
    signature: string,
    opts: { commitment?: Finality; maxSupportedTransactionVersion: number },
  ): Promise<VersionedTransactionResponse | null>;
  /** Finalized slot AND block height from ONE response (see {@link pollOnce}). */
  getEpochInfo(
    commitment?: Finality,
  ): Promise<{ absoluteSlot: number; blockHeight?: number | null }>;
}

export interface ListenerDeps {
  connection: ListenerConnection;
  ledger: Ledger;
  programId: PublicKey;
  /** Signatures per getSignaturesForAddress page (1..1000, default 1000). */
  pageSize?: number;
  releaseSafetyBlocks?: number;
  /**
   * Used as the start point when the ledger has no cursor yet. Everything at
   * or before its slot is skipped (treated as v0.1-era).
   */
  startAfterSignature?: string;
  /** Transactions at or before this slot (v0.1 era) are skipped. */
  upgradeSlot?: number;
  /**
   * Alert threshold for pending signatures in one cycle (with a cursor), and
   * the refusal threshold on first start (no cursor).
   */
  maxBacklog?: number;
  /** Halt with an alert when more signatures than this are pending. */
  hardBacklogCap?: number;
  /** Alert after this many consecutive cycles stuck on one missing tx. */
  stuckAlertCycles?: number;
  /** HOUSE_BANKROLL_LAMPORTS: house funds in the pool the ledger cannot see. */
  extraHouseLamports?: bigint;
  /** Alert after this many consecutive cycles with releases blocked by a shortfall. */
  shortfallAlertCycles?: number;
  /** Open an incident after this many consecutive cursor-not-found cycles. */
  notFoundIncidentCycles?: number;
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
  | "slot_too_large"
  | "scan_stalled"
  | "node_lagging"
  | "lease_held";

export interface CycleResult {
  /** Successful transactions whose events were applied. */
  processed: number;
  /** Failed (`err`) or pre-upgrade / pre-start transactions skipped. */
  skipped: number;
  /** True only if every pending signature was processed this cycle. */
  drained: boolean;
  /** Signature the cycle stopped at (cursor NOT advanced past it). */
  stoppedAt?: string;
  /** Why the cycle did not (finish) processing. */
  halted?: HaltReason;
  /** Finalized block height measured before the drain started. */
  tipBefore: number;
  released: number;
  /**
   * Set when the solvency gate refused to release expired holds this cycle:
   * the finalized pool balance is below the ledger's liabilities by this much.
   */
  releaseBlockedShortfall?: bigint;
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
  const pageSize = deps.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new ListenerConfigError(`pageSize must be an integer from 1 to ${MAX_PAGE_SIZE}`);
  }
  const maxBacklog = deps.maxBacklog ?? DEFAULT_MAX_BACKLOG;
  if (!Number.isInteger(maxBacklog) || maxBacklog < 1) {
    throw new ListenerConfigError("maxBacklog must be a positive integer");
  }
}

/** What the listener keeps per pending signature (cheap: no tx data). */
export interface PendingSignature {
  signature: string;
  slot: number;
  /** The signature index's `err` (null for a successful transaction). */
  err: unknown;
}

/**
 * Where paging stops:
 * - `signature`: the cursor (or start transaction) at `slot`; `processed`
 *   holds every signature of that slot already processed (the cursor
 *   included). Seeing any of them is the positive proof the scan reached it.
 * - `slot`: UPGRADE_SLOT, no cursor yet: an entry at or below it.
 */
export type ScanStop =
  | { kind: "signature"; slot: number; processed: ReadonlySet<string> }
  | { kind: "slot"; slot: number };

export type CollectResult =
  | { status: "ok"; sigs: PendingSignature[] }
  | { status: "not_found" }
  | { status: "too_many"; collected: number }
  | { status: "slot_too_large"; slot: number }
  | { status: "stalled"; reason: string }
  | { status: "lease_lost" };

/** Most getSignaturesForAddress pages one scan may request. */
export const MAX_PAGES_PER_SCAN = 2_000;
/** The scan re-checks the listener lease every this many pages. */
export const LEASE_CHECK_EVERY_PAGES = 50;

/**
 * Pages BACKWARDS (`before` only, never `until`) from the newest finalized
 * signature and returns every signature newer than the stop point that is
 * not processed yet, oldest-first (slot ascending).
 *
 * `until` is deliberately not used: the RPC excludes the `until` signature
 * from its answer, so an empty page "because we reached it" is
 * indistinguishable from an empty page "because the node's history ends here"
 * (pruned / lagging node, wrong cluster). The scan is trusted only when it
 * POSITIVELY reaches the stop point; otherwise → `not_found`, which halts the
 * cycle without processing or releasing anything.
 *
 * WHICH ENTRIES ARE TRUSTED. Within one response the RPC lists slots newest
 * first, but the order of transactions INSIDE a slot is not guaranteed to be
 * the same on every node (and Agave's blockstore and BigTable can disagree),
 * and `before` is applied in the answering node's order. The oldest slot of
 * ANY response may therefore be incomplete:
 * - a full page simply stops inside it;
 * - a SHORT page does not prove the end of history either: Agave fills a
 *   short blockstore answer from BigTable (with BigTable's own intra-slot
 *   order, after the last blockstore entry) and then drops duplicates, so a
 *   page can be short while part of its oldest slot (and older history) was
 *   never returned.
 * So the oldest slot of every response is dropped ("cut") and `before` is set
 * to the oldest entry of a newer slot: the cut slot is fetched again, from its
 * top edge, by the next page. Every other slot in a response lies strictly
 * between two other slots of that same response and is therefore whole.
 * Everything is de-duplicated by signature.
 *
 * WHEN THE SCAN IS COMPLETE.
 * - `signature` stop (cursor / START_AFTER_SIGNATURE at slot S): a signature
 *   already processed in S must be listed in a TRUSTED (non-cut) part, i.e. in
 *   a response that also lists an older slot. That response then holds slot S
 *   whole, so every unprocessed signature of S was returned with it. An
 *   entry from a slot older than S before that → `not_found`.
 *   Consequence: if S is the OLDEST slot the node has (nothing older than the
 *   cursor exists at all), completeness cannot be proven and the listener
 *   halts. That is safe (no release) and does not happen in practice: the
 *   program's deployment / upgrade / initialize transactions reference the
 *   program and are older than any vault transaction the cursor can be at
 *   (for a brand-new deployment start with UPGRADE_SLOT, not with the
 *   deployment signature itself). An idle vault therefore still drains: its
 *   listing is [cursor slot..., older history...] in one response.
 * - `slot` stop (UPGRADE_SLOT, no cursor yet): any entry AT or BELOW the slot.
 *   Every slot newer than it in that response is newer than the response's
 *   oldest slot, hence whole.
 *
 * PROGRESS. A response whose trusted part is empty (it holds a single slot)
 * or adds no new signature (only the rest of `before`'s slot) is retried
 * once with the maximum limit (1000); if that still adds nothing →
 * `slot_too_large` / `stalled` (halt with an alert, never skip). At most
 * {@link MAX_PAGES_PER_SCAN} pages per scan, and the lease is re-checked
 * every {@link LEASE_CHECK_EVERY_PAGES} pages.
 *
 * More than `cap` pending → `too_many` (nothing returned).
 */
export async function collectNewSignatures(
  connection: ListenerConnection,
  programId: PublicKey,
  opts: {
    stop: ScanStop;
    pageSize: number;
    cap: number;
    minContextSlot?: number;
    /** Returns false once the listener lease is lost. */
    holdsLease?: () => boolean;
  },
): Promise<CollectResult> {
  const { stop } = opts;
  const newestFirst: PendingSignature[] = [];
  const seen = new Set<string>();
  let found = false;
  let before: string | undefined;
  let limit = opts.pageSize;
  let retried = false;
  for (let pages = 1; ; pages++) {
    if (pages > MAX_PAGES_PER_SCAN) {
      return { status: "stalled", reason: `more than ${MAX_PAGES_PER_SCAN} pages in one scan` };
    }
    if (pages % LEASE_CHECK_EVERY_PAGES === 0 && opts.holdsLease && !opts.holdsLease()) {
      return { status: "lease_lost" };
    }
    const page = await connection.getSignaturesForAddress(
      programId,
      { before, limit, minContextSlot: opts.minContextSlot },
      "finalized",
    );
    if (page.length === 0) return { status: "not_found" }; // never proven complete

    // Slot mode: the first entry at/below the upgrade slot ends the scan; the
    // entries before it are in slots newer than this response's oldest slot.
    if (stop.kind === "slot") {
      const end = page.findIndex((s) => s.slot <= stop.slot);
      if (end >= 0) {
        for (const s of page.slice(0, end)) {
          if (seen.has(s.signature)) continue;
          seen.add(s.signature);
          newestFirst.push({ signature: s.signature, slot: s.slot, err: s.err });
          if (newestFirst.length > opts.cap) return { status: "too_many", collected: newestFirst.length };
        }
        return { status: "ok", sigs: newestFirst.reverse() };
      }
    }

    // Trusted part: everything newer than the response's oldest slot.
    const oldestSlot = page[page.length - 1].slot;
    let cut = page.length;
    while (cut > 0 && page[cut - 1].slot === oldestSlot) cut--;
    const trusted = page.slice(0, cut);

    let added = 0;
    for (const s of trusted) {
      if (stop.kind === "signature" && s.slot < stop.slot) {
        // Slot S, if listed, was listed whole above: this is the proof point.
        return found ? { status: "ok", sigs: newestFirst.reverse() } : { status: "not_found" };
      }
      if (seen.has(s.signature)) continue;
      seen.add(s.signature);
      added++;
      if (stop.kind === "signature" && s.slot === stop.slot && stop.processed.has(s.signature)) {
        found = true;
        continue;
      }
      newestFirst.push({ signature: s.signature, slot: s.slot, err: s.err });
      if (newestFirst.length > opts.cap) return { status: "too_many", collected: newestFirst.length };
    }
    // Slot S was trusted (whole) in this response and the cut slot is older.
    if (stop.kind === "signature" && oldestSlot < stop.slot && trusted.some((s) => s.slot === stop.slot)) {
      return found ? { status: "ok", sigs: newestFirst.reverse() } : { status: "not_found" };
    }
    if (stop.kind === "signature" && oldestSlot < stop.slot) {
      // The response skipped from newer slots straight past S: S holds no
      // entry at all on this node, so the cursor is not found.
      return { status: "not_found" };
    }

    if (added === 0) {
      // Nothing new: a single-slot response, or only the rest of `before`'s
      // slot. Retry once with the largest page; then give up (halt).
      if (!retried || limit < MAX_PAGE_SIZE) {
        retried = true;
        limit = MAX_PAGE_SIZE;
        continue;
      }
      return trusted.length === 0 && page.length >= MAX_PAGE_SIZE
        ? { status: "slot_too_large", slot: oldestSlot }
        : trusted.length === 0
          ? { status: "not_found" } // a short single-slot response: cannot prove completeness
          : { status: "stalled", reason: "a page added no new signature (nodes disagree on intra-slot order)" };
    }
    retried = false;
    before = trusted[trusted.length - 1].signature;
    limit = opts.pageSize;
  }
}

/**
 * The RPC answered "minimum context slot has not been reached" (JSON-RPC
 * -32016): the load-balanced node behind RPC_URL is behind the finalized slot
 * this cycle measured, so its answer could miss transactions.
 */
export function isNodeLaggingError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; message?: unknown };
  return (
    e.code === -32016 ||
    (typeof e.message === "string" && /minimum context slot/i.test(e.message))
  );
}

/** Per-deps memory of a stuck missing transaction (not persisted on purpose). */
const stuckState = new WeakMap<ListenerDeps, { signature: string; cycles: number }>();
/** Per-deps count of consecutive cycles whose releases the solvency gate blocked. */
const shortfallState = new WeakMap<ListenerDeps, number>();
/** Per-deps count of consecutive cursor-not-found cycles. */
const notFoundState = new WeakMap<ListenerDeps, number>();

/**
 * One listener cycle.
 *
 * 1. If a lease holder is configured, take/renew the single-listener lease.
 * 2. If the kill-switch is set, (re)try pausing the vault until it reads paused.
 * 3. Measure the finalized slot AND block height `tipBefore` from ONE
 *    `getEpochInfo("finalized")` response, BEFORE fetching anything. The slot
 *    is passed as `minContextSlot` to every signature listing, so a lagging
 *    load-balanced node errors (cycle stops, no release) instead of answering
 *    from a history that does not yet hold every block up to `tipBefore`.
 * 4. Collect every finalized signature newer than the cursor (see
 *    {@link collectNewSignatures}). A cursor that is not positively found
 *    halts the cycle (alert, no processing, no release); only
 *    `notFoundIncidentCycles` consecutive misses open the kill-switch.
 * 5. Oldest-first: skip failed / pre-upgrade ones, fetch + decode the
 *    emit_cpi events of the rest, apply them, and only then advance the
 *    cursor to it. Missing transaction data STOPS the cycle without
 *    advancing — retried next poll, alerting after `stuckAlertCycles`
 *    consecutive cycles. An undecodable event opens the kill-switch, is
 *    recorded, and is skipped (no infinite loop).
 * 6. Only if step 5 drained EVERYTHING, the lease is still held, no
 *    incident is open, AND the finalized pool balance covers every ledger
 *    liability (solvency gate, read with the same `minContextSlot`): release
 *    holds with `tipBefore > lastValidBlockHeight + margin`.
 *
 * Why step 6 is safe: a withdraw transaction can only land in a block whose
 * height is <= its `lastValidBlockHeight`. `tipBefore` was finalized before
 * the drain began, every listing came from a node at or past that slot, the
 * listing covered every slot whole (slot-edge paging) and provably reached
 * the cursor, so a complete drain saw the withdraw's signature if it exists.
 * Releases are suspended during an incident: the books are suspect, and a
 * release hands balance back that may already have left the pool.
 */
export async function pollOnce(deps: ListenerDeps): Promise<CycleResult> {
  const { connection, ledger, programId } = deps;
  const log = deps.log ?? ((m: string) => console.log(m));
  const decode = deps.decode ?? decodeVaultTransactionEvents;
  const pageSize = deps.pageSize ?? DEFAULT_PAGE_SIZE;
  const leaseTtl = deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const maxBacklog = deps.maxBacklog ?? DEFAULT_MAX_BACKLOG;
  const hardCap = deps.hardBacklogCap ?? DEFAULT_HARD_BACKLOG_CAP;
  let pauseAttempted = false;

  const holdsLease = () =>
    deps.leaseHolder === undefined || ledger.acquireListenerLease(deps.leaseHolder, leaseTtl);

  assertListenerCanStart(deps);
  const result: CycleResult = {
    processed: 0,
    skipped: 0,
    drained: false,
    tipBefore: 0,
    released: 0,
  };
  if (!holdsLease()) {
    log("listener: lease held by another listener; skipping cycle");
    result.halted = "lease_held";
    return result;
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

  /**
   * The cursor was not positively found. Halt: nothing is processed or
   * released, which is already safe. Alert on the first miss of a streak; only
   * a PERSISTENT miss (`notFoundIncidentCycles` in a row) opens the incident
   * and pauses — one flaky or pruned load-balanced node must not pause the
   * vault for everyone.
   */
  const cursorNotFound = async (cursor: string, slot: number | null, why: string) => {
    const misses = (notFoundState.get(deps) ?? 0) + 1;
    notFoundState.set(deps, misses);
    const threshold = deps.notFoundIncidentCycles ?? DEFAULT_NOT_FOUND_INCIDENT_CYCLES;
    const detail = { cursor, slot, why, consecutiveMisses: misses };
    if (misses === threshold) {
      ledger.openIncident("listener cursor not found in RPC history", detail);
      deps.alert(
        "listener cursor not found in RPC history for consecutive cycles; incident opened, pausing — " +
          "the RPC needs full transaction history (check RPC_URL)",
        detail,
      );
      await tryPause();
    } else if (misses === 1) {
      deps.alert("listener cursor not found in RPC history; halted, no releases, retrying", detail);
    } else {
      log(`listener: cursor not found (${misses} consecutive cycle(s)); retrying`);
    }
    result.halted = "cursor_not_found";
    return result;
  };

  const startNotFound = (start: string, why: string) => {
    deps.alert("listener start point not found in RPC history; listener waiting", { start, why });
    result.halted = "start_not_found";
    return result;
  };

  /**
   * Applies one transaction. Returns false when the cycle must stop.
   * `skipAtOrBelow`: slots treated as v0.1-era (never decoded).
   */
  const processOne = async (
    info: PendingSignature,
    skipAtOrBelow: number | undefined,
  ): Promise<boolean> => {
    const advance = (kind: "processed" | "skipped") => {
      ledger.setCursor(info.signature, info.slot);
      result[kind]++;
    };
    if (skipAtOrBelow !== undefined && info.slot <= skipAtOrBelow) {
      advance("skipped"); // v0.1 layout: never decode
      return true;
    }
    // Failed on chain: skip it without fetching. The signature index's `err`
    // is the same TransactionError the node stores as the transaction's
    // `meta.err` (both are written from one execution result), and a failed
    // transaction's effects — including its emit_cpi self-CPI events — are
    // rolled back. The decoder also returns [] for a fetched tx with meta.err.
    if (info.err) {
      advance("skipped");
      return true;
    }

    // getTransaction takes no minContextSlot (the RPC method has none); a
    // node that does not have the transaction yet returns null, which stops
    // the cycle below without advancing the cursor.
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
        return false; // cursor NOT advanced, no release this cycle
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
        advance("skipped");
        return true;
      }
      throw err;
    }

    // Lost the lease mid-cycle (e.g. this cycle outlived the TTL and another
    // listener took over): stop before writing anything.
    if (!holdsLease()) {
      result.stoppedAt = info.signature;
      result.halted = "lease_held";
      return false;
    }
    // Idempotent: every event is de-duplicated by its source position, and the
    // signature is recorded as processed only AFTER its events were applied.
    await applyVaultEvents(ledger, info.signature, records, handlers);
    advance("processed");
    return true;
  };

  const drain = async (): Promise<CycleResult> => {
    const epoch = await connection.getEpochInfo("finalized");
    if (typeof epoch.blockHeight !== "number") {
      throw new Error("RPC getEpochInfo returned no blockHeight");
    }
    const minContextSlot = epoch.absoluteSlot;
    const tipBefore = epoch.blockHeight;
    result.tipBefore = tipBefore;

    // Where to stop paging, and which slots are never decoded.
    const progress = ledger.getProgress();
    let stop: ScanStop;
    let skipAtOrBelow = deps.upgradeSlot;
    const cursor = progress.cursor;
    if (cursor !== null) {
      let slot = progress.slot;
      if (slot === null) {
        // Legacy ledger without the cursor's slot: look it up. getTransaction
        // has no minContextSlot, so a null may just be a lagging node: this
        // is a (retried) not-found halt, not an immediate incident.
        const tx = await connection.getTransaction(cursor, {
          commitment: "finalized",
          maxSupportedTransactionVersion: 0,
        });
        slot = tx?.slot ?? null;
      }
      if (slot === null) return cursorNotFound(cursor, null, "cursor transaction not returned");
      const processed = new Set(progress.slotSignatures);
      processed.add(cursor);
      stop = { kind: "signature", slot, processed };
    } else if (deps.startAfterSignature !== undefined) {
      const start = await connection.getTransaction(deps.startAfterSignature, {
        commitment: "finalized",
        maxSupportedTransactionVersion: 0,
      });
      if (!start) {
        // Possibly a lagging node (no minContextSlot here): halt and retry.
        return startNotFound(deps.startAfterSignature, "START_AFTER_SIGNATURE not returned at finalized");
      }
      stop = { kind: "signature", slot: start.slot, processed: new Set([deps.startAfterSignature]) };
      // Other transactions in the start transaction's slot may be v0.1-era.
      skipAtOrBelow = Math.max(skipAtOrBelow ?? start.slot, start.slot);
    } else {
      stop = { kind: "slot", slot: deps.upgradeSlot! };
    }

    // With a cursor, a large backlog is processed (with an alert); without
    // one (first start) it is refused, since the start point may be wrong.
    const cap = cursor !== null ? hardCap : maxBacklog;
    const collected = await collectNewSignatures(connection, programId, {
      stop,
      pageSize,
      cap,
      minContextSlot,
      holdsLease,
    });
    if (collected.status === "lease_lost") {
      result.halted = "lease_held";
      return result;
    }
    if (collected.status === "not_found") {
      const why = "stop point not reached in RPC history (pruned / lagging node, wrong cluster)";
      return cursor !== null
        ? cursorNotFound(cursor, stop.slot, why)
        : startNotFound(deps.startAfterSignature ?? `slot ${stop.slot}`, why);
    }
    notFoundState.delete(deps);
    if (collected.status === "slot_too_large") {
      deps.alert("a slot holds more than 1000 vault signatures; cannot page it safely — not processing", {
        slot: collected.slot,
      });
      result.halted = "slot_too_large";
      return result;
    }
    if (collected.status === "stalled") {
      deps.alert("listener scan made no progress; not processing — use one consistent RPC endpoint", {
        reason: collected.reason,
      });
      result.halted = "scan_stalled";
      return result;
    }
    if (collected.status === "too_many") {
      deps.alert(
        cursor !== null
          ? "listener backlog exceeds the hard safety cap; not processing — investigate"
          : "listener backlog on first start exceeds LISTENER_MAX_BACKLOG; not processing — " +
              "check UPGRADE_SLOT / START_AFTER_SIGNATURE, or raise LISTENER_MAX_BACKLOG deliberately",
        { cap },
      );
      result.halted = "backlog_exceeded";
      return result;
    }
    const pending = collected.sigs;
    if (cursor === null && deps.startAfterSignature !== undefined) {
      // The scan positively reached the start transaction: it becomes the
      // cursor (its slot's other transactions are skipped below and join it).
      ledger.setCursor(deps.startAfterSignature, stop.slot);
    }
    if (pending.length > maxBacklog) {
      deps.alert("listener backlog above LISTENER_MAX_BACKLOG; processing it all, no hold release until drained", {
        pending: pending.length,
        threshold: maxBacklog,
      });
    }

    // Process everything listed in THIS cycle (no re-paging), logging progress
    // every `maxBacklog` transactions.
    for (let i = 0; i < pending.length; i++) {
      if (!(await processOne(pending[i], skipAtOrBelow))) return result;
      if ((i + 1) % maxBacklog === 0 && i + 1 < pending.length) {
        log(`listener: ${i + 1}/${pending.length} signature(s) processed`);
      }
    }
    stuckState.delete(deps);

    // Re-check the lease right before releasing: a listener that lost it must
    // not release on the strength of its own (now superseded) drain.
    if (!holdsLease()) {
      result.halted = "lease_held";
      return result;
    }
    // Solvency gate (defence in depth, independent of the listing): before
    // releasing ANY expired hold, the finalized pool balance (read at or past
    // this cycle's slot) must cover every liability in the ledger. A release
    // only moves pending → available, so it does not change liabilities; but
    // a withdraw that landed and that the listing missed has left the pool
    // short by its amount, so the release is refused.
    const margin = deps.releaseSafetyBlocks ?? RELEASE_SAFETY_BLOCKS;
    const releasable =
      ledger.getIncident() === null &&
      ledger.listOpenHolds().some((h) => tipBefore > h.lastValidBlockHeight + margin);
    let solvent = true;
    if (releasable) {
      const check = await checkPoolSolvency(connection, ledger, programId, {
        extraHouseLamports: deps.extraHouseLamports,
        minContextSlot,
      });
      if (!check.solvent) {
        solvent = false;
        const cycles = (shortfallState.get(deps) ?? 0) + 1;
        shortfallState.set(deps, cycles);
        result.releaseBlockedShortfall = -check.difference;
        const detail = {
          poolBalance: check.poolBalance.toString(),
          liabilities: check.expected.toString(),
          shortfall: (-check.difference).toString(),
          consecutiveCycles: cycles,
        };
        log(`listener: pool below ledger liabilities; expired holds NOT released (${JSON.stringify(detail)})`);
        const every = deps.shortfallAlertCycles ?? DEFAULT_SHORTFALL_ALERT_CYCLES;
        if (cycles % every === 0) {
          deps.alert("pool balance below ledger liabilities; hold releases blocked — investigate (unseen withdrawal?)", detail);
        }
      } else {
        shortfallState.delete(deps);
      }
    }

    result.drained = true;
    ledger.setDrainedThroughBlockHeight(tipBefore);
    if (solvent) result.released = releaseExpiredHolds(ledger, tipBefore, margin);
    return result;
  };

  if (ledger.getIncident()) await tryPause();

  try {
    return await drain();
  } catch (err) {
    if (!isNodeLaggingError(err)) throw err;
    // Nothing past the failing call ran for unseen history: no cursor advance
    // past it and no release. Retried next cycle.
    log(`listener: RPC node behind this cycle's finalized slot; retrying (${safeErrorMessage(err)})`);
    result.drained = false;
    result.halted = "node_lagging";
    return result;
  }
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
    extraHouseLamports: ctx.config.houseBankrollLamports,
    notFoundIncidentCycles: ctx.config.listenerNotFoundIncidentCycles,
    leaseHolder: newLeaseHolderId(),
    pauseVault: () => pauseVault(ctx),
    isVaultPaused: () => isVaultPaused(ctx),
    alert: (reason, detail) => console.error(`[INCIDENT] ${reason}`, detail),
  };
}

/**
 * Runs the listener loop. Fails fast (throws) if the configuration cannot
 * start safely or another listener holds the lease. Afterwards a cycle error
 * is logged and retried; `failureAlertCycles` consecutive failed cycles
 * (thrown errors, or a halt: lagging node, cursor/start not found, oversized
 * backlog or slot) page the operator, and again every N.
 */
export async function runListener(
  deps: ListenerDeps,
  opts: { intervalMs?: number; failureAlertCycles?: number; maxCycles?: number } = {},
): Promise<void> {
  const interval = opts.intervalMs ?? 4_000;
  const alertEvery = opts.failureAlertCycles ?? DEFAULT_FAILURE_ALERT_CYCLES;
  assertListenerCanStart(deps);
  if (
    deps.leaseHolder !== undefined &&
    !deps.ledger.acquireListenerLease(deps.leaseHolder, deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS)
  ) {
    throw new ListenerLeaseError();
  }
  const log = deps.log ?? ((m: string) => console.log(m));
  log(`listener started for ${deps.programId.toBase58()}`);
  let failures = 0;
  for (let cycle = 0; opts.maxCycles === undefined || cycle < opts.maxCycles; cycle++) {
    let lastError: string | undefined;
    try {
      const r = await pollOnce(deps);
      if (r.processed > 0) log(`settled ${r.processed} transaction(s)`);
      if (r.released > 0) log(`released ${r.released} expired hold(s)`);
      if (r.halted !== undefined && r.halted !== "lease_held") lastError = `halted: ${r.halted}`;
    } catch (err) {
      lastError = safeErrorMessage(err);
      console.error("listener cycle error:", lastError);
    }
    if (lastError !== undefined) {
      failures++;
      if (failures % alertEvery === 0) {
        deps.alert("listener failing: consecutive cycles without a successful run", {
          consecutiveFailures: failures,
          lastError,
        });
      }
    } else {
      failures = 0;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}
