import { PublicKey } from "@solana/web3.js";
import { DEFAULT_PROGRAM_ID } from "@x2c-fun/casinovault-sdk";

/** Backend configuration, read once from the environment at startup. */
export interface Config {
  rpcUrl: string;
  programId: PublicKey;
  port: number;
  /** Interface the HTTP API binds. Default 127.0.0.1 (loopback only). */
  host: string;
  ledger: "memory" | "sqlite";
  dbPath: string;
  /** Optional priority fee added to withdraw transactions, micro-lamports/CU. */
  computeUnitPriceMicroLamports?: bigint;
  computeUnitLimit?: number;
  /**
   * Listener: signature to start after when the ledger has no cursor yet
   * (e.g. the v0.2 upgrade transaction), so v0.1-era history is never decoded.
   */
  startAfterSignature?: string;
  /**
   * Listener: slot of the v0.1 → v0.2 program upgrade. Transactions at or
   * before it use the v0.1 event layout and are skipped (reconcile v0.1
   * balances separately before going live).
   */
  upgradeSlot?: number;
  /** Listener: stop and alert when more signatures than this are pending. */
  listenerMaxBacklog?: number;
}

/** HTTP API auth settings — only the API process needs these. */
export interface ApiAuthConfig {
  /** Bearer token required on every route except /health. */
  apiToken?: string;
  /** ALLOW_UNAUTHENTICATED=true: local development only. */
  allowUnauthenticated: boolean;
}

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

function optionalInt(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const v = env[name]?.trim();
  if (!v) return undefined;
  if (!/^\d+$/.test(v)) throw new Error(`${name} must be a non-negative integer`);
  return Number(v);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const programId = env.VAULT_PROGRAM_ID?.trim()
    ? new PublicKey(env.VAULT_PROGRAM_ID.trim())
    : DEFAULT_PROGRAM_ID;

  const ledger = (env.LEDGER?.trim() as Config["ledger"]) || "sqlite";
  if (ledger !== "memory" && ledger !== "sqlite") {
    throw new Error(`LEDGER must be "memory" or "sqlite", got "${ledger}"`);
  }
  // The memory ledger loses every hold (and the incident kill-switch) on
  // restart, and the API and listener would each get their own copy. Refuse it
  // outside tests unless explicitly allowed.
  if (
    ledger === "memory" &&
    env.NODE_ENV !== "test" &&
    env.ALLOW_MEMORY_LEDGER?.trim() !== "true"
  ) {
    throw new Error(
      'LEDGER=memory is for tests only; set ALLOW_MEMORY_LEDGER=true to use it anyway',
    );
  }

  const cuPrice = env.COMPUTE_UNIT_PRICE_MICRO_LAMPORTS?.trim();
  if (cuPrice && !/^\d+$/.test(cuPrice)) {
    throw new Error("COMPUTE_UNIT_PRICE_MICRO_LAMPORTS must be a non-negative integer");
  }

  const startAfter = env.START_AFTER_SIGNATURE?.trim();

  return {
    rpcUrl: env.RPC_URL?.trim() || "https://api.devnet.solana.com",
    programId,
    port: optionalInt(env, "PORT") ?? 8787,
    host: env.HOST?.trim() || "127.0.0.1",
    ledger,
    dbPath: env.DB_PATH?.trim() || "casinovault.db",
    computeUnitPriceMicroLamports: cuPrice ? BigInt(cuPrice) : undefined,
    computeUnitLimit: optionalInt(env, "COMPUTE_UNIT_LIMIT"),
    startAfterSignature: startAfter || undefined,
    upgradeSlot: optionalInt(env, "UPGRADE_SLOT"),
    listenerMaxBacklog: optionalInt(env, "LISTENER_MAX_BACKLOG"),
  };
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * API auth: API_TOKEN is required unless ALLOW_UNAUTHENTICATED=true, which is
 * only accepted while the API binds a loopback HOST. Placeholder tokens
 * (anything starting with "change-me") are refused. A shared bearer token only
 * keeps strangers off the reference API; a real deployment must authenticate
 * the PLAYER and derive the owner key from the session.
 */
export function loadApiAuthConfig(env: NodeJS.ProcessEnv = process.env): ApiAuthConfig {
  const apiToken = env.API_TOKEN?.trim() || undefined;
  const allowUnauthenticated = env.ALLOW_UNAUTHENTICATED?.trim() === "true";
  const host = env.HOST?.trim() || "127.0.0.1";
  if (allowUnauthenticated && !LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `ALLOW_UNAUTHENTICATED=true is only allowed with a loopback HOST (127.0.0.1, ::1, localhost), got "${host}"`,
    );
  }
  if (!apiToken && !allowUnauthenticated) {
    throw new Error(
      "API_TOKEN is not set (set ALLOW_UNAUTHENTICATED=true only for local development)",
    );
  }
  if (apiToken && apiToken.toLowerCase().startsWith("change-me")) {
    throw new Error("API_TOKEN is still the .env.example placeholder; generate a random token");
  }
  if (apiToken && apiToken.length < 16) {
    throw new Error("API_TOKEN must be at least 16 characters");
  }
  return { apiToken, allowUnauthenticated };
}

/** Ensures `ADMIN_SECRET_KEY` is present without printing it. */
export function requireAdminSecret(): string {
  return required("ADMIN_SECRET_KEY");
}
