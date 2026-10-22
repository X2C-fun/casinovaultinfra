import {
  type Balance,
  type ChainBinding,
  type Hold,
  type IncidentRecord,
  type IncidentState,
  type Ledger,
  type LedgerOptions,
  type ListenerProgress,
  type SettleOutcome,
  DestinationMismatchError,
  IncidentOpenError,
  InsufficientFundsError,
  assertU64RequestId,
  isIncidentOutcome,
  randomRequestId,
} from "./types";
import { evaluateSettle } from "./settle-rules";

interface State {
  balances: Map<string, { available: bigint; pending: bigint }>;
  holds: Map<string, Hold>; // key: requestId.toString()
  seenEvents: Set<string>;
  house: { available: bigint; pending: bigint };
  incident: IncidentState | null;
  incidents: IncidentRecord[];
  progress: ListenerProgress;
}

function cloneState(s: State): State {
  return {
    balances: new Map([...s.balances].map(([k, v]) => [k, { ...v }])),
    holds: new Map([...s.holds].map(([k, v]) => [k, { ...v }])),
    seenEvents: new Set(s.seenEvents),
    house: { ...s.house },
    incident: s.incident ? { ...s.incident } : null,
    incidents: [...s.incidents],
    progress: { ...s.progress, slotSignatures: [...s.progress.slotSignatures] },
  };
}

/**
 * In-memory ledger. Zero dependencies, fully synchronous, loses state on
 * restart — for tests only (config refuses `LEDGER=memory` outside
 * NODE_ENV=test unless ALLOW_MEMORY_LEDGER=true). Request IDs are random u64s,
 * so a restart never re-issues an ID a previous process handed out.
 *
 * Every mutating method runs inside {@link atomic}, which snapshots state and
 * restores it if the section throws — the in-memory equivalent of a DB
 * transaction rollback.
 */
export class MemoryLedger implements Ledger {
  private s: State = {
    balances: new Map(),
    holds: new Map(),
    seenEvents: new Set(),
    house: { available: 0n, pending: 0n },
    incident: null,
    incidents: [],
    progress: { cursor: null, slot: null, drainedThroughBlockHeight: null, slotSignatures: [] },
  };
  private readonly adminKey?: string;
  private readonly nextId: () => bigint;
  private readonly failpoint: (step: string) => void;

  constructor(opts: LedgerOptions = {}) {
    this.adminKey = opts.adminKey;
    this.nextId = opts.requestIdGenerator ?? randomRequestId;
    this.failpoint = opts.failpoint ?? (() => {});
  }

  private atomic<T>(fn: () => T): T {
    const snapshot = cloneState(this.s);
    try {
      return fn();
    } catch (err) {
      this.s = snapshot;
      throw err;
    }
  }

  ensureUser(ownerKey: string): void {
    if (!this.s.balances.has(ownerKey)) {
      this.s.balances.set(ownerKey, { available: 0n, pending: 0n });
    }
  }

  getBalance(ownerKey: string): Balance {
    const b = this.s.balances.get(ownerKey) ?? { available: 0n, pending: 0n };
    return { ownerKey, available: b.available, pending: b.pending };
  }

  credit(ownerKey: string, amount: bigint, sourceKey: string): "credited" | "duplicate" {
    return this.atomic(() => {
      if (this.s.seenEvents.has(sourceKey)) return "duplicate" as const;
      this.s.seenEvents.add(sourceKey);
      this.failpoint("credit:after-seen");
      this.ensureUser(ownerKey);
      this.s.balances.get(ownerKey)!.available += amount;
      return "credited" as const;
    });
  }

  applyDepositEvent(
    sourceKey: string,
    event: { user: string; amount: bigint },
  ): "credited" | "house" | "duplicate" {
    return this.atomic(() => {
      if (this.s.seenEvents.has(sourceKey)) return "duplicate" as const;
      this.s.seenEvents.add(sourceKey);
      this.failpoint("deposit:after-seen");
      if (this.adminKey !== undefined && event.user === this.adminKey) {
        this.s.house.available += event.amount;
        return "house" as const;
      }
      this.ensureUser(event.user);
      this.s.balances.get(event.user)!.available += event.amount;
      return "credited" as const;
    });
  }

  applyWithdrawEvent(
    sourceKey: string,
    event: { requestId: bigint; user: string; amount: bigint; txSignature: string },
  ): SettleOutcome | { kind: "duplicate" } {
    return this.atomic(() => {
      if (this.s.seenEvents.has(sourceKey)) return { kind: "duplicate" as const };
      this.s.seenEvents.add(sourceKey);
      this.failpoint("withdraw:after-seen");
      const outcome = this.settleHoldInner({ ...event, eventKey: sourceKey });
      this.failpoint("withdraw:after-settle");
      if (isIncidentOutcome(outcome)) {
        this.openIncidentInner(`WithdrawEvent ${outcome.kind}`, {
          sourceKey,
          requestId: event.requestId.toString(),
          user: event.user,
          amount: event.amount.toString(),
        });
      }
      return outcome;
    });
  }

  placeHold(params: {
    ownerKey: string;
    amount: bigint;
    destination: string;
    lastValidBlockHeight: number;
  }): Hold {
    return this.atomic(() => {
      if (this.s.incident) throw new IncidentOpenError(this.s.incident.reason);
      if (params.destination !== params.ownerKey) {
        throw new DestinationMismatchError("destination must be the owner's own wallet");
      }
      if (params.amount <= 0n) throw new Error("amount must be positive");
      this.ensureUser(params.ownerKey);
      const b = this.s.balances.get(params.ownerKey)!;
      if (b.available < params.amount) {
        throw new InsufficientFundsError(params.ownerKey, params.amount, b.available);
      }
      // Atomic check -> move: no await between these lines.
      b.available -= params.amount;
      b.pending += params.amount;
      return this.createHold({ ...params, isHouse: false });
    });
  }

  placeHouseHold(params: {
    amount: bigint;
    destination: string;
    lastValidBlockHeight: number;
  }): Hold {
    return this.atomic(() => {
      if (this.s.incident) throw new IncidentOpenError(this.s.incident.reason);
      if (this.adminKey === undefined || params.destination !== this.adminKey) {
        throw new DestinationMismatchError("house withdrawals must pay the admin wallet");
      }
      if (params.amount <= 0n) throw new Error("amount must be positive");
      if (this.s.house.available < params.amount) {
        throw new InsufficientFundsError("house", params.amount, this.s.house.available);
      }
      this.s.house.available -= params.amount;
      this.s.house.pending += params.amount;
      return this.createHold({
        ownerKey: params.destination,
        amount: params.amount,
        destination: params.destination,
        lastValidBlockHeight: params.lastValidBlockHeight,
        isHouse: true,
      });
    });
  }

  private createHold(params: {
    ownerKey: string;
    amount: bigint;
    destination: string;
    lastValidBlockHeight: number;
    isHouse: boolean;
  }): Hold {
    let requestId: bigint;
    let attempts = 0;
    do {
      if (++attempts > 16) throw new Error("could not allocate a unique request id");
      requestId = this.nextId();
      assertU64RequestId(requestId);
    } while (this.s.holds.has(requestId.toString()));
    const hold: Hold = {
      requestId,
      ownerKey: params.ownerKey,
      amount: params.amount,
      destination: params.destination,
      lastValidBlockHeight: params.lastValidBlockHeight,
      status: "open",
      isHouse: params.isHouse,
      createdAt: Date.now(),
      txSignature: null,
      settledEventKey: null,
    };
    this.s.holds.set(requestId.toString(), hold);
    return { ...hold };
  }

  settleHold(params: {
    requestId: bigint;
    user: string;
    amount: bigint;
    txSignature: string;
    eventKey?: string;
  }): SettleOutcome {
    return this.atomic(() => this.settleHoldInner(params));
  }

  private settleHoldInner(params: {
    requestId: bigint;
    user: string;
    amount: bigint;
    txSignature: string;
    eventKey?: string;
  }): SettleOutcome {
    const stored = this.s.holds.get(params.requestId.toString());
    const outcome = evaluateSettle(stored ? { ...stored } : null, params, this.adminKey);
    if (outcome.kind !== "settled") return outcome;
    const hold = stored!;
    if (hold.isHouse) {
      this.s.house.pending -= hold.amount; // left the pool: house bankroll shrinks
    } else {
      this.s.balances.get(hold.ownerKey)!.pending -= hold.amount; // debit is final
    }
    hold.status = "settled";
    hold.txSignature = params.txSignature;
    hold.settledEventKey = params.eventKey ?? null;
    return { kind: "settled", hold: { ...hold } };
  }

  releaseHold(requestId: bigint): "released" | "cannot" {
    return this.atomic(() => {
      const hold = this.s.holds.get(requestId.toString());
      if (!hold || hold.status !== "open") return "cannot" as const;
      if (hold.isHouse) {
        this.s.house.pending -= hold.amount;
        this.s.house.available += hold.amount;
      } else {
        const b = this.s.balances.get(hold.ownerKey)!;
        b.pending -= hold.amount;
        b.available += hold.amount;
      }
      hold.status = "released";
      return "released" as const;
    });
  }

  getHold(requestId: bigint): Hold | null {
    const hold = this.s.holds.get(requestId.toString());
    return hold ? { ...hold } : null;
  }

  listOpenHolds(): Hold[] {
    return [...this.s.holds.values()]
      .filter((h) => h.status === "open")
      .map((h) => ({ ...h }));
  }

  recordEventSeen(sourceKey: string): "new" | "seen" {
    if (this.s.seenEvents.has(sourceKey)) return "seen";
    this.s.seenEvents.add(sourceKey);
    return "new";
  }

  houseBalance(): { available: bigint; pending: bigint } {
    return { ...this.s.house };
  }

  totals(): { available: bigint; pending: bigint } {
    let available = 0n;
    let pending = 0n;
    for (const b of this.s.balances.values()) {
      available += b.available;
      pending += b.pending;
    }
    return { available, pending };
  }

  getIncident(): IncidentState | null {
    return this.s.incident ? { ...this.s.incident } : null;
  }

  openIncident(reason: string, detail: Record<string, unknown> = {}): void {
    this.atomic(() => this.openIncidentInner(reason, detail));
  }

  private openIncidentInner(reason: string, detail: Record<string, unknown>): void {
    const at = Date.now();
    if (!this.s.incident) this.s.incident = { reason, openedAt: at };
    this.s.incidents.push({ at, reason, detail: JSON.stringify(detail) });
  }

  clearIncident(): boolean {
    const was = this.s.incident !== null;
    this.s.incident = null;
    return was;
  }

  listIncidents(): IncidentRecord[] {
    return this.s.incidents.map((r) => ({ ...r }));
  }

  getProgress(): ListenerProgress {
    return { ...this.s.progress, slotSignatures: [...this.s.progress.slotSignatures] };
  }

  getCursor(): string | null {
    return this.s.progress.cursor;
  }

  setCursor(signature: string, slot?: number): void {
    const p = this.s.progress;
    if (slot !== undefined && slot === p.slot) {
      if (!p.slotSignatures.includes(signature)) p.slotSignatures.push(signature);
    } else {
      p.slotSignatures = [signature];
    }
    p.cursor = signature;
    if (slot !== undefined) p.slot = slot;
  }

  setDrainedThroughBlockHeight(height: number): void {
    this.s.progress.drainedThroughBlockHeight = height;
  }

  private binding: ChainBinding | null = null;

  getChainBinding(): ChainBinding | null {
    return this.binding ? { ...this.binding } : null;
  }

  setChainBinding(binding: ChainBinding): void {
    this.binding = { ...binding };
  }

  private lease: { holder: string; expiresAt: number } | null = null;

  acquireListenerLease(holder: string, ttlMs: number, now = Date.now()): boolean {
    if (this.lease && this.lease.holder !== holder && this.lease.expiresAt > now) return false;
    this.lease = { holder, expiresAt: now + ttlMs };
    return true;
  }

  releaseListenerLease(holder: string): void {
    if (this.lease?.holder === holder) this.lease = null;
  }

  close(): void {}
}
