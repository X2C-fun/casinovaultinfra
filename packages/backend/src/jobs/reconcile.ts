import { Connection } from "@solana/web3.js";
import { fetchVaultState, getReadonlyProgram } from "@x2c-fun/casinovault-sdk";
import { checkPoolSolvency, ledgerLiabilities } from "../services/solvency";
import { loadConfig } from "../config";
import { createStorage } from "../storage";
import { safeErrorMessage } from "../admin";
import { verifyLedgerBinding } from "../binding";

/**
 * One-shot reconciliation: checks the pool-solvency invariant
 *   pool balance === Σ player balances + house bankroll + rent reserve
 * against the FINALIZED pool balance (the ledger is built from finalized
 * events, so both sides are read at the same commitment). Exits non-zero on a
 * shortfall so it can gate a cron / alert.
 *
 * Does NOT load ADMIN_SECRET_KEY. It only reads the ledger the API and
 * listener share (same DB_PATH).
 *
 * House bankroll = the ledger's tracked house balance (admin-wallet deposits
 * minus settled house withdrawals; open house holds are still in the pool)
 * + optional HOUSE_BANKROLL_LAMPORTS for house funds the ledger cannot see
 * (e.g. seeded by a plain System transfer, which emits no DepositEvent).
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const connection = new Connection(config.rpcUrl, { commitment: "finalized" });
  // Read-only, and the file must already exist: a wrong DB_PATH must fail,
  // not silently create an empty ledger that "reconciles" to zero liabilities.
  const storage = await createStorage(config, { readOnly: true });
  try {
    // Compare only (read-only DB): refuse a ledger from another cluster/program.
    await verifyLedgerBinding(storage.ledger, connection, config.programId, { readOnly: true });
    // Same math as the listener's release gate (src/services/solvency.ts).
    const extra = config.houseBankrollLamports ?? 0n;
    const { playerBalancesTotal, houseBankroll } = ledgerLiabilities(storage.ledger, extra);
    const result = await checkPoolSolvency(connection, storage.ledger, config.programId, {
      extraHouseLamports: extra,
    });
    const state = await fetchVaultState(
      getReadonlyProgram(connection, config.programId),
      config.programId,
    );

    console.log("pool balance :", result.poolBalance.toString());
    console.log("players      :", playerBalancesTotal.toString());
    console.log("house        :", houseBankroll.toString());
    console.log("expected     :", result.expected.toString());
    console.log("difference   :", result.difference.toString());
    console.log("solvent      :", result.solvent);
    console.log("balanced     :", result.balanced);
    console.log("vault paused :", state?.paused ?? "not initialized");
    const progress = storage.ledger.getProgress();
    const openHolds = storage.ledger.listOpenHolds();
    console.log("listener slot:", progress.slot ?? "none (listener has not run)");
    console.log("open holds   :", openHolds.length);
    const incident = storage.ledger.getIncident();
    if (incident) console.log("INCIDENT OPEN:", incident.reason);

    if (!result.solvent) {
      console.error(
        "INSOLVENT: pool cannot cover liabilities - investigate and pause.\n" +
          "  If the listener is behind the chain (listener slot above is old, or holds are " +
          "unsettled), this may be transient: finalized withdrawals not yet applied make the " +
          "ledger overstate liabilities. Re-run after the listener catches up before acting.",
      );
      process.exitCode = 2;
    }
  } finally {
    storage.close();
  }
}

main().catch((err) => {
  console.error("reconcile fatal:", safeErrorMessage(err));
  process.exit(1);
});
