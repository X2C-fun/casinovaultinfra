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
  parseU64,
  sendWithRetry,
  solToLamports,
} from "./common";

function capLamports(arg: string): bigint {
  return /^0*(\.0*)?$/.test(arg.trim()) ? BigInt(0) : solToLamports(arg);
}

async function main() {
  const [perTxArg, perWindowArg, windowArg] = process.argv.slice(2);
  if (!perTxArg || !perWindowArg || !windowArg) {
    console.error(
      "Usage: set_limits.ts <max_per_tx_sol> <max_per_window_sol> <window_seconds>",
    );
    process.exit(1);
  }

  const perTx = capLamports(perTxArg);
  const perWindow = capLamports(perWindowArg);
  const windowSeconds = parseU64(windowArg, "window_seconds");
  if (windowSeconds > BigInt(0xffffffff)) {
    console.error("window_seconds must fit in a u32.");
    process.exit(1);
  }
  if ((perWindow === BigInt(0)) !== (windowSeconds === BigInt(0))) {
    console.error(
      "max_per_window and window_seconds must both be 0 or both be non-zero.",
    );
    process.exit(1);
  }

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
    () =>
      program.methods
        .setLimits(
          new BN(perTx.toString()),
          new BN(perWindow.toString()),
          Number(windowSeconds),
        )
        .accountsPartial({ authority, vaultState })
        .rpc({ commitment: "confirmed", maxRetries: 5 }),
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
