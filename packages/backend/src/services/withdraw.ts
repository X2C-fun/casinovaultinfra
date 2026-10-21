import { PublicKey } from "@solana/web3.js";
import {
  buildWithdrawTransaction,
  fetchVaultState,
  getWithdrawable,
} from "@x2c-fun/casinovault-sdk";
import type { ServiceContext } from "../context";

export interface WithdrawRequest {
  /** Ledger owner whose balance is debited (usually the wallet string). */
  ownerKey: string;
  /** Wallet that receives the SOL. Must be the ledger owner's own wallet. */
  destination: string;
  amountLamports: bigint;
  /** House payout (admin pays itself): skips the user-balance hold. */
  house?: boolean;
}

export interface WithdrawApproval {
  requestId: string;
  /** base64 transaction: ComputeBudget (optional) + withdraw, admin-signed. */
  transactionBase64: string;
  lastValidBlockHeight: number;
  amountLamports: string;
}

/**
 * Approves a withdrawal following docs/backend-integration.md:
 * authenticate (caller's job), check caps, **place the hold (debit at
 * approval)**, build the exact transaction, and admin-partial-sign it. The user
 * signs and submits; settlement happens later from the finalized WithdrawEvent.
 */
export async function approveWithdrawal(
  ctx: ServiceContext,
  req: WithdrawRequest,
): Promise<WithdrawApproval> {
  const destination = new PublicKey(req.destination); // throws on a bad address
  if (req.amountLamports <= 0n) throw new Error("amount must be positive");

  const state = await fetchVaultState(ctx.program, ctx.config.programId);
  if (!state) throw new Error("vault is not initialized");
  if (state.paused) throw new Error("vault is paused");
  if (!state.admin.equals(ctx.admin.publicKey)) {
    throw new Error("loaded admin key is not the on-chain admin");
  }

  // Surface cap violations as a clear error instead of a failed transaction.
  if (state.maxWithdrawPerTx > 0n && req.amountLamports > state.maxWithdrawPerTx) {
    throw new Error(
      `amount exceeds per-transaction cap (${state.maxWithdrawPerTx} lamports)`,
    );
  }
  const withdrawable = await getWithdrawable(ctx.connection, ctx.config.programId);
  if (req.amountLamports > withdrawable) {
    throw new Error("pool has insufficient withdrawable balance");
  }

  const { blockhash, lastValidBlockHeight } =
    await ctx.connection.getLatestBlockhash("confirmed");

  // Debit at approval: move the balance to a hold BEFORE signing. A crash after
  // this commit leaves a hold the release sweep reclaims once it expires.
  const hold = req.house
    ? ctx.ledger.placeHouseHold({
        amount: req.amountLamports,
        destination: req.destination,
        lastValidBlockHeight,
      })
    : ctx.ledger.placeHold({
        ownerKey: req.ownerKey,
        amount: req.amountLamports,
        destination: req.destination,
        lastValidBlockHeight,
      });

  const tx = await buildWithdrawTransaction(ctx.program, {
    user: destination,
    admin: ctx.admin.publicKey,
    amountLamports: req.amountLamports,
    requestId: hold.requestId,
    computeUnitPriceMicroLamports: ctx.config.computeUnitPriceMicroLamports,
    computeUnitLimit: ctx.config.computeUnitLimit,
  });
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.partialSign(ctx.admin); // admin co-signs; the user signs + submits

  return {
    requestId: hold.requestId.toString(),
    transactionBase64: tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64"),
    lastValidBlockHeight,
    amountLamports: req.amountLamports.toString(),
  };
}
