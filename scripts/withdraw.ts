/**
 * WRITE — withdraw SOL from the pool (requires user + admin signatures).
 *
 * The admin wallet must match `VaultState.admin`. For a real product the
 * backend holds the admin key, places a hold on the user's balance, and passes
 * that hold's ID as `request_id` so the `WithdrawEvent` can settle it.
 *
 * Usage (same wallet as admin AND recipient — house withdraw):
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=./keys/admin.json \
 *   npm run withdraw -- 0.05 [request_id]
 *
 * Usage (player recipient, admin co-sign):
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=./keys/player.json \
 *   ADMIN_WALLET=./keys/admin.json \
 *   npm run withdraw -- 0.05 [request_id]
 *
 * `request_id` defaults to the current Unix time in milliseconds.
 */

import { BN } from "@coral-xyz/anchor";
import { Keypair, SystemProgram } from "@solana/web3.js";
import {
  derivePoolVaultPda,
  deriveVaultStatePda,
  lamportsToSol,
  loadKeypair,
  loadProgram,
  loadProvider,
  parseU64,
  sendWithRetry,
  solToLamports,
} from "./common";

async function main() {
  const [solArg, requestIdArg] = process.argv.slice(2);
  if (!solArg) {
    console.error("Usage: withdraw.ts <amount_sol> [request_id]");
    process.exit(1);
  }

  const amount = solToLamports(solArg);
  const requestId = requestIdArg
    ? parseU64(requestIdArg, "request_id")
    : BigInt(Date.now());

  const provider = loadProvider();
  const program = loadProgram(provider);
  const user = (provider.wallet as unknown as { payer: Keypair }).payer;
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
  const perTx = BigInt(state.maxWithdrawPerTx.toString());
  if (perTx > BigInt(0) && amount > perTx) {
    console.error(
      `Amount exceeds the per-transaction cap of ${lamportsToSol(perTx)} SOL.`,
    );
    process.exit(1);
  }

  console.log("withdrawing", lamportsToSol(amount), "SOL");
  console.log("user:       ", user.publicKey.toBase58());
  console.log("admin:      ", admin.publicKey.toBase58());
  console.log("request_id: ", requestId.toString());

  const builder = program.methods
    .withdraw(new BN(amount.toString()), new BN(requestId.toString()))
    .accountsPartial({
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
