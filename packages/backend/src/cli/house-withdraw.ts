import { loadConfig, requireAdminSecret } from "../config";
import { loadAdminKeypair, assertAdminMatchesOnChain, safeErrorMessage } from "../admin";
import { createStorage } from "../storage";
import { buildContext } from "../context";
import { prepareHouseWithdrawal } from "../services/withdraw";

/**
 * Operator CLI: withdraw `<lamports>` of the HOUSE bankroll to the admin
 * wallet.   npm run house-withdraw -- <lamports>
 *
 * This is the only way to make a house withdrawal; the HTTP API has none. The
 * ledger refuses any destination other than the admin key and any amount above
 * the tracked house bankroll, and registers the hold BEFORE signing so the
 * listener matches the WithdrawEvent. Run it against the listener's DB_PATH.
 */
async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg || !/^[1-9][0-9]{0,19}$/.test(arg)) {
    console.error("usage: npm run house-withdraw -- <lamports>");
    process.exit(64);
  }
  const amount = BigInt(arg);
  const config = loadConfig();
  const admin = loadAdminKeypair(requireAdminSecret());
  const storage = await createStorage(config, { adminKey: admin.publicKey.toBase58() });
  try {
    const ctx = buildContext(config, admin, storage.ledger);
    await assertAdminMatchesOnChain(ctx.connection, config.programId, admin.publicKey);

    const { hold, tx } = await prepareHouseWithdrawal(ctx, amount);
    // The admin is user, fee payer and admin: the transaction is fully signed.
    const signature = await ctx.connection.sendRawTransaction(tx.serialize(), {
      preflightCommitment: "confirmed",
    });
    console.log(`house withdrawal of ${amount} lamports, request_id ${hold.requestId}`);
    console.log(`submitted ${signature}; the listener settles it once finalized`);
    // If it never lands, the listener releases the hold back to the house
    // bankroll once it has expired.
  } finally {
    storage.close();
  }
}

main().catch((err) => {
  console.error("house-withdraw failed:", safeErrorMessage(err));
  process.exit(1);
});
