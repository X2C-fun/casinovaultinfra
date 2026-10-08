/**
 * WRITE — initialize the singleton vault and SET THE ADMIN KEY.
 *
 * Only the program's upgrade authority can run this, and only once. The
 * upgrade authority signs and pays rent; the admin co-signs to prove it
 * controls the key. Keep them separate: the upgrade authority should be cold
 * (or a multisig), the admin lives in your backend.
 *
 * Usage:
 *   # 1. Create the admin key (once)
 *   solana-keygen new -o keys/admin.json --no-bip39-passphrase
 *
 *   # 2. Initialize: ANCHOR_WALLET = upgrade authority, ADMIN_WALLET = admin
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=./wallet.json \
 *   ADMIN_WALLET=./keys/admin.json \
 *   npm run initialize
 *
 * If ADMIN_WALLET is omitted, the upgrade authority also becomes the admin
 * (acceptable for local testing only).
 */

import { SystemProgram } from "@solana/web3.js";
import {
  derivePoolVaultPda,
  deriveVaultStatePda,
  fetchUpgradeAuthority,
  lamportsToSol,
  loadKeypair,
  loadProgram,
  loadProvider,
  sendWithRetry,
} from "./common";

async function main() {
  const provider = loadProvider();
  const program = loadProgram(provider);
  const authority = provider.wallet.publicKey;
  const adminPath = process.env.ADMIN_WALLET;
  const adminKeypair = adminPath ? loadKeypair(adminPath) : null;
  const admin = adminKeypair?.publicKey ?? authority;

  const [vaultState] = deriveVaultStatePda(program.programId);
  const [poolVault, vaultBump] = derivePoolVaultPda(program.programId);

  console.log("cluster:    ", provider.connection.rpcEndpoint);
  console.log("program:    ", program.programId.toBase58());
  console.log("authority:  ", authority.toBase58());
  console.log("admin (set):", admin.toBase58());

  const onChainAuthority = await fetchUpgradeAuthority(
    provider.connection,
    program.programId,
  );
  if (!onChainAuthority) {
    console.error(
      "The program is immutable; it can no longer be initialized. Redeploy.",
    );
    process.exit(1);
  }
  if (!onChainAuthority.equals(authority)) {
    console.error("ANCHOR_WALLET is not the program's upgrade authority.");
    console.error("upgrade authority:", onChainAuthority.toBase58());
    process.exit(1);
  }

  const existing = await provider.connection.getAccountInfo(vaultState);
  if (existing) {
    const state = await program.account.vaultState.fetch(vaultState);
    console.error("Already initialized.");
    console.error("admin on-chain:", state.admin.toBase58());
    process.exit(1);
  }

  if (!adminKeypair) {
    console.warn(
      "WARNING: ADMIN_WALLET not set — the upgrade authority will also be the admin.",
    );
  }

  const poolBefore = await provider.connection.getBalance(poolVault);
  console.log("vault_state:", vaultState.toBase58());
  console.log("pool_vault: ", poolVault.toBase58(), `(bump ${vaultBump})`);
  if (poolBefore > 0) {
    console.log(
      "pool already holds",
      lamportsToSol(poolBefore),
      "SOL (prefunded or upgraded from v0.1); it is kept as is.",
    );
  }

  const signature = await sendWithRetry(
    () =>
      program.methods
        .initialize()
        .accountsPartial({
          authority,
          admin,
          vaultState,
          poolVault,
          systemProgram: SystemProgram.programId,
        })
        .signers(adminKeypair ? [adminKeypair] : [])
        .rpc({ commitment: "confirmed", maxRetries: 5 }),
    "initialize",
  );

  const state = await program.account.vaultState.fetch(vaultState);
  console.log("\nInitialized.");
  console.log("tx:         ", signature);
  console.log("admin:      ", state.admin.toBase58());
  console.log("vault_bump: ", state.vaultBump);
  console.log("paused:     ", state.paused);
  console.log("\nVerify with: npm run read");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
