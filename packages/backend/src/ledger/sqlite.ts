import Database from "better-sqlite3";
import {
  type Balance,
  type ChainBinding,
  type Hold,
  type HoldStatus,
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

const SCHEMA_VERSION = 2;

/**
 * Durable ledger backed by SQLite (better-sqlite3). Synchronous, so the
 * check-then-hold critical section stays atomic, and holds survive a crash.
 * Every multi-step mutation runs in one `db.transaction`, so a crash (or a
 * throw) between steps rolls all of it back. The same logic ports to Postgres
 * with a transaction around each method.
 *
 * Lamport amounts AND request IDs are stored as TEXT (decimal) to preserve the
 * full u64 range; nothing here goes through `Number()`.
 *
 * The HTTP API, the listener and the reconcile job must open the SAME file.
 */
export class SqliteLedger implements Ledger {
  private db: Database.Database;
  private readonly adminKey?: string;
  private readonly nextId: () => bigint;
  private readonly failpoint: (step: string) => void;

  /**
   * `readOnly` opens an EXISTING, already-migrated database without write
   * access (reconcile uses it, so a wrong DB_PATH fails instead of creating an
   * empty ledger that "reconciles" to zero). Every mutating method runs in an
   * IMMEDIATE transaction: under WAL a deferred transaction that upgrades from
   * read to write fails with SQLITE_BUSY_SNAPSHOT when another process (API vs
   * listener) committed in between; IMMEDIATE takes the write lock up front and
   * waits on `busy_timeout` instead.
   */
  constructor(
    path = "casinovault.db",
    opts: LedgerOptions & { readOnly?: boolean; fileMustExist?: boolean } = {},
  ) {
    this.adminKey = opts.adminKey;
    this.nextId = opts.requestIdGenerator ?? randomRequestId;
    this.failpoint = opts.failpoint ?? (() => {});
    if (opts.readOnly) {
      this.db = new Database(path, { readonly: true, fileMustExist: true });
      this.db.pragma("busy_timeout = 5000");
      const version = this.db.pragma("user_version", { simple: true }) as number;
      if (version !== SCHEMA_VERSION) {
        this.db.close();
        throw new Error(`${path} is not a casinovault ledger (schema ${version})`);
      }
      return;
    }
    // `fileMustExist`: operator CLIs must not create an empty ledger on a
    // mistyped DB_PATH.
    this.db = new Database(path, { fileMustExist: opts.fileMustExist ?? false });
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
  }

  private migrate(): void {
    const version = this.db.pragma("user_version", { simple: true }) as number;
    const hasHolds = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'holds'")
      .get();
    if (version === 0 && hasHolds) {
      throw new Error(
        "ledger database uses an older schema (integer request ids); start from a fresh DB_PATH",
      );
    }
    if (version > SCHEMA_VERSION) {
      throw new Error(`ledger database schema ${version} is newer than this backend`);
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS balances (
        owner_key TEXT PRIMARY KEY,
        available TEXT NOT NULL DEFAULT '0',
        pending   TEXT NOT NULL DEFAULT '0'
      );
      CREATE TABLE IF NOT EXISTS holds (
        request_id TEXT PRIMARY KEY,
        owner_key TEXT NOT NULL,
        amount TEXT NOT NULL,
        destination TEXT NOT NULL,
        last_valid_block_height INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        is_house INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        tx_signature TEXT,
        settled_event_key TEXT
      );
      CREATE INDEX IF NOT EXISTS holds_status ON holds(status);
      CREATE TABLE IF NOT EXISTS seen_events (source_key TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS incidents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        reason TEXT NOT NULL,
        detail TEXT NOT NULL
      );
    `);
    this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  // --- meta helpers -----------------------------------------------------------

  private getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  private deleteMeta(key: string): void {
    this.db.prepare("DELETE FROM meta WHERE key = ?").run(key);
  }

  private markSeen(sourceKey: string): boolean {
    return (
      this.db.prepare("INSERT OR IGNORE INTO seen_events(source_key) VALUES (?)").run(sourceKey)
        .changes > 0
    );
  }

  private addAvailable(ownerKey: string, delta: bigint): void {
    this.ensureUser(ownerKey);
    const b = this.getBalance(ownerKey);
    this.db
      .prepare("UPDATE balances SET available = ? WHERE owner_key = ?")
      .run((b.available + delta).toString(), ownerKey);
  }

  private setHouse(h: { available: bigint; pending: bigint }): void {
    this.setMeta("house_available", h.available.toString());
    this.setMeta("house_pending", h.pending.toString());
  }

  // --- balances ---------------------------------------------------------------

  ensureUser(ownerKey: string): void {
    this.db.prepare("INSERT OR IGNORE INTO balances(owner_key) VALUES (?)").run(ownerKey);
  }

  getBalance(ownerKey: string): Balance {
    const row = this.db
      .prepare("SELECT available, pending FROM balances WHERE owner_key = ?")
      .get(ownerKey) as { available: string; pending: string } | undefined;
    return {
      ownerKey,
      available: BigInt(row?.available ?? "0"),
      pending: BigInt(row?.pending ?? "0"),
    };
  }

  credit(ownerKey: string, amount: bigint, sourceKey: string): "credited" | "duplicate" {
    return this.db.transaction(() => {
      if (!this.markSeen(sourceKey)) return "duplicate" as const;
      this.failpoint("credit:after-seen");
      this.addAvailable(ownerKey, amount);
      return "credited" as const;
    }).immediate();
  }

  applyDepositEvent(
    sourceKey: string,
    event: { user: string; amount: bigint },
  ): "credited" | "house" | "duplicate" {
    return this.db.transaction(() => {
      if (!this.markSeen(sourceKey)) return "duplicate" as const;
      this.failpoint("deposit:after-seen");
      if (this.adminKey !== undefined && event.user === this.adminKey) {
        const h = this.houseBalance();
        this.setHouse({ available: h.available + event.amount, pending: h.pending });
        return "house" as const;
      }
      this.addAvailable(event.user, event.amount);
      return "credited" as const;
    }).immediate();
  }

  applyWithdrawEvent(
    sourceKey: string,
    event: { requestId: bigint; user: string; amount: bigint; txSignature: string },
  ): SettleOutcome | { kind: "duplicate" } {
    return this.db.transaction((): SettleOutcome | { kind: "duplicate" } => {
      if (!this.markSeen(sourceKey)) return { kind: "duplicate" };
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
    }).immediate();
  }

  // --- holds ------------------------------------------------------------------

  placeHold(params: {
    ownerKey: string;
    amount: bigint;
    destination: string;
    lastValidBlockHeight: number;
  }): Hold {
    return this.db.transaction(() => {
      const incident = this.getIncident();
      if (incident) throw new IncidentOpenError(incident.reason);
      if (params.destination !== params.ownerKey) {
        throw new DestinationMismatchError("destination must be the owner's own wallet");
      }
      if (params.amount <= 0n) throw new Error("amount must be positive");
      this.ensureUser(params.ownerKey);
      const b = this.getBalance(params.ownerKey);
      if (b.available < params.amount) {
        throw new InsufficientFundsError(params.ownerKey, params.amount, b.available);
      }
      this.db
        .prepare("UPDATE balances SET available = ?, pending = ? WHERE owner_key = ?")
        .run(
          (b.available - params.amount).toString(),
          (b.pending + params.amount).toString(),
          params.ownerKey,
        );
      return this.insertHold({ ...params, isHouse: false });
    }).immediate();
  }

  placeHouseHold(params: {
    amount: bigint;
    destination: string;
    lastValidBlockHeight: number;
  }): Hold {
    return this.db.transaction(() => {
      const incident = this.getIncident();
      if (incident) throw new IncidentOpenError(incident.reason);
      if (this.adminKey === undefined || params.destination !== this.adminKey) {
        throw new DestinationMismatchError("house withdrawals must pay the admin wallet");
      }
      if (params.amount <= 0n) throw new Error("amount must be positive");
      const h = this.houseBalance();
      if (h.available < params.amount) {
        throw new InsufficientFundsError("house", params.amount, h.available);
      }
      this.setHouse({ available: h.available - params.amount, pending: h.pending + params.amount });
      return this.insertHold({
        ownerKey: params.destination,
        amount: params.amount,
        destination: params.destination,
        lastValidBlockHeight: params.lastValidBlockHeight,
        isHouse: true,
      });
    }).immediate();
  }

  private insertHold(params: {
    ownerKey: string;
    amount: bigint;
    destination: string;
    lastValidBlockHeight: number;
    isHouse: boolean;
  }): Hold {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO holds(request_id, owner_key, amount, destination, last_valid_block_height, status, is_house, created_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
    );
    for (let attempt = 0; attempt < 16; attempt++) {
      const requestId = this.nextId();
      assertU64RequestId(requestId);
      const info = insert.run(
        requestId.toString(),
        params.ownerKey,
        params.amount.toString(),
        params.destination,
        params.lastValidBlockHeight,
        params.isHouse ? 1 : 0,
        Date.now(),
      );
      if (info.changes === 1) return this.getHold(requestId)!;
      // PRIMARY KEY collision: draw again (uniqueness is enforced by the DB).
    }
    throw new Error("could not allocate a unique request id");
  }

  settleHold(params: {
    requestId: bigint;
    user: string;
    amount: bigint;
    txSignature: string;
    eventKey?: string;
  }): SettleOutcome {
    return this.db.transaction(() => this.settleHoldInner(params)).immediate();
  }

  private settleHoldInner(params: {
    requestId: bigint;
    user: string;
    amount: bigint;
    txSignature: string;
    eventKey?: string;
  }): SettleOutcome {
    const hold = this.getHold(params.requestId);
    const outcome = evaluateSettle(hold, params, this.adminKey);
    if (outcome.kind !== "settled") return outcome;
    const h = hold!;
    if (h.isHouse) {
      const house = this.houseBalance();
      this.setHouse({ available: house.available, pending: house.pending - h.amount });
    } else {
      const b = this.getBalance(h.ownerKey);
      this.db
        .prepare("UPDATE balances SET pending = ? WHERE owner_key = ?")
        .run((b.pending - h.amount).toString(), h.ownerKey);
    }
    this.db
      .prepare(
        "UPDATE holds SET status = 'settled', tx_signature = ?, settled_event_key = ? WHERE request_id = ?",
      )
      .run(params.txSignature, params.eventKey ?? null, h.requestId.toString());
    return {
      kind: "settled",
      hold: {
        ...h,
        status: "settled",
        txSignature: params.txSignature,
        settledEventKey: params.eventKey ?? null,
      },
    };
  }

  releaseHold(requestId: bigint): "released" | "cannot" {
    return this.db.transaction((): "released" | "cannot" => {
      const hold = this.getHold(requestId);
      if (!hold || hold.status !== "open") return "cannot";
      if (hold.isHouse) {
        const h = this.houseBalance();
        this.setHouse({ available: h.available + hold.amount, pending: h.pending - hold.amount });
      } else {
        const b = this.getBalance(hold.ownerKey);
        this.db
          .prepare("UPDATE balances SET available = ?, pending = ? WHERE owner_key = ?")
          .run(
            (b.available + hold.amount).toString(),
            (b.pending - hold.amount).toString(),
            hold.ownerKey,
          );
      }
      this.db
        .prepare("UPDATE holds SET status = 'released' WHERE request_id = ?")
        .run(requestId.toString());
      return "released";
    }).immediate();
  }

  getHold(requestId: bigint): Hold | null {
    const row = this.db
      .prepare("SELECT * FROM holds WHERE request_id = ?")
      .get(requestId.toString()) as Record<string, unknown> | undefined;
    return row ? rowToHold(row) : null;
  }

  listOpenHolds(): Hold[] {
    const rows = this.db
      .prepare("SELECT * FROM holds WHERE status = 'open'")
      .all() as Record<string, unknown>[];
    return rows.map(rowToHold);
  }

  recordEventSeen(sourceKey: string): "new" | "seen" {
    return this.markSeen(sourceKey) ? "new" : "seen";
  }

  houseBalance(): { available: bigint; pending: bigint } {
    return {
      available: BigInt(this.getMeta("house_available") ?? "0"),
      pending: BigInt(this.getMeta("house_pending") ?? "0"),
    };
  }

  totals(): { available: bigint; pending: bigint } {
    const rows = this.db.prepare("SELECT available, pending FROM balances").all() as {
      available: string;
      pending: string;
    }[];
    let available = 0n;
    let pending = 0n;
    for (const r of rows) {
      available += BigInt(r.available);
      pending += BigInt(r.pending);
    }
    return { available, pending };
  }

  // --- incident kill-switch ---------------------------------------------------

  getIncident(): IncidentState | null {
    const raw = this.getMeta("incident_open");
    return raw ? (JSON.parse(raw) as IncidentState) : null;
  }

  openIncident(reason: string, detail: Record<string, unknown> = {}): void {
    this.db.transaction(() => this.openIncidentInner(reason, detail)).immediate();
  }

  private openIncidentInner(reason: string, detail: Record<string, unknown>): void {
    const at = Date.now();
    if (!this.getMeta("incident_open")) {
      this.setMeta("incident_open", JSON.stringify({ reason, openedAt: at }));
    }
    this.db
      .prepare("INSERT INTO incidents(at, reason, detail) VALUES (?, ?, ?)")
      .run(at, reason, JSON.stringify(detail));
  }

  clearIncident(): boolean {
    return this.db.transaction(() => {
      const was = this.getMeta("incident_open") !== null;
      this.deleteMeta("incident_open");
      return was;
    }).immediate();
  }

  listIncidents(): IncidentRecord[] {
    return this.db
      .prepare("SELECT at, reason, detail FROM incidents ORDER BY id")
      .all() as IncidentRecord[];
  }

  // --- listener progress ------------------------------------------------------

  getProgress(): ListenerProgress {
    const slot = this.getMeta("listener_slot");
    const drained = this.getMeta("drained_through_block_height");
    const sigs = this.getMeta("listener_slot_signatures");
    return {
      cursor: this.getMeta("listener_cursor"),
      slot: slot === null ? null : Number(slot),
      drainedThroughBlockHeight: drained === null ? null : Number(drained),
      slotSignatures: sigs === null ? [] : (JSON.parse(sigs) as string[]),
    };
  }

  getCursor(): string | null {
    return this.getMeta("listener_cursor");
  }

  setCursor(signature: string, slot?: number): void {
    this.db.transaction(() => {
      const current = this.getMeta("listener_slot");
      let sigs: string[] = [signature];
      if (slot !== undefined && current !== null && Number(current) === slot) {
        const prev = JSON.parse(this.getMeta("listener_slot_signatures") ?? "[]") as string[];
        sigs = prev.includes(signature) ? prev : [...prev, signature];
      }
      this.setMeta("listener_cursor", signature);
      this.setMeta("listener_slot_signatures", JSON.stringify(sigs));
      if (slot !== undefined) this.setMeta("listener_slot", String(slot));
    }).immediate();
  }

  setDrainedThroughBlockHeight(height: number): void {
    this.setMeta("drained_through_block_height", String(height));
  }

  // --- cluster / program binding ----------------------------------------------

  getChainBinding(): ChainBinding | null {
    const genesisHash = this.getMeta("chain_genesis_hash");
    const programId = this.getMeta("chain_program_id");
    return genesisHash !== null && programId !== null ? { genesisHash, programId } : null;
  }

  setChainBinding(binding: ChainBinding): void {
    this.db.transaction(() => {
      this.setMeta("chain_genesis_hash", binding.genesisHash);
      this.setMeta("chain_program_id", binding.programId);
    }).immediate();
  }

  // --- listener lease (lock row: holder id + heartbeat expiry) -----------------

  acquireListenerLease(holder: string, ttlMs: number, now = Date.now()): boolean {
    return this.db
      .transaction(() => {
        const raw = this.getMeta("listener_lease");
        if (raw) {
          const lease = JSON.parse(raw) as { holder: string; expiresAt: number };
          if (lease.holder !== holder && lease.expiresAt > now) return false;
        }
        this.setMeta("listener_lease", JSON.stringify({ holder, expiresAt: now + ttlMs }));
        return true;
      })
      .immediate();
  }

  releaseListenerLease(holder: string): void {
    this.db
      .transaction(() => {
        const raw = this.getMeta("listener_lease");
        if (raw && (JSON.parse(raw) as { holder: string }).holder === holder) {
          this.deleteMeta("listener_lease");
        }
      })
      .immediate();
  }

  close(): void {
    this.db.close();
  }
}

function rowToHold(row: Record<string, unknown>): Hold {
  return {
    requestId: BigInt(row.request_id as string),
    ownerKey: row.owner_key as string,
    amount: BigInt(row.amount as string),
    destination: row.destination as string,
    lastValidBlockHeight: row.last_valid_block_height as number,
    status: row.status as HoldStatus,
    isHouse: (row.is_house as number) === 1,
    createdAt: row.created_at as number,
    txSignature: (row.tx_signature as string | null) ?? null,
    settledEventKey: (row.settled_event_key as string | null) ?? null,
  };
}
