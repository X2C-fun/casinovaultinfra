import { loadApiAuthConfig, loadConfig, requireAdminSecret } from "./config";
import { loadAdminKeypair, assertAdminMatchesOnChain, safeErrorMessage } from "./admin";
import { createStorage } from "./storage";
import { buildContext } from "./context";
import { createApi } from "./server";
import { verifyLedgerBinding } from "./binding";
import { listenerDepsFromContext, runListener } from "./listener/listener";

/**
 * Starts the reference backend.
 *
 *   npm run start     → HTTP API + settlement listener in one process
 *   npm run api       → HTTP API only (run `npm run listener` separately)
 *   npm run listener  → listener only (src/listener/run.ts)
 *
 * Run exactly ONE listener per ledger: the listener takes a lease row in the
 * ledger and a second one refuses to start. All processes share DB_PATH.
 */
export async function startBackend(opts: { withListener: boolean }): Promise<void> {
  const config = loadConfig();
  const auth = loadApiAuthConfig();
  const admin = loadAdminKeypair(requireAdminSecret());
  const storage = await createStorage(config, { adminKey: admin.publicKey.toBase58() });
  const ctx = buildContext(config, admin, storage.ledger);

  // Refuse a ledger bound to another cluster / program (binds it on first run).
  await verifyLedgerBinding(storage.ledger, ctx.connection, config.programId);
  await assertAdminMatchesOnChain(ctx.connection, config.programId, admin.publicKey);
  console.log(`admin ${admin.publicKey.toBase58()} verified against on-chain vault`);
  if (!auth.apiToken) {
    console.warn(
      "WARNING: API is UNAUTHENTICATED (ALLOW_UNAUTHENTICATED=true) - local development only",
    );
  }

  const deps = opts.withListener ? listenerDepsFromContext(ctx) : undefined;

  const server = createApi(ctx, auth);
  server.listen(config.port, config.host, () => {
    console.log(
      `API listening on http://${config.host}:${config.port} (ledger: ${config.ledger}` +
        `${deps ? ", with listener" : ", API only"})`,
    );
  });

  if (deps) {
    runListener(deps).catch((err) => {
      console.error("listener fatal:", safeErrorMessage(err));
      process.exit(1);
    });
  }

  const shutdown = () => {
    console.log("shutting down");
    server.close();
    if (deps?.leaseHolder) storage.ledger.releaseListenerLease(deps.leaseHolder);
    storage.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
