/**
 * WRITE — initialize the singleton vault and SET THE ADMIN KEY.
 *
 * The wallet that signs `initialize` becomes `VaultState.admin` forever
 * (until a program upgrade adds rotation). Use a dedicated backend/admin
 * keypair — not a hot player wallet.
 *
 * Usage:
 *   # 1. Create admin key (once)
 *   solana-keygen new -o keys/admin.json --no-bip39-passphrase
 *
 *   # 2. Fund it on devnet
 *   solana airdrop 2 $(solana-keygen pubkey keys/admin.json) --url devnet
 *
 *   # 3. Initialize (sets admin = this wallet)
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=./keys/admin.json \
 *   npx ts-node --compiler-options '{"module":"commonjs"}' scripts/initialize.ts
 */

import { SystemProgram } from "@solana/web3.js";
import {
  derivePoolVaultPda,
  deriveVaultStatePda,
  loadProgram,
  loadProvider,
  sendWithRetry,
} from "./common";

async function main() {
  const provider = loadProvider();
  const program = loadProgram(provider);
  const admin = provider.wallet.publicKey;
  const [vaultState] = deriveVaultStatePda(program.programId);
  const [poolVault, vaultBump] = derivePoolVaultPda(program.programId);

  console.log("cluster:    ", provider.connection.rpcEndpoint);
  console.log("wallet:     ", admin.toBase58());

  const existing = await provider.connection.getAccountInfo(vaultState);
  if (existing) {
    const state = await program.account.vaultState.fetch(vaultState);
    console.error("Already initialized.");
    console.error("admin on-chain:", state.admin.toBase58());
    console.error("your wallet:   ", admin.toBase58());
    if (!state.admin.equals(admin)) {
      console.error(
        "WARNING: on-chain admin differs from this wallet. Do not deposit until this matches.",
      );
    }
    process.exit(1);
  }

  console.log("Initializing vault...");
  console.log("program:    ", program.programId.toBase58());
  console.log("admin (set):", admin.toBase58());
  console.log("vault_state:", vaultState.toBase58());
  console.log("pool_vault: ", poolVault.toBase58(), `(bump ${vaultBump})`);

  const signature = await sendWithRetry(
    () =>
      program.methods
        .initialize()
        .accountsPartial({
          admin,
          vaultState,
          poolVault,
          systemProgram: SystemProgram.programId,
        })
        .rpc({
          commitment: "confirmed",
          skipPreflight: false,
          maxRetries: 5,
        }),
    "initialize",
  );

  const state = await program.account.vaultState.fetch(vaultState);
  console.log("\nInitialized.");
  console.log("tx:         ", signature);
  console.log("admin:      ", state.admin.toBase58());
  console.log("vault_bump: ", state.vaultBump);
  console.log("paused:     ", state.paused);
  console.log(
    "\nVerify with:\n  ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=./keys/admin.json npm run read",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
