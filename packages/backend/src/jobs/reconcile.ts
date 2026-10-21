import { reconcilePoolLive } from "@x2c-fun/casinovault-sdk";
import { loadConfig, requireAdminSecret } from "../config";
import { loadAdminKeypair } from "../admin";
import { createStorage } from "../storage";
import { buildContext } from "../context";

/**
 * One-shot reconciliation: checks the pool-solvency invariant
 *   pool balance === Σ player balances + house bankroll + rent reserve
 * against the live finalized pool balance. Exits non-zero on a shortfall so it
 * can gate a cron / alert.
 *
 * `houseBankroll` is read from HOUSE_BANKROLL_LAMPORTS (the house's own funds in
 * the pool). Player totals come from the ledger.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const admin = loadAdminKeypair(requireAdminSecret());
  const storage = await createStorage(config);
  const ctx = buildContext(config, admin, storage.ledger);

  const totals = storage.ledger.totals();
  const playerBalancesTotal = totals.available + totals.pending;
  const houseBankroll = BigInt(process.env.HOUSE_BANKROLL_LAMPORTS?.trim() || "0");

  const result = await reconcilePoolLive(ctx.connection, {
    playerBalancesTotal,
    houseBankroll,
    programId: config.programId,
  });

  console.log("pool balance :", result.poolBalance.toString());
  console.log("expected     :", result.expected.toString());
  console.log("difference   :", result.difference.toString());
  console.log("solvent      :", result.solvent);
  console.log("balanced     :", result.balanced);
  storage.close();

  if (!result.solvent) {
    console.error("INSOLVENT: pool cannot cover liabilities — investigate and pause.");
    process.exit(2);
  }
}

main().catch((err) => {
  console.error("reconcile fatal:", err);
  process.exit(1);
});
