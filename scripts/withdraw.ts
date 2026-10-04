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
import { Keypair, LAMPORTS_PER_SOL, SystemProgram } from "@solana/web3.js";
import {
  derivePoolVaultPda,
  deriveVaultStatePda,
  lamportsToSol,
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

  const amount = Math.round(parseFloat(solArg) * LAMPORTS_PER_SOL);
  if (!Number.isFinite(amount) || amount <= 0) {
    console.error("Amount must be a positive SOL value.");
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

  const builder = program.methods.withdraw(new BN(amount)).accountsPartial({
    user: user.publicKey,
    admin: admin.publicKey,
    vaultState,
    poolVault,
    systemProgram: SystemProgram.programId,
  });

  const signers = admin.publicKey.equals(user.publicKey)
    ? [user]
    : [user, admin];

  const signature = await sendWithRetry(
    () =>
      builder.signers(signers).rpc({ commitment: "confirmed", maxRetries: 5 }),
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
