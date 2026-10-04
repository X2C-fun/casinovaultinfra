/**
 * READ — fetch on-chain vault state and pool balance.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=./keys/admin.json \
 *   npx ts-node --compiler-options '{"module":"commonjs"}' scripts/read.ts
 */

import {
  derivePoolVaultPda,
  deriveVaultStatePda,
  lamportsToSol,
  loadProgram,
  loadProvider,
} from "./common";

async function main() {
  const provider = loadProvider();
  const program = loadProgram(provider);
  const [vaultState] = deriveVaultStatePda(program.programId);
  const [poolVault] = derivePoolVaultPda(program.programId);

  console.log("cluster:", provider.connection.rpcEndpoint);
  console.log("program:", program.programId.toBase58());
  console.log("vault_state PDA:", vaultState.toBase58());
  console.log("pool_vault PDA:", poolVault.toBase58());

  const stateInfo = await provider.connection.getAccountInfo(vaultState);
  if (!stateInfo) {
    console.log("\nvault_state: NOT INITIALIZED");
    console.log("Run scripts/initialize.ts first to set the admin.");
    return;
  }

  const state = await program.account.vaultState.fetch(vaultState);
  const poolInfo = await provider.connection.getAccountInfo(poolVault);
  const poolLamports = poolInfo?.lamports ?? 0;
  const rentReserve =
    await provider.connection.getMinimumBalanceForRentExemption(0);
  const withdrawable = Math.max(0, poolLamports - rentReserve);

  console.log("\n--- VaultState ---");
  console.log("admin:     ", state.admin.toBase58());
  console.log("vault_bump:", state.vaultBump);
  console.log("paused:    ", state.paused);

  console.log("\n--- Pool Vault ---");
  console.log(
    "lamports:     ",
    poolLamports,
    `(${lamportsToSol(poolLamports)} SOL)`,
  );
  console.log(
    "rent_reserve: ",
    rentReserve,
    `(${lamportsToSol(rentReserve)} SOL)`,
  );
  console.log(
    "withdrawable: ",
    withdrawable,
    `(${lamportsToSol(withdrawable)} SOL)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
