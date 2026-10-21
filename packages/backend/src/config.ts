import { PublicKey } from "@solana/web3.js";
import { DEFAULT_PROGRAM_ID } from "@x2c-fun/casinovault-sdk";

/** Backend configuration, read once from the environment at startup. */
export interface Config {
  rpcUrl: string;
  programId: PublicKey;
  port: number;
  ledger: "memory" | "sqlite";
  dbPath: string;
  /** Optional priority fee added to withdraw transactions, micro-lamports/CU. */
  computeUnitPriceMicroLamports?: bigint;
  computeUnitLimit?: number;
}

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export function loadConfig(): Config {
  const programId = process.env.VAULT_PROGRAM_ID?.trim()
    ? new PublicKey(process.env.VAULT_PROGRAM_ID.trim())
    : DEFAULT_PROGRAM_ID;

  const ledger = (process.env.LEDGER?.trim() as Config["ledger"]) || "sqlite";
  if (ledger !== "memory" && ledger !== "sqlite") {
    throw new Error(`LEDGER must be "memory" or "sqlite", got "${ledger}"`);
  }

  const cuPrice = process.env.COMPUTE_UNIT_PRICE_MICRO_LAMPORTS?.trim();

  return {
    rpcUrl: process.env.RPC_URL?.trim() || "https://api.devnet.solana.com",
    programId,
    port: Number(process.env.PORT?.trim() || "8787"),
    ledger,
    dbPath: process.env.DB_PATH?.trim() || "casinovault.db",
    computeUnitPriceMicroLamports: cuPrice ? BigInt(cuPrice) : undefined,
    computeUnitLimit: process.env.COMPUTE_UNIT_LIMIT?.trim()
      ? Number(process.env.COMPUTE_UNIT_LIMIT.trim())
      : undefined,
  };
}

/** Ensures `ADMIN_SECRET_KEY` is present without printing it. */
export function requireAdminSecret(): string {
  return required("ADMIN_SECRET_KEY");
}
