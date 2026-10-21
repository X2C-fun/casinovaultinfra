import { Transaction } from "@solana/web3.js";
import { buildSetPausedIx, fetchVaultState } from "@x2c-fun/casinovault-sdk";
import type { ServiceContext } from "../context";

/**
 * Pauses the vault with the admin key. Called on an incident (an unmatched
 * WithdrawEvent) to stop further withdrawals on chain. The durable local
 * kill-switch (`ledger.openIncident`) is always set BEFORE this is attempted,
 * and the listener retries this every cycle until the vault reads paused.
 */
export async function pauseVault(ctx: ServiceContext): Promise<string> {
  const ix = await buildSetPausedIx(ctx.program, {
    admin: ctx.admin.publicKey,
    paused: true,
  });
  const tx = new Transaction().add(ix);
  return ctx.program.provider.sendAndConfirm!(tx, [ctx.admin]);
}

/** Whether the vault currently reads paused (confirmed commitment). */
export async function isVaultPaused(ctx: ServiceContext): Promise<boolean> {
  const state = await fetchVaultState(ctx.program, ctx.config.programId);
  return state?.paused ?? false;
}
