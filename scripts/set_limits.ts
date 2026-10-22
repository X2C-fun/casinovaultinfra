/**
 * WRITE — set on-chain withdrawal caps (upgrade authority only).
 *
 * Amounts are in SOL; `0` disables a cap. The window cap and window length
 * must be both zero or both non-zero. Setting limits restarts the window.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=./wallet.json \
 *   npm run set-limits -- <max_per_tx_sol> <max_per_window_sol> <window_seconds>
 *
 * Example — at most 5 SOL per withdrawal and 50 SOL per hour:
 *   npm run set-limits -- 5 50 3600
 */

import { BN } from "@coral-xyz/anchor";
import {
  deriveVaultStatePda,
  fetchUpgradeAuthority,
  lamportsToSol,
  loadProgram,
  loadProvider,
  parseLimits,
  sendWithRetry,
} from "./common";

async function main() {
  const [perTxArg, perWindowArg, windowArg] = process.argv.slice(2);
  if (!perTxArg || !perWindowArg || !windowArg) {
    console.error(
      "Usage: set_limits.ts <max_per_tx_sol> <max_per_window_sol> <window_seconds>",
    );
    process.exit(1);
  }

  let limits: ReturnType<typeof parseLimits>;
  try {
    limits = parseLimits(perTxArg, perWindowArg, windowArg);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  const { perTx, perWindow, windowSeconds } = limits;

  const provider = loadProvider();
  const program = loadProgram(provider);
  const authority = provider.wallet.publicKey;
  const [vaultState] = deriveVaultStatePda(program.programId);

  const upgradeAuthority = await fetchUpgradeAuthority(
    provider.connection,
    program.programId,
  );
  if (!upgradeAuthority?.equals(authority)) {
    console.error("ANCHOR_WALLET is not the program's upgrade authority.");
    console.error("upgrade authority:", upgradeAuthority?.toBase58() ?? "none");
    process.exit(1);
  }

  const signature = await sendWithRetry(
    provider,
    () =>
      program.methods
        .setLimits(
          new BN(perTx.toString()),
          new BN(perWindow.toString()),
          windowSeconds,
        )
        .accountsPartial({ authority, vaultState })
        .transaction(),
    [],
    "set_limits",
  );

  const state = await program.account.vaultState.fetch(vaultState);
  console.log("tx:                ", signature);
  console.log(
    "max per tx:        ",
    state.maxWithdrawPerTx.isZero()
      ? "none"
      : `${lamportsToSol(BigInt(state.maxWithdrawPerTx.toString()))} SOL`,
  );
  console.log(
    "max per window:    ",
    state.maxWithdrawPerWindow.isZero()
      ? "none"
      : `${lamportsToSol(BigInt(state.maxWithdrawPerWindow.toString()))} SOL per ${state.windowSeconds}s`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
