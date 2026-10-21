import type { Config } from "./config";
import type { Ledger } from "./ledger/types";
import { MemoryLedger } from "./ledger/memory";

export interface Storage {
  /** The ledger also holds the listener cursor and the incident kill-switch. */
  ledger: Ledger;
  close(): void;
}

/**
 * Builds the ledger the config selects. `sqlite` is durable (holds, cursor and
 * kill-switch survive a restart) and is what the API, the listener and the
 * reconcile job must SHARE (same DB_PATH). `memory` is for tests only —
 * loadConfig refuses it elsewhere unless ALLOW_MEMORY_LEDGER=true.
 * SQLite is imported lazily so a `memory` run needs no native module.
 *
 * `adminKey` (base58) routes admin-wallet deposits to the house bankroll and is
 * the only destination a house withdrawal may pay. `readOnly` (SQLite only)
 * opens an existing ledger without write access and fails if the file is
 * missing.
 */
export async function createStorage(
  config: Config,
  opts: { adminKey?: string; readOnly?: boolean } = {},
): Promise<Storage> {
  if (config.ledger === "memory") {
    const ledger = new MemoryLedger({ adminKey: opts.adminKey });
    return { ledger, close: () => ledger.close() };
  }

  const { SqliteLedger } = await import("./ledger/sqlite");
  const ledger = new SqliteLedger(config.dbPath, {
    adminKey: opts.adminKey,
    readOnly: opts.readOnly,
  });
  return { ledger, close: () => ledger.close() };
}
