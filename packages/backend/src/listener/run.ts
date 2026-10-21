import { loadConfig, requireAdminSecret } from "../config";
import { loadAdminKeypair, assertAdminMatchesOnChain } from "../admin";
import { createStorage } from "../storage";
import { buildContext } from "../context";
import { runListener } from "./listener";

/** Runs only the settlement listener (no HTTP API). */
async function main(): Promise<void> {
  const config = loadConfig();
  const admin = loadAdminKeypair(requireAdminSecret());
  const storage = await createStorage(config);
  const ctx = buildContext(config, admin, storage.ledger);
  await assertAdminMatchesOnChain(ctx.connection, config.programId, admin.publicKey);
  await runListener(ctx, storage.getCursor, storage.setCursor);
}

main().catch((err) => {
  console.error("listener fatal:", err);
  process.exit(1);
});
