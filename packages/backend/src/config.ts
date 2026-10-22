import { PublicKey } from "@solana/web3.js";
import { DEFAULT_PROGRAM_ID, MAX_PRIORITY_FEE_LAMPORTS } from "@x2c-fun/casinovault-sdk";

/** Compute units Solana allows per transaction (the SDK's worst case when unset). */
export const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;
const U64_MAX = (1n << 64n) - 1n;
/** Smallest accepted LISTENER_MAX_BACKLOG (one full signature page). */
export const MIN_LISTENER_MAX_BACKLOG = 1000;

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
  /**
   * Listener: alert threshold for pending signatures in one cycle (with a
   * cursor the whole backlog is still processed); on first start a larger
   * backlog is refused. At least 1000.
   */
  listenerMaxBacklog?: number;
  /**
   * Listener: consecutive cursor-not-found cycles before it opens an incident
   * and pauses the vault (default 10). Until then it only halts and alerts.
   */
  listenerNotFoundIncidentCycles?: number;
  /**
   * HOUSE_BANKROLL_LAMPORTS: house lamports in the pool the ledger cannot see
   * (e.g. seeded by a plain System transfer). Counted as a liability by the
   * reconcile job and the listener's release gate. Default 0.
   */
  houseBankrollLamports?: bigint;
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
  if (cuPrice && (!/^\d+$/.test(cuPrice) || BigInt(cuPrice) > U64_MAX)) {
    throw new Error("COMPUTE_UNIT_PRICE_MICRO_LAMPORTS must be a non-negative integer (u64)");
  }
  const computeUnitLimit = optionalInt(env, "COMPUTE_UNIT_LIMIT");
  if (
    computeUnitLimit !== undefined &&
    (computeUnitLimit < 1 || computeUnitLimit > MAX_COMPUTE_UNIT_LIMIT)
  ) {
    throw new Error(`COMPUTE_UNIT_LIMIT must be an integer from 1 to ${MAX_COMPUTE_UNIT_LIMIT}`);
  }
  // Same bound the SDK enforces when building every withdraw (the user pays
  // the fee): fail at startup instead of on every approval.
  if (cuPrice) {
    const units = BigInt(computeUnitLimit ?? MAX_COMPUTE_UNIT_LIMIT);
    const fee = (BigInt(cuPrice) * units + 999_999n) / 1_000_000n;
    if (fee > MAX_PRIORITY_FEE_LAMPORTS) {
      throw new Error(
        `COMPUTE_UNIT_PRICE_MICRO_LAMPORTS x COMPUTE_UNIT_LIMIT (${units}${
          computeUnitLimit === undefined ? ", the default when unset" : ""
        }) is a priority fee of ${fee} lamports, above the SDK's MAX_PRIORITY_FEE_LAMPORTS ` +
          `(${MAX_PRIORITY_FEE_LAMPORTS})`,
      );
    }
  }

  const listenerMaxBacklog = optionalInt(env, "LISTENER_MAX_BACKLOG");
  if (listenerMaxBacklog !== undefined && listenerMaxBacklog < MIN_LISTENER_MAX_BACKLOG) {
    throw new Error(`LISTENER_MAX_BACKLOG must be at least ${MIN_LISTENER_MAX_BACKLOG}`);
  }

  const notFoundCycles = optionalInt(env, "LISTENER_NOT_FOUND_INCIDENT_CYCLES");
  if (notFoundCycles !== undefined && notFoundCycles < 1) {
    throw new Error("LISTENER_NOT_FOUND_INCIDENT_CYCLES must be at least 1");
  }

  const houseExtra = env.HOUSE_BANKROLL_LAMPORTS?.trim() || "0";
  if (!/^\d+$/.test(houseExtra) || BigInt(houseExtra) > U64_MAX) {
    throw new Error("HOUSE_BANKROLL_LAMPORTS must be a non-negative integer (u64)");
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
    computeUnitLimit,
    startAfterSignature: startAfter || undefined,
    upgradeSlot: optionalInt(env, "UPGRADE_SLOT"),
    listenerMaxBacklog,
    listenerNotFoundIncidentCycles: notFoundCycles,
    houseBankrollLamports: BigInt(houseExtra),
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
