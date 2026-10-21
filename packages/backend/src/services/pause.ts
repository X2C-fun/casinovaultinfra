import { Transaction } from "@solana/web3.js";
import { buildSetPausedIx } from "@x2c-fun/casinovault-sdk";
import type { ServiceContext } from "../context";

/**
 * Pauses the vault with the admin key. Called on an incident (an unmatched
 * WithdrawEvent) to stop further withdrawals immediately. Best-effort and
 * idempotent at the program level (pausing an already-paused vault is a no-op
 * beyond the event).
 */
export async function pauseVault(ctx: ServiceContext): Promise<string> {
  const ix = await buildSetPausedIx(ctx.program, {
    admin: ctx.admin.publicKey,
    paused: true,
  });
  const tx = new Transaction().add(ix);
  return ctx.program.provider.sendAndConfirm!(tx, [ctx.admin]);
}
