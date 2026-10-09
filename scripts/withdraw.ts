/**
 * WRITE — withdraw SOL from the pool (requires user + admin signatures).
 *
 * The admin wallet must match `VaultState.admin`. For a real product the
 * backend holds the admin key and co-signs after off-chain balance checks.
 *
 * Usage (same wallet as admin AND recipient — house withdraw):
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=./keys/admin.json \
 *   npx ts-node --compiler-options '{"module":"commonjs"}' scripts/withdraw.ts 0.05
 *
 * Usage (player recipient, admin co-sign):
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=./keys/player.json \
 *   ADMIN_WALLET=./keys/admin.json \
 *   npx ts-node --compiler-options '{"module":"commonjs"}' scripts/withdraw.ts 0.05
 */

import * as fs from "fs";
import { BN } from "@coral-xyz/anchor";
import { Keypair, SystemProgram } from "@solana/web3.js";
import {
  derivePoolVaultPda,
  deriveVaultStatePda,
  lamportsToSol,
  solToLamports,
  loadProgram,
  loadProvider,
  sendWithRetry,
} from "./common";

function loadKeypair(path: string): Keypair {
  const secret = JSON.parse(fs.readFileSync(path, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

async function main() {
  const solArg = process.argv[2];
  if (!solArg) {
    console.error("Usage: withdraw.ts <amount_sol>");
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
  const user = (provider.wallet as any).payer as Keypair;
  const adminPath = process.env.ADMIN_WALLET;
  const admin = adminPath ? loadKeypair(adminPath) : user;

  const [vaultState] = deriveVaultStatePda(program.programId);
  const [poolVault] = derivePoolVaultPda(program.programId);

  const state = await program.account.vaultState.fetch(vaultState);
  if (!state.admin.equals(admin.publicKey)) {
    console.error("Admin mismatch.");
    console.error("on-chain admin:", state.admin.toBase58());
    console.error("signing admin: ", admin.publicKey.toBase58());
    process.exit(1);
  }

  console.log("withdrawing", lamportsToSol(amount), "SOL");
  console.log("user: ", user.publicKey.toBase58());
  console.log("admin:", admin.publicKey.toBase58());

  const builder = program.methods
    .withdraw(new BN(amount.toString()))
    .accountsPartial({
      user: user.publicKey,
      admin: admin.publicKey,
      vaultState,
      poolVault,
      systemProgram: SystemProgram.programId,
    });

  // The provider wallet (the user) signs and pays; the admin co-signs. The
  // transaction is signed once and only ever re-sent byte-for-byte, so a
  // timeout can never turn into a second payout.
  const signature = await sendWithRetry(
    provider,
    () => builder.transaction(),
    [admin],
    "withdraw",
  );

  const poolInfo = await provider.connection.getAccountInfo(poolVault);
  console.log("tx:           ", signature);
  console.log("pool balance: ", lamportsToSol(poolInfo?.lamports ?? 0), "SOL");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
