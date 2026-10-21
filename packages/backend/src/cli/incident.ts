import { loadConfig } from "../config";
import { createStorage } from "../storage";
import { safeErrorMessage } from "../admin";

/**
 * Operator CLI for the incident kill-switch.
 *
 *   npm run incident -- status   # show the switch and the incident log
 *   npm run incident -- clear    # MANUAL: re-enable approvals
 *
 * Clearing only re-enables approvals in this backend. The vault stays paused
 * on chain until you unpause it yourself (root `npm run set-paused`) after the
 * investigation and a clean reconcile.
 */
async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd !== "status" && cmd !== "clear") {
    console.error("usage: npm run incident -- status|clear");
    process.exit(64);
  }
  const storage = await createStorage(loadConfig());
  try {
    const ledger = storage.ledger;
    if (cmd === "clear") {
      console.log(ledger.clearIncident() ? "incident cleared" : "no incident was open");
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
  } finally {
    storage.close();
  }
}

main().catch((err) => {
  console.error("incident failed:", safeErrorMessage(err));
  process.exit(1);
});
