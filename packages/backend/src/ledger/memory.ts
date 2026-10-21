import {
  type Balance,
  type Hold,
  type Ledger,
  type SettleOutcome,
  InsufficientFundsError,
} from "./types";

/**
 * In-memory ledger. Zero dependencies, fully synchronous, loses state on
 * restart — ideal for tests and demos, NOT for production (a crash drops every
 * open hold). Use {@link SqliteLedger} for durability, or port this logic to
 * your own database. All the balance correctness lives here, not in the store.
 */
export class MemoryLedger implements Ledger {
  private balances = new Map<string, { available: bigint; pending: bigint }>();
  private holds = new Map<string, Hold>(); // key: requestId.toString()
  private seenEvents = new Set<string>();
  private nextRequestId = 1n;

  ensureUser(ownerKey: string): void {
    if (!this.balances.has(ownerKey)) {
      this.balances.set(ownerKey, { available: 0n, pending: 0n });
    }
  }

  getBalance(ownerKey: string): Balance {
    const b = this.balances.get(ownerKey) ?? { available: 0n, pending: 0n };
    return { ownerKey, available: b.available, pending: b.pending };
  }

  credit(ownerKey: string, amount: bigint, sourceKey: string): "credited" | "duplicate" {
    if (this.seenEvents.has(sourceKey)) return "duplicate";
    this.seenEvents.add(sourceKey);
    this.ensureUser(ownerKey);
    const b = this.balances.get(ownerKey)!;
    b.available += amount;
    return "credited";
  }

  placeHold(params: {
    ownerKey: string;
    amount: bigint;
    destination: string;
    lastValidBlockHeight: number;
  }): Hold {
    this.ensureUser(params.ownerKey);
    const b = this.balances.get(params.ownerKey)!;
    if (b.available < params.amount) {
      throw new InsufficientFundsError(params.ownerKey, params.amount, b.available);
    }
    // Atomic check -> move: no await between these lines.
    b.available -= params.amount;
    b.pending += params.amount;
    return this.createHold({ ...params, isHouse: false });
  }

  placeHouseHold(params: {
    amount: bigint;
    destination: string;
    lastValidBlockHeight: number;
  }): Hold {
    return this.createHold({
      ownerKey: params.destination,
      amount: params.amount,
      destination: params.destination,
      lastValidBlockHeight: params.lastValidBlockHeight,
      isHouse: true,
    });
  }

  private createHold(params: {
    ownerKey: string;
    amount: bigint;
    destination: string;
    lastValidBlockHeight: number;
    isHouse: boolean;
  }): Hold {
    const requestId = this.nextRequestId++;
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
    };
    this.holds.set(requestId.toString(), hold);
    return { ...hold };
  }

  settleHold(params: {
    requestId: bigint;
    user: string;
    amount: bigint;
    txSignature: string;
  }): SettleOutcome {
    const hold = this.holds.get(params.requestId.toString());
    if (!hold) return { kind: "notfound" };
    if (hold.status === "settled") return { kind: "already" };
    if (hold.status === "released") return { kind: "mismatch", hold: { ...hold } };
    // Match the event against the hold: destination + amount must agree.
    if (hold.destination !== params.user || hold.amount !== params.amount) {
      return { kind: "mismatch", hold: { ...hold } };
    }
    if (!hold.isHouse) {
      const b = this.balances.get(hold.ownerKey)!;
      b.pending -= hold.amount; // pending -> gone: the debit is now final
    }
    hold.status = "settled";
    hold.txSignature = params.txSignature;
    return { kind: "settled", hold: { ...hold } };
  }

  releaseHold(requestId: bigint): "released" | "cannot" {
    const hold = this.holds.get(requestId.toString());
    if (!hold || hold.status !== "open") return "cannot";
    if (!hold.isHouse) {
      const b = this.balances.get(hold.ownerKey)!;
      b.pending -= hold.amount;
      b.available += hold.amount;
    }
    hold.status = "released";
    return "released";
  }

  getHold(requestId: bigint): Hold | null {
    const hold = this.holds.get(requestId.toString());
    return hold ? { ...hold } : null;
  }

  listOpenHolds(): Hold[] {
    return [...this.holds.values()]
      .filter((h) => h.status === "open")
      .map((h) => ({ ...h }));
  }

  recordEventSeen(sourceKey: string): "new" | "seen" {
    if (this.seenEvents.has(sourceKey)) return "seen";
    this.seenEvents.add(sourceKey);
    return "new";
  }

  totals(): { available: bigint; pending: bigint } {
    let available = 0n;
    let pending = 0n;
    for (const b of this.balances.values()) {
      available += b.available;
      pending += b.pending;
    }
    return { available, pending };
  }
}
