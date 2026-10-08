/**
 * WRITE — accept a pending admin proposal. Signed by the proposed admin.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=./keys/new-admin.json \
 *   npm run accept-admin
 */

import {
  deriveVaultStatePda,
  loadProgram,
  loadProvider,
  sendWithRetry,
} from "./common";

async function main() {
  const provider = loadProvider();
  const program = loadProgram(provider);
  const newAdmin = provider.wallet.publicKey;
  const [vaultState] = deriveVaultStatePda(program.programId);

  const state = await program.account.vaultState.fetch(vaultState);
  if (!state.pendingAdmin?.equals(newAdmin)) {
    console.error("This wallet is not the pending admin.");
    console.error("pending admin:", state.pendingAdmin?.toBase58() ?? "none");
    console.error("your wallet:  ", newAdmin.toBase58());
    process.exit(1);
  }

  if ((await provider.connection.getBalance(newAdmin)) === 0) {
    console.error(
      "This wallet has no SOL to pay the transaction fee. Fund it first.",
    );
    process.exit(1);
  }

  const signature = await sendWithRetry(
    () =>
      program.methods
        .acceptAdmin()
        .accountsPartial({ newAdmin, vaultState })
        .rpc({ commitment: "confirmed", maxRetries: 5 }),
    "accept_admin",
  );

  const after = await program.account.vaultState.fetch(vaultState);
  console.log("tx:   ", signature);
  console.log("admin:", after.admin.toBase58());
  console.log(
    "\nUpdate ADMIN_SECRET_KEY in every backend to this key before resuming withdrawals.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
