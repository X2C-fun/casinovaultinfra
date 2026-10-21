# @x2c-fun/casinovault-sdk

TypeScript SDK for the [Casino Vault](https://github.com/X2C-fun/casinovaultinfra) Solana program — the custody layer that holds pooled player SOL for a casino backend, with admin-approved withdrawals.

It gives you the typed IDL, PDA derivation, instruction builders, a **safe** withdraw-transaction builder plus a client-side assertion, account reads, event decoding, and the pool-reconciliation invariant. It reads no `process.env` and depends on no UI framework, so the same bundle runs in a browser or a Node backend.

> **Devnet only.** The program is unaudited and intended for devnet. See the repo's [SECURITY.md](https://github.com/X2C-fun/casinovaultinfra/blob/main/SECURITY.md).

## Install

```bash
npm install @x2c-fun/casinovault-sdk @coral-xyz/anchor @solana/web3.js
```

`@coral-xyz/anchor` and `@solana/web3.js` are peer dependencies — you provide them.

## Quick start (read the vault)

```ts
import { Connection } from "@solana/web3.js";
import {
  createConnection,
  getReadonlyProgram,
  fetchVaultState,
  getWithdrawable,
  lamportsToSol,
} from "@x2c-fun/casinovault-sdk";

const connection = createConnection("https://api.devnet.solana.com");
const program = getReadonlyProgram(connection); // defaults to the canonical program ID

const state = await fetchVaultState(program);
console.log("admin:", state?.admin.toBase58(), "paused:", state?.paused);
console.log("withdrawable:", lamportsToSol(await getWithdrawable(connection)), "SOL");
```

Target your own deployment by passing a `programId: PublicKey` to any helper (or to `getReadonlyProgram`/`getProgram`).

## Deposit (player signs)

```ts
import { getProgram, buildDepositIx, solToLamports } from "@x2c-fun/casinovault-sdk";
import { Transaction } from "@solana/web3.js";

const program = getProgram(connection, wallet); // wallet: AnchorWallet-shaped
const ix = await buildDepositIx(program, {
  depositor: wallet.publicKey,
  amountLamports: solToLamports("0.1"),
});
const sig = await program.provider.sendAndConfirm!(new Transaction().add(ix));
```

## Withdraw (backend builds + co-signs, client verifies)

On the **backend**, build the whole transaction and co-sign it with the admin key — never co-sign a transaction you did not build:

```ts
import { getProgram, buildWithdrawTransaction } from "@x2c-fun/casinovault-sdk";

const program = getProgram(connection, adminWallet);
const tx = await buildWithdrawTransaction(program, {
  user: userPubkey,
  admin: adminWallet.publicKey,
  amountLamports: 500_000n,
  requestId: 42n, // your withdrawal-hold primary key, echoed in WithdrawEvent
});
const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
tx.recentBlockhash = blockhash;
tx.lastValidBlockHeight = lastValidBlockHeight;
tx.partialSign(adminKeypair); // admin signs; user signs + submits
```

In the **browser**, verify before the wallet signs:

```ts
import { assertSafeWithdrawTx } from "@x2c-fun/casinovault-sdk";

assertSafeWithdrawTx(tx, {
  user: wallet.publicKey,
  expectedLamports: 500_000n,
  expectedRequestId: 42n,
  expectedAdmin: onChainAdmin, // from fetchVaultState(...).admin
});
// throws UnsafeWithdrawTxError if the tx is anything other than exactly this withdraw
```

## Listen to events (for the settlement listener)

Events drive the backend ledger. Credit/debit only from **finalized** transactions, skip any whose `meta.err` is set, and de-duplicate by source, never by content:

```ts
import { parseVaultEventsFromLogs, eventSourceKey } from "@x2c-fun/casinovault-sdk";

const tx = await connection.getTransaction(sig, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
if (tx && !tx.meta?.err) {
  for (const [i, ev] of parseVaultEventsFromLogs(program, tx.meta!.logMessages!).entries()) {
    const key = eventSourceKey({ signature: sig, instructionIndex: 0, eventIndex: i });
    // upsert on `key` (unique) so restarts/backfills never double-credit
  }
}
```

For fast UI updates only, `onVaultEvent(program, "withdrawEvent", cb)` subscribes over the websocket.

## Reconcile the pool (solvency invariant)

```ts
import { reconcilePoolLive } from "@x2c-fun/casinovault-sdk";

const r = await reconcilePoolLive(connection, {
  playerBalancesTotal, // Σ(available + pending) across your ledger, in lamports
  houseBankroll,       // the house's own lamports, in lamports
});
if (!r.solvent) alertAndPause(); // pool cannot cover liabilities — incident
```

The invariant is `pool balance === Σ player balances + house bankroll + rent reserve`. A positive `difference` is unattributed SOL (never credit it); a negative one is a shortfall.

## API surface

| Area | Exports |
| --- | --- |
| Constants | `DEFAULT_PROGRAM_ID`, `*_SEED`, `LAMPORTS_PER_SOL` |
| PDAs | `deriveVaultStatePda`, `derivePoolVaultPda`, `deriveEventAuthorityPda`, `deriveProgramDataAddress` |
| Program | `createConnection`, `getProvider`, `getProgram`, `getReadonlyProgram` |
| IDL | `CASINO_VAULT_IDL`, `loadVaultIdl`, type `CasinoVault` |
| Instructions | `buildDepositIx`, `buildWithdrawIx`, `buildInitializeIx`, `buildSetPausedIx`, `buildProposeAdminIx`, `buildAcceptAdminIx`, `buildSetLimitsIx` |
| Withdraw | `buildWithdrawTransaction`, `assertSafeWithdrawTx`, `UnsafeWithdrawTxError`, `MAX_PRIORITY_FEE_LAMPORTS` |
| Reads | `fetchVaultState`, `getPoolBalance`, `getWithdrawable`, `fetchUpgradeAuthority` |
| Events | `parseVaultEventsFromLogs`, `onVaultEvent`, `eventSourceKey`, event types |
| Reconcile | `reconcilePool`, `reconcilePoolLive` |
| Format | `solToLamports`, `lamportsToSol`, `shortAddress` |

## License

MIT
