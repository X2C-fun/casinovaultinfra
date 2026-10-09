/**
 * WRITE — deposit SOL into the shared pool vault.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=./keys/player.json \
 *   npx ts-node --compiler-options '{"module":"commonjs"}' scripts/deposit.ts 0.1
 */

import { BN } from "@coral-xyz/anchor";
import { SystemProgram } from "@solana/web3.js";
import {
  derivePoolVaultPda,
  deriveVaultStatePda,
  lamportsToSol,
  solToLamports,
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

  let amount: bigint;
  try {
    amount = solToLamports(solArg);
  } catch (err) {
    console.error((err as Error).message);
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
    provider,
    () =>
      program.methods
        .deposit(new BN(amount.toString()))
        .accountsPartial({
          depositor,
          vaultState,
          poolVault,
          systemProgram: SystemProgram.programId,
        })
        .transaction(),
    [],
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
