import { loadConfig, requireAdminSecret } from "./config";
import { loadAdminKeypair, assertAdminMatchesOnChain } from "./admin";
import { createStorage } from "./storage";
import { buildContext } from "./context";
import { createApi } from "./server";
import { runListener } from "./listener/listener";

/**
 * Starts the reference backend: the HTTP API AND the settlement listener in one
 * process. Run the listener separately (`npm run listener`) if you prefer to
 * scale them independently.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const admin = loadAdminKeypair(requireAdminSecret());
  const storage = await createStorage(config);
  const ctx = buildContext(config, admin, storage.ledger);

  await assertAdminMatchesOnChain(ctx.connection, config.programId, admin.publicKey);
  console.log(
    `admin ${admin.publicKey.toBase58()} verified against on-chain vault`,
  );

  const server = createApi(ctx);
  server.listen(config.port, () => {
    console.log(`API listening on http://localhost:${config.port} (ledger: ${config.ledger})`);
  });

  // Run the settlement listener alongside the API.
  void runListener(ctx, storage.getCursor, storage.setCursor);

  const shutdown = () => {
    console.log("shutting down…");
    server.close();
    storage.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
