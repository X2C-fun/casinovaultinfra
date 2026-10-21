import { loadConfig, requireAdminSecret } from "../config";
import { loadAdminKeypair, assertAdminMatchesOnChain, safeErrorMessage } from "../admin";
import { createStorage } from "../storage";
import { buildContext } from "../context";
import { listenerDepsFromContext, runListener } from "./listener";

/**
 * Runs only the settlement listener (no HTTP API) — pair it with `npm run api`,
 * not `npm run start` (which runs its own listener). Shares DB_PATH with the
 * API; a second listener on the same ledger refuses to start (lease row).
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const admin = loadAdminKeypair(requireAdminSecret());
  const storage = await createStorage(config, { adminKey: admin.publicKey.toBase58() });
  const ctx = buildContext(config, admin, storage.ledger);
  await assertAdminMatchesOnChain(ctx.connection, config.programId, admin.publicKey);
  const deps = listenerDepsFromContext(ctx);

  const shutdown = () => {
    if (deps.leaseHolder) storage.ledger.releaseListenerLease(deps.leaseHolder);
    storage.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await runListener(deps);
}

main().catch((err) => {
  console.error("listener fatal:", safeErrorMessage(err));
  process.exit(1);
});
