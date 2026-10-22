import { Connection, PublicKey } from "@solana/web3.js";
import { DEFAULT_PROGRAM_ID } from "./constants";
import { getPoolBalance } from "./reads";

/**
 * Result of checking the pool-solvency invariant:
 *
 *   pool balance === Σ(player balances) + house bankroll + rent reserve
 *
 * `solvent` is true when the pool holds at least what it owes. `difference` is
 * `actual - expected`: positive means a surplus (unattributed SOL in the pool,
 * e.g. a plain transfer in, which must never be credited), negative means a
 * shortfall (the pool cannot cover its liabilities — an incident).
 */
export interface ReconcileResult {
  /** Lamports actually in the pool vault (rent reserve included). */
  poolBalance: bigint;
  /** Lamports the ledger says should be there. */
  expected: bigint;
  /** `poolBalance - expected`. */
  difference: bigint;
  /** True when `poolBalance >= expected`. */
  solvent: boolean;
  /** True when the pool matches the ledger exactly. */
  balanced: boolean;
}

/**
 * Reconciles a known pool balance against the ledger totals. Pure and
 * synchronous so it is trivial to unit-test and to run inside a job.
 *
 * - `playerBalancesTotal`: sum of every player's off-chain available +
 *   pending-withdrawal balance, in lamports.
 * - `houseBankroll`: the house's own lamports in the pool, in lamports.
 * - `rentReserve`: the rent-exempt minimum parked in the pool to keep it alive
 *   (`getMinimumBalanceForRentExemption(0)`).
 */
export function reconcilePool(params: {
  poolBalance: bigint;
  playerBalancesTotal: bigint;
  houseBankroll: bigint;
  rentReserve: bigint;
}): ReconcileResult {
  const expected =
    params.playerBalancesTotal + params.houseBankroll + params.rentReserve;
  const difference = params.poolBalance - expected;
  return {
    poolBalance: params.poolBalance,
    expected,
    difference,
    solvent: difference >= 0n,
    balanced: difference === 0n,
  };
}

/**
 * Fetches the live pool balance and reconciles it against the ledger totals.
 * Convenience wrapper over {@link reconcilePool}; pass `commitment: "finalized"`
 * via the connection for an authoritative check.
 */
export async function reconcilePoolLive(
  connection: Connection,
  params: {
    playerBalancesTotal: bigint;
    houseBankroll: bigint;
    programId?: PublicKey;
  },
): Promise<ReconcileResult> {
  const programId = params.programId ?? DEFAULT_PROGRAM_ID;
  const [poolBalance, rent] = await Promise.all([
    getPoolBalance(connection, programId),
    connection.getMinimumBalanceForRentExemption(0),
  ]);
  return reconcilePool({
    poolBalance,
    playerBalancesTotal: params.playerBalancesTotal,
    houseBankroll: params.houseBankroll,
    rentReserve: BigInt(rent),
  });
}
