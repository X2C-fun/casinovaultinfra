/**
 * WRITE — initialize the singleton vault and SET THE ADMIN KEY.
 *
 * Only the program's upgrade authority can run this, and only once. The
 * upgrade authority signs and pays rent; the admin co-signs to prove it
 * controls the key. Keep them separate: the upgrade authority should be cold
 * (or a multisig), the admin lives in your backend.
 *
 * `initialize`, `set_limits` and `set_paused(true)` go in ONE transaction, so
 * the vault never exists unpaused or without caps, not even for one slot. The
 * caps take the same arguments as `npm run set-limits` and are required;
 * `--no-limits` opts out explicitly. The vault starts paused: the admin
 * unpauses it with `npm run set-paused -- false` once the backend is ready.
 * `--unpaused` skips the pause.
 *
 * Usage:
 *   # 1. Create the admin key (once)
 *   solana-keygen new -o keys/admin.json --no-bip39-passphrase
 *
 *   # 2. Initialize: ANCHOR_WALLET = upgrade authority, ADMIN_WALLET = admin
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=./wallet.json \
 *   ADMIN_WALLET=./keys/admin.json \
 *   npm run initialize -- <max_per_tx_sol> <max_per_window_sol> <window_seconds> [--unpaused]
 *
 *   # or, deliberately without caps:
 *   npm run initialize -- --no-limits [--unpaused]
 *
 * Example — at most 5 SOL per withdrawal and 50 SOL per hour, start paused:
 *   npm run initialize -- 5 50 3600
 *
 * If ADMIN_WALLET is omitted, the upgrade authority also becomes the admin
 * (acceptable for local testing only).
 */

import { BN } from "@coral-xyz/anchor";
import { SystemProgram, Transaction } from "@solana/web3.js";
import {
  derivePoolVaultPda,
  deriveVaultStatePda,
  fetchUpgradeAuthority,
  Limits,
  lamportsToSol,
  loadKeypair,
  loadProgram,
  loadProvider,
  parseLimits,
  sendWithRetry,
} from "./common";

const USAGE = [
  "Usage: initialize.ts <max_per_tx_sol> <max_per_window_sol> <window_seconds> [--unpaused]",
  "       initialize.ts --no-limits [--unpaused]",
].join("\n");

function parseArgs(argv: string[]): { limits: Limits | null; pause: boolean } {
  const flags = argv.filter((a) => a.startsWith("--"));
  const positional = argv.filter((a) => !a.startsWith("--"));
  for (const flag of flags) {
    if (flag !== "--no-limits" && flag !== "--unpaused") {
      throw new Error(`unknown option ${flag}\n${USAGE}`);
    }
  }
  const pause = !flags.includes("--unpaused");
  if (flags.includes("--no-limits")) {
    if (positional.length > 0) {
      throw new Error(`--no-limits takes no cap arguments\n${USAGE}`);
    }
    return { limits: null, pause };
  }
  if (positional.length !== 3) {
    throw new Error(
      `withdrawal caps are required (or pass --no-limits)\n${USAGE}`,
    );
  }
  const [perTx, perWindow, windowSeconds] = positional;
  return { limits: parseLimits(perTx, perWindow, windowSeconds), pause };
}

function capsText(perTx: bigint, perWindow: bigint, windowSeconds: number) {
  const tx = perTx === BigInt(0) ? "none" : `${lamportsToSol(perTx)} SOL`;
  const window =
    perWindow === BigInt(0)
      ? "none"
      : `${lamportsToSol(perWindow)} SOL per ${windowSeconds}s`;
  return `per tx ${tx}, per window ${window}`;
}

async function main() {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  const { limits, pause } = args;
  const provider = loadProvider();
  const program = loadProgram(provider);
  const authority = provider.wallet.publicKey;
  const adminPath = process.env.ADMIN_WALLET;
  const adminKeypair = adminPath ? loadKeypair(adminPath) : null;
  const admin = adminKeypair?.publicKey ?? authority;

  const [vaultState] = deriveVaultStatePda(program.programId);
  const [poolVault, vaultBump] = derivePoolVaultPda(program.programId);

  console.log("cluster:    ", provider.connection.rpcEndpoint);
  console.log("program:    ", program.programId.toBase58());
  console.log("authority:  ", authority.toBase58());
  console.log("admin (set):", admin.toBase58());
  console.log(
    "caps:       ",
    limits
      ? capsText(limits.perTx, limits.perWindow, limits.windowSeconds)
      : "none (--no-limits)",
  );
  console.log("start:      ", pause ? "paused" : "unpaused (--unpaused)");

  const onChainAuthority = await fetchUpgradeAuthority(
    provider.connection,
    program.programId,
  );
  if (!onChainAuthority) {
    console.error(
      "The program is immutable; it can no longer be initialized. Redeploy.",
    );
    process.exit(1);
  }
  if (!onChainAuthority.equals(authority)) {
    console.error("ANCHOR_WALLET is not the program's upgrade authority.");
    console.error("upgrade authority:", onChainAuthority.toBase58());
    process.exit(1);
  }

  const existing = await provider.connection.getAccountInfo(vaultState);
  if (existing) {
    const state = await program.account.vaultState.fetch(vaultState);
    console.error("Already initialized.");
    console.error("admin on-chain:", state.admin.toBase58());
    process.exit(1);
  }

  if (!adminKeypair) {
    console.warn(
      "WARNING: ADMIN_WALLET not set — the upgrade authority will also be the admin.",
    );
  }
  if (!limits) {
    console.warn(
      "WARNING: --no-limits — withdrawals are capped only by the pool balance.",
    );
  }

  const poolBefore = await provider.connection.getBalance(poolVault);
  console.log("vault_state:", vaultState.toBase58());
  console.log("pool_vault: ", poolVault.toBase58(), `(bump ${vaultBump})`);
  if (poolBefore > 0) {
    console.log(
      "pool already holds",
      lamportsToSol(poolBefore),
      "SOL (prefunded or upgraded from v0.1); it is kept as is.",
    );
  }

  // One transaction: if it lands, the vault has its caps and pause flag from
  // the first slot it exists; if it fails, nothing was created.
  const build = async () => {
    const tx = new Transaction().add(
      await program.methods
        .initialize()
        .accountsPartial({
          authority,
          admin,
          vaultState,
          poolVault,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
    );
    if (limits) {
      tx.add(
        await program.methods
          .setLimits(
            new BN(limits.perTx.toString()),
            new BN(limits.perWindow.toString()),
            limits.windowSeconds,
          )
          .accountsPartial({ authority, vaultState })
          .instruction(),
      );
    }
    if (pause) {
      tx.add(
        await program.methods
          .setPaused(true)
          .accountsPartial({ admin, vaultState })
          .instruction(),
      );
    }
    return tx;
  };

  const signature = await sendWithRetry(
    provider,
    build,
    adminKeypair ? [adminKeypair] : [],
    "initialize",
  );

  const state = await program.account.vaultState.fetch(vaultState);
  console.log("\nInitialized.");
  console.log("tx:         ", signature);
  console.log("admin:      ", state.admin.toBase58());
  console.log("vault_bump: ", state.vaultBump);
  console.log("paused:     ", state.paused);
  console.log(
    "caps:       ",
    capsText(
      BigInt(state.maxWithdrawPerTx.toString()),
      BigInt(state.maxWithdrawPerWindow.toString()),
      state.windowSeconds,
    ),
  );
  console.log("\nVerify with: npm run read");
  if (state.paused) {
    console.log(
      "Unpause when the backend is ready (ANCHOR_WALLET = admin): npm run set-paused -- false",
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
