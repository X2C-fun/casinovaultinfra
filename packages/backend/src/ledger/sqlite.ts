import Database from "better-sqlite3";
import {
  type Balance,
  type Hold,
  type HoldStatus,
  type Ledger,
  type SettleOutcome,
  InsufficientFundsError,
} from "./types";

/**
 * Durable ledger backed by SQLite (better-sqlite3). Synchronous, so the
 * check-then-hold critical section stays atomic, and holds survive a crash.
 * The same logic ports to Postgres with a transaction around `placeHold`.
 *
 * Lamport amounts are stored as TEXT to preserve full u64 range.
 */
export class SqliteLedger implements Ledger {
  private db: Database.Database;

  constructor(path = "casinovault.db") {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS balances (
        owner_key TEXT PRIMARY KEY,
        available TEXT NOT NULL DEFAULT '0',
        pending   TEXT NOT NULL DEFAULT '0'
      );
      CREATE TABLE IF NOT EXISTS holds (
        request_id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_key TEXT NOT NULL,
        amount TEXT NOT NULL,
        destination TEXT NOT NULL,
        last_valid_block_height INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        is_house INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        tx_signature TEXT
      );
      CREATE INDEX IF NOT EXISTS holds_status ON holds(status);
      CREATE TABLE IF NOT EXISTS seen_events (source_key TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  ensureUser(ownerKey: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO balances(owner_key) VALUES (?)")
      .run(ownerKey);
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
    const tx = this.db.transaction(() => {
      const inserted = this.db
        .prepare("INSERT OR IGNORE INTO seen_events(source_key) VALUES (?)")
        .run(sourceKey);
      if (inserted.changes === 0) return "duplicate" as const;
      this.ensureUser(ownerKey);
      const b = this.getBalance(ownerKey);
      this.db
        .prepare("UPDATE balances SET available = ? WHERE owner_key = ?")
        .run((b.available + amount).toString(), ownerKey);
      return "credited" as const;
    });
    return tx();
  }

  placeHold(params: {
    ownerKey: string;
    amount: bigint;
    destination: string;
    lastValidBlockHeight: number;
  }): Hold {
    const tx = this.db.transaction(() => {
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
    });
    return tx();
  }

  placeHouseHold(params: {
    amount: bigint;
    destination: string;
    lastValidBlockHeight: number;
  }): Hold {
    return this.insertHold({
      ownerKey: params.destination,
      amount: params.amount,
      destination: params.destination,
      lastValidBlockHeight: params.lastValidBlockHeight,
      isHouse: true,
    });
  }

  private insertHold(params: {
    ownerKey: string;
    amount: bigint;
    destination: string;
    lastValidBlockHeight: number;
    isHouse: boolean;
  }): Hold {
    const info = this.db
      .prepare(
        `INSERT INTO holds(owner_key, amount, destination, last_valid_block_height, status, is_house, created_at)
         VALUES (?, ?, ?, ?, 'open', ?, ?)`,
      )
      .run(
        params.ownerKey,
        params.amount.toString(),
        params.destination,
        params.lastValidBlockHeight,
        params.isHouse ? 1 : 0,
        Date.now(),
      );
    return this.getHold(BigInt(info.lastInsertRowid as number))!;
  }

  settleHold(params: {
    requestId: bigint;
    user: string;
    amount: bigint;
    txSignature: string;
  }): SettleOutcome {
    const tx = this.db.transaction((): SettleOutcome => {
      const hold = this.getHold(params.requestId);
      if (!hold) return { kind: "notfound" };
      if (hold.status === "settled") return { kind: "already" };
      if (hold.status === "released") return { kind: "mismatch", hold };
      if (hold.destination !== params.user || hold.amount !== params.amount) {
        return { kind: "mismatch", hold };
      }
      if (!hold.isHouse) {
        const b = this.getBalance(hold.ownerKey);
        this.db
          .prepare("UPDATE balances SET pending = ? WHERE owner_key = ?")
          .run((b.pending - hold.amount).toString(), hold.ownerKey);
      }
      this.db
        .prepare("UPDATE holds SET status = 'settled', tx_signature = ? WHERE request_id = ?")
        .run(params.txSignature, Number(params.requestId));
      return { kind: "settled", hold: { ...hold, status: "settled", txSignature: params.txSignature } };
    });
    return tx();
  }

  releaseHold(requestId: bigint): "released" | "cannot" {
    const tx = this.db.transaction((): "released" | "cannot" => {
      const hold = this.getHold(requestId);
      if (!hold || hold.status !== "open") return "cannot";
      if (!hold.isHouse) {
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
        .run(Number(requestId));
      return "released";
    });
    return tx();
  }

  getHold(requestId: bigint): Hold | null {
    const row = this.db
      .prepare("SELECT * FROM holds WHERE request_id = ?")
      .get(Number(requestId)) as Record<string, unknown> | undefined;
    return row ? rowToHold(row) : null;
  }

  listOpenHolds(): Hold[] {
    const rows = this.db
      .prepare("SELECT * FROM holds WHERE status = 'open'")
      .all() as Record<string, unknown>[];
    return rows.map(rowToHold);
  }

  recordEventSeen(sourceKey: string): "new" | "seen" {
    const info = this.db
      .prepare("INSERT OR IGNORE INTO seen_events(source_key) VALUES (?)")
      .run(sourceKey);
    return info.changes > 0 ? "new" : "seen";
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

  getCursor(): string | null {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = 'listener_cursor'")
      .get() as { value: string } | undefined;
    return row?.value ?? null;
  }

  setCursor(signature: string): void {
    this.db
      .prepare(
        "INSERT INTO meta(key, value) VALUES ('listener_cursor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(signature);
  }

  close(): void {
    this.db.close();
  }
}

function rowToHold(row: Record<string, unknown>): Hold {
  return {
    requestId: BigInt(row.request_id as number),
    ownerKey: row.owner_key as string,
    amount: BigInt(row.amount as string),
    destination: row.destination as string,
    lastValidBlockHeight: row.last_valid_block_height as number,
    status: row.status as HoldStatus,
    isHouse: (row.is_house as number) === 1,
    createdAt: row.created_at as number,
    txSignature: (row.tx_signature as string | null) ?? null,
  };
}
