/**
 * WRITE — deposit SOL into the shared pool vault.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=./keys/player.json \
 *   npx ts-node --compiler-options '{"module":"commonjs"}' scripts/deposit.ts 0.1
 */

import { BN } from "@coral-xyz/anchor";
import { LAMPORTS_PER_SOL, SystemProgram } from "@solana/web3.js";
import {
  derivePoolVaultPda,
  deriveVaultStatePda,
  lamportsToSol,
  loadProgram,
  loadProvider,
  sendWithRetry,
} from "./common";

async function main() {
  const solArg = process.argv[2];
  if (!solArg) {
    console.error("Usage: deposit.ts <amount_sol>");
    process.exit(1);
  }

  const amount = Math.round(parseFloat(solArg) * LAMPORTS_PER_SOL);
  if (!Number.isFinite(amount) || amount <= 0) {
    console.error("Amount must be a positive SOL value.");
    process.exit(1);
  }

  const provider = loadProvider();
  const program = loadProgram(provider);
  const depositor = provider.wallet.publicKey;
  const [vaultState] = deriveVaultStatePda(program.programId);
  const [poolVault] = derivePoolVaultPda(program.programId);

  console.log("depositing", lamportsToSol(amount), "SOL");
  console.log("depositor:", depositor.toBase58());

  const signature = await sendWithRetry(
    () =>
      program.methods
        .deposit(new BN(amount))
        .accountsPartial({
          depositor,
          vaultState,
          poolVault,
          systemProgram: SystemProgram.programId,
        })
        .rpc({ commitment: "confirmed", maxRetries: 5 }),
    "deposit",
  );

  const poolInfo = await provider.connection.getAccountInfo(poolVault);
  console.log("tx:           ", signature);
  console.log("pool balance: ", lamportsToSol(poolInfo?.lamports ?? 0), "SOL");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
