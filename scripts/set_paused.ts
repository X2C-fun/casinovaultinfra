/**
 * WRITE — pause or unpause deposits and withdrawals (admin only).
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=./keys/admin.json \
 *   npx ts-node --compiler-options '{"module":"commonjs"}' scripts/set_paused.ts true
 */

import {
  deriveVaultStatePda,
  loadProgram,
  loadProvider,
  sendWithRetry,
} from "./common";

async function main() {
  const flag = process.argv[2];
  if (flag !== "true" && flag !== "false") {
    console.error("Usage: set_paused.ts <true|false>");
    process.exit(1);
  }
  const paused = flag === "true";

  const provider = loadProvider();
  const program = loadProgram(provider);
  const admin = provider.wallet.publicKey;
  const [vaultState] = deriveVaultStatePda(program.programId);

  const state = await program.account.vaultState.fetch(vaultState);
  if (!state.admin.equals(admin)) {
    console.error("Unauthorized. On-chain admin:", state.admin.toBase58());
    process.exit(1);
  }

  const signature = await sendWithRetry(
    () =>
      program.methods
        .setPaused(paused)
        .accountsPartial({ admin, vaultState })
        .rpc({ commitment: "confirmed", maxRetries: 5 }),
    "set_paused",
  );

  const after = await program.account.vaultState.fetch(vaultState);
  console.log("tx:    ", signature);
  console.log("paused:", after.paused);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
