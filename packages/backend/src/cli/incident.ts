import { Connection } from "@solana/web3.js";
import { loadConfig } from "../config";
import { createStorage } from "../storage";
import { safeErrorMessage } from "../admin";
import { verifyLedgerBinding } from "../binding";
import { clearIncidentChecked, openMismatchedHolds } from "../services/incident";

/**
 * Operator CLI for the incident kill-switch.
 *
 *   npm run incident -- status          # show the switch and the incident log
 *   npm run incident -- clear           # MANUAL: re-enable approvals
 *   npm run incident -- clear --force   # ... even with mismatched holds open
 *
 * `status` opens DB_PATH read-only; `clear` opens it writable. Both fail if
 * the file does not exist (a mistyped DB_PATH must not create an empty ledger)
 * and refuse a ledger bound to another cluster / program.
 *
 * `clear` refuses while a hold named by a `WithdrawEvent mismatch` incident is
 * still open: once cleared, the listener would release it on expiry. Resolve
 * those holds first (or pass --force deliberately).
 *
 * Clearing only re-enables approvals in this backend. The vault stays paused
 * on chain until you unpause it yourself (root `npm run set-paused`) after the
 * investigation and a clean reconcile.
 */
async function main(): Promise<void> {
  const [cmd, ...flags] = process.argv.slice(2);
  const force = flags.includes("--force");
  if (
    (cmd !== "status" && cmd !== "clear") ||
    flags.some((f) => f !== "--force") ||
    (force && cmd !== "clear")
  ) {
    console.error("usage: npm run incident -- status | clear [--force]");
    process.exit(64);
  }
  const config = loadConfig();
  const storage = await createStorage(
    config,
    cmd === "status" ? { readOnly: true } : { mustExist: true },
  );
  try {
    const ledger = storage.ledger;
    const connection = new Connection(config.rpcUrl, { commitment: "finalized" });
    await verifyLedgerBinding(ledger, connection, config.programId, { readOnly: true });

    if (cmd === "clear") {
      const r = clearIncidentChecked(ledger, { force });
      if (r.kind === "refused") {
        console.error(
          `REFUSED: ${r.holds.length} hold(s) named by a WithdrawEvent mismatch are still open; ` +
            "clearing would let the listener release them on expiry. Resolve them, or re-run " +
            "with --force.",
        );
        for (const h of r.holds) {
          console.error(`  request_id ${h.requestId}  owner ${h.ownerKey}  amount ${h.amount}`);
        }
        process.exitCode = 3;
        return;
      }
      console.log(r.kind === "cleared" ? "incident cleared" : "no incident was open");
      return;
    }
    const incident = ledger.getIncident();
    console.log(
      incident
        ? `OPEN since ${new Date(incident.openedAt).toISOString()}: ${incident.reason}`
        : "no incident open",
    );
    for (const r of ledger.listIncidents()) {
      console.log(`${new Date(r.at).toISOString()}  ${r.reason}  ${r.detail}`);
    }
    const mismatched = openMismatchedHolds(ledger);
    if (mismatched.length > 0) {
      console.log(`open holds named by a WithdrawEvent mismatch: ${mismatched.length}`);
      for (const h of mismatched) {
        console.log(`  request_id ${h.requestId}  owner ${h.ownerKey}  amount ${h.amount}`);
      }
    }
  } finally {
    storage.close();
  }
}

main().catch((err) => {
  console.error("incident failed:", safeErrorMessage(err));
  process.exit(1);
});
