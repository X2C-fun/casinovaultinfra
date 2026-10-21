import { PublicKey, type Transaction } from "@solana/web3.js";
import {
  buildWithdrawTransaction,
  fetchVaultState,
  getWithdrawable,
} from "@x2c-fun/casinovault-sdk";
import type { ServiceContext } from "../context";
import {
  DestinationMismatchError,
  IncidentOpenError,
  InsufficientFundsError,
  U64_MAX,
  type Hold,
} from "../ledger/types";

/**
 * A player withdrawal request. `ownerKey` MUST come from your authenticated
 * session (the player's wallet), never from the request body; the payout goes
 * to that same wallet (deposits are credited to the depositor's wallet, so the
 * ledger owner key IS the wallet).
 */
export interface WithdrawRequest {
  ownerKey: string;
  /** Optional; if given it must equal `ownerKey`. */
  destination?: string;
  amountLamports: bigint;
}

export interface WithdrawApproval {
  requestId: string;
  /** base64 transaction: ComputeBudget (optional) + withdraw, admin-signed. */
  transactionBase64: string;
  lastValidBlockHeight: number;
  amountLamports: string;
}

/**
 * An approval refusal that is safe to show the caller (`code` + `message`
 * carry no internals). Anything else is logged server-side and surfaced as a
 * generic error.
 */
export class ApprovalError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApprovalError";
  }
}

interface PreparedWithdrawal {
  hold: Hold;
  tx: Transaction;
  lastValidBlockHeight: number;
}

async function prepare(
  ctx: ServiceContext,
  p: { destination: PublicKey; amount: bigint; place: (lvbh: number) => Hold },
): Promise<PreparedWithdrawal> {
  // Kill-switch first: no RPC, no hold, nothing signed while an incident is open.
  if (ctx.ledger.getIncident()) {
    throw new ApprovalError("withdrawals_blocked", 503, "withdrawals are temporarily unavailable");
  }
  if (p.amount <= 0n || p.amount > U64_MAX) {
    throw new ApprovalError("invalid_amount", 400, "invalid amount");
  }

  const state = await fetchVaultState(ctx.program, ctx.config.programId);
  if (!state) throw new Error("vault is not initialized");
  if (state.paused) {
    throw new ApprovalError("vault_paused", 503, "withdrawals are temporarily unavailable");
  }
  if (!state.admin.equals(ctx.admin.publicKey)) {
    throw new Error("loaded admin key is not the on-chain admin");
  }

  // Surface cap violations as a clear error instead of a failed transaction.
  if (state.maxWithdrawPerTx > 0n && p.amount > state.maxWithdrawPerTx) {
    throw new ApprovalError("over_tx_cap", 409, "amount exceeds the per-transaction limit");
  }
  if (state.maxWithdrawPerWindow > 0n) {
    // Mirrors VaultState::record_withdrawal (tumbling window). Uses the local
    // clock; the program re-checks with the cluster clock.
    const now = BigInt(Math.floor(Date.now() / 1000));
    const windowEnd = state.windowStart + BigInt(state.windowSeconds);
    const remaining =
      now >= windowEnd
        ? state.maxWithdrawPerWindow
        : state.maxWithdrawPerWindow - state.windowWithdrawn;
    if (p.amount > remaining) {
      throw new ApprovalError("over_window_cap", 409, "amount exceeds the current withdrawal window limit");
    }
  }
  const withdrawable = await getWithdrawable(ctx.connection, ctx.config.programId);
  if (p.amount > withdrawable) {
    throw new ApprovalError("pool_insufficient", 503, "withdrawals are temporarily unavailable");
  }
  // A payout to an empty account must leave it rent-exempt or it fails.
  const [rentMin, destBalance] = await Promise.all([
    ctx.connection.getMinimumBalanceForRentExemption(0),
    ctx.connection.getBalance(p.destination, "confirmed"),
  ]);
  if (destBalance === 0 && p.amount < BigInt(rentMin)) {
    throw new ApprovalError(
      "below_rent_exempt",
      400,
      `amount must be at least ${rentMin} lamports for an empty wallet`,
    );
  }

  const { blockhash, lastValidBlockHeight } =
    await ctx.connection.getLatestBlockhash("confirmed");

  // Debit at approval: move the balance to a hold BEFORE signing. A crash after
  // this commit leaves a hold the release sweep reclaims once it expires.
  let hold: Hold;
  try {
    hold = p.place(lastValidBlockHeight);
  } catch (err) {
    if (err instanceof InsufficientFundsError) {
      throw new ApprovalError("insufficient_funds", 409, "insufficient balance");
    }
    if (err instanceof IncidentOpenError) {
      throw new ApprovalError("withdrawals_blocked", 503, "withdrawals are temporarily unavailable");
    }
    if (err instanceof DestinationMismatchError) {
      throw new ApprovalError("destination_mismatch", 400, "destination must be your own wallet");
    }
    throw err;
  }

  try {
    const tx = await buildWithdrawTransaction(ctx.program, {
      user: p.destination,
      admin: ctx.admin.publicKey,
      amountLamports: p.amount,
      requestId: hold.requestId,
      computeUnitPriceMicroLamports: ctx.config.computeUnitPriceMicroLamports,
      computeUnitLimit: ctx.config.computeUnitLimit,
    });
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.partialSign(ctx.admin); // admin co-signs; the user signs + submits
    // The listener (same process) may have opened an incident while we were
    // awaiting the build. Re-check AFTER signing and BEFORE the signed tx
    // leaves this function: it is only a local object until returned.
    if (ctx.ledger.getIncident()) {
      throw new ApprovalError("withdrawals_blocked", 503, "withdrawals are temporarily unavailable");
    }
    return { hold, tx, lastValidBlockHeight };
  } catch (err) {
    // Nothing signed left this process, so the transaction can never land:
    // return the funds now instead of waiting for expiry.
    ctx.ledger.releaseHold(hold.requestId);
    throw err;
  }
}

/**
 * Approves a player withdrawal following docs/backend-integration.md: check
 * the kill-switch and caps, **place the hold (debit at approval)**, build the
 * exact transaction, and admin-partial-sign it. The user signs and submits;
 * settlement happens later from the finalized WithdrawEvent.
 *
 * There is deliberately no house option here: house withdrawals go through the
 * operator CLI (`npm run house-withdraw`), never the HTTP API.
 */
export async function approveWithdrawal(
  ctx: ServiceContext,
  req: WithdrawRequest,
): Promise<WithdrawApproval> {
  if (ctx.ledger.getIncident()) {
    throw new ApprovalError("withdrawals_blocked", 503, "withdrawals are temporarily unavailable");
  }
  let owner: PublicKey;
  try {
    owner = new PublicKey(req.ownerKey);
  } catch {
    throw new ApprovalError("invalid_owner", 400, "invalid owner");
  }
  if (owner.toBase58() !== req.ownerKey) {
    throw new ApprovalError("invalid_owner", 400, "invalid owner");
  }
  if (req.destination !== undefined && req.destination !== req.ownerKey) {
    throw new ApprovalError("destination_mismatch", 400, "destination must be your own wallet");
  }

  const { hold, tx, lastValidBlockHeight } = await prepare(ctx, {
    destination: owner,
    amount: req.amountLamports,
    place: (lastValidBlockHeight) =>
      ctx.ledger.placeHold({
        ownerKey: req.ownerKey,
        amount: req.amountLamports,
        destination: req.ownerKey,
        lastValidBlockHeight,
      }),
  });

  return {
    requestId: hold.requestId.toString(),
    transactionBase64: tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64"),
    lastValidBlockHeight,
    amountLamports: req.amountLamports.toString(),
  };
}

/**
 * Operator-only house withdrawal: the admin pays ITSELF from the tracked house
 * bankroll. The ledger registers it (and refuses any destination other than
 * the admin key) before signing, so the listener matches its WithdrawEvent
 * instead of raising an incident. Returns the admin-signed transaction; the
 * admin is also the fee payer, so it is fully signed.
 */
export async function prepareHouseWithdrawal(
  ctx: ServiceContext,
  amountLamports: bigint,
): Promise<PreparedWithdrawal> {
  const admin = ctx.admin.publicKey;
  return prepare(ctx, {
    destination: admin,
    amount: amountLamports,
    place: (lastValidBlockHeight) =>
      ctx.ledger.placeHouseHold({
        amount: amountLamports,
        destination: admin.toBase58(),
        lastValidBlockHeight,
      }),
  });
}
