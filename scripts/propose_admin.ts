/**
 * WRITE — propose a new admin, or cancel a pending proposal (upgrade authority
 * only). The new admin takes over only after it runs `accept_admin.ts`.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=./wallet.json \
 *   npm run propose-admin -- <NEW_ADMIN_PUBKEY | none>
 */

import { PublicKey } from "@solana/web3.js";
import {
  deriveVaultStatePda,
  fetchUpgradeAuthority,
  loadProgram,
  loadProvider,
  sendWithRetry,
} from "./common";

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage: propose_admin.ts <NEW_ADMIN_PUBKEY | none>");
    process.exit(1);
  }

  let newAdmin: PublicKey | null;
  if (arg === "none") {
    newAdmin = null;
  } else {
    try {
      newAdmin = new PublicKey(arg);
    } catch {
      console.error(`"${arg}" is not a valid public key.`);
      process.exit(1);
    }
  }

  const provider = loadProvider();
  const program = loadProgram(provider);
  const authority = provider.wallet.publicKey;
  const [vaultState] = deriveVaultStatePda(program.programId);

  const upgradeAuthority = await fetchUpgradeAuthority(
    provider.connection,
    program.programId,
  );
  if (!upgradeAuthority?.equals(authority)) {
    console.error("ANCHOR_WALLET is not the program's upgrade authority.");
    console.error("upgrade authority:", upgradeAuthority?.toBase58() ?? "none");
    process.exit(1);
  }

  const before = await program.account.vaultState.fetch(vaultState);
  console.log("current admin:", before.admin.toBase58());
  console.log("proposing:    ", newAdmin?.toBase58() ?? "(cancel)");

  const signature = await sendWithRetry(
    () =>
      program.methods
        .proposeAdmin(newAdmin)
        .accountsPartial({ authority, vaultState })
        .rpc({ commitment: "confirmed", maxRetries: 5 }),
    "propose_admin",
  );

  const after = await program.account.vaultState.fetch(vaultState);
  console.log("tx:           ", signature);
  console.log("pending admin:", after.pendingAdmin?.toBase58() ?? "none");
  if (after.pendingAdmin) {
    console.log(
      "\nThe new admin must now run:\n  ANCHOR_WALLET=<new admin keypair> npm run accept-admin",
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
