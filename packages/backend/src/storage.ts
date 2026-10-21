import type { Config } from "./config";
import type { Ledger } from "./ledger/types";
import { MemoryLedger } from "./ledger/memory";

export interface Storage {
  ledger: Ledger;
  getCursor(): string | null;
  setCursor(signature: string): void;
  close(): void;
}

/**
 * Builds the ledger + listener-cursor store the config selects. `sqlite` is
 * durable (holds survive a restart); `memory` is for tests and demos only.
 * SQLite is imported lazily so a `memory` run needs no native module.
 */
export async function createStorage(config: Config): Promise<Storage> {
  if (config.ledger === "memory") {
    const ledger = new MemoryLedger();
    let cursor: string | null = null;
    return {
      ledger,
      getCursor: () => cursor,
      setCursor: (sig) => {
        cursor = sig;
      },
      close: () => {},
    };
  }

  const { SqliteLedger } = await import("./ledger/sqlite");
  const ledger = new SqliteLedger(config.dbPath);
  return {
    ledger,
    getCursor: () => ledger.getCursor(),
    setCursor: (sig) => ledger.setCursor(sig),
    close: () => ledger.close(),
  };
}
