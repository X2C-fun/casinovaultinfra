import type { PublicKey } from "@solana/web3.js";
import type { Ledger } from "./ledger/types";

/** The ledger belongs to another cluster or program than this process is configured for. */
export class LedgerBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerBindingError";
  }
}

/** The subset of `Connection` the binding check uses. */
export interface GenesisSource {
  getGenesisHash(): Promise<string>;
}

/**
 * Binds a ledger to ONE cluster and ONE vault program, and refuses to run on a
 * mismatch. Without it, pointing RPC_URL at another cluster (devnet vs a local
 * validator vs mainnet) or VAULT_PROGRAM_ID at another deployment would make
 * the listener read a foreign history against these balances (cursor not
 * found at best, foreign deposits credited at worst) and the API approve
 * withdrawals against the wrong vault.
 *
 * - First open of a writable ledger: stores `getGenesisHash()` + program id.
 * - Every later open: compares and throws {@link LedgerBindingError} on any
 *   difference.
 * - `readOnly` (reconcile, incident CLI): compares when a binding exists but
 *   never writes one.
 *
 * Call it in every process before it reads or writes balances.
 */
export async function verifyLedgerBinding(
  ledger: Ledger,
  connection: GenesisSource,
  programId: PublicKey,
  opts: { readOnly?: boolean } = {},
): Promise<"bound" | "verified" | "unbound"> {
  const genesisHash = await connection.getGenesisHash();
  const program = programId.toBase58();
  const stored = ledger.getChainBinding();
  if (stored === null) {
    if (opts.readOnly) return "unbound";
    ledger.setChainBinding({ genesisHash, programId: program });
    return "bound";
  }
  if (stored.genesisHash !== genesisHash) {
    throw new LedgerBindingError(
      `ledger (DB_PATH) belongs to the cluster with genesis hash ${stored.genesisHash}, but RPC_URL ` +
        `serves genesis hash ${genesisHash}: wrong cluster or wrong DB_PATH; refusing to run`,
    );
  }
  if (stored.programId !== program) {
    throw new LedgerBindingError(
      `ledger (DB_PATH) belongs to vault program ${stored.programId}, but VAULT_PROGRAM_ID is ` +
        `${program}: wrong deployment or wrong DB_PATH; refusing to run`,
    );
  }
  return "verified";
}
