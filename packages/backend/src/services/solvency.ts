import type { Finality, PublicKey } from "@solana/web3.js";
import { derivePoolVaultPda, reconcilePool, type ReconcileResult } from "@x2c-fun/casinovault-sdk";
import type { Ledger } from "../ledger/types";

/**
 * What the pool owes according to the ledger, split the way the SDK's
 * `reconcilePool` expects. Shared by `npm run reconcile` and the listener's
 * release gate so both use the same math:
 *
 * - players: Σ available + Σ pending (open player holds are still in the pool)
 * - house:   tracked house bankroll (available + pending: open house holds are
 *            still in the pool) + `extraHouseLamports` (HOUSE_BANKROLL_LAMPORTS:
 *            house funds the ledger cannot see, e.g. seeded by a plain transfer)
 */
export function ledgerLiabilities(
  ledger: Ledger,
  extraHouseLamports = 0n,
): { playerBalancesTotal: bigint; houseBankroll: bigint } {
  const totals = ledger.totals();
  const house = ledger.houseBalance();
  return {
    playerBalancesTotal: totals.available + totals.pending,
    houseBankroll: house.available + house.pending + extraHouseLamports,
  };
}

/** The subset of `Connection` the solvency check uses. */
export interface SolvencyConnection {
  getBalance(
    address: PublicKey,
    config?: { commitment?: Finality; minContextSlot?: number },
  ): Promise<number>;
  getMinimumBalanceForRentExemption(dataLength: number): Promise<number>;
}

/**
 * Reads the pool PDA's balance at `finalized` (with `minContextSlot`, so a
 * lagging node errors instead of answering) and reconciles it against the
 * ledger: `pool >= players + house + rent reserve` (SDK `reconcilePool`).
 */
export async function checkPoolSolvency(
  connection: SolvencyConnection,
  ledger: Ledger,
  programId: PublicKey,
  opts: { extraHouseLamports?: bigint; minContextSlot?: number } = {},
): Promise<ReconcileResult> {
  const [pool] = derivePoolVaultPda(programId);
  const [balance, rent] = await Promise.all([
    connection.getBalance(pool, { commitment: "finalized", minContextSlot: opts.minContextSlot }),
    connection.getMinimumBalanceForRentExemption(0),
  ]);
  return reconcilePool({
    poolBalance: BigInt(balance),
    ...ledgerLiabilities(ledger, opts.extraHouseLamports ?? 0n),
    rentReserve: BigInt(rent),
  });
}
