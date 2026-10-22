# @x2c-fun/casinovault-sdk

TypeScript SDK for the [Casino Vault](https://github.com/X2C-fun/casinovaultinfra) Solana program — the custody layer that holds pooled player SOL for a casino backend, with admin-approved withdrawals.

It gives you the typed IDL, PDA derivation, instruction builders, a **safe** withdraw-transaction builder plus a client-side assertion, account reads, event decoding, and the pool-reconciliation invariant. It reads no `process.env`, depends on no UI framework, and never touches a `Buffer` global (it imports `Buffer` from the `buffer` package, a dependency, and uses `DataView` elsewhere), so the same bundle runs in a browser or a Node backend. Both the ESM and CommonJS builds load in plain Node (`npm run smoke` checks this).

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
// Optional: computeUnitLimit (with or without a price) and
// computeUnitPriceMicroLamports. The builder throws if the worst-case priority
// fee exceeds MAX_PRIORITY_FEE_LAMPORTS, the same ceiling the client enforces.
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
  programId: VAULT_PROGRAM_ID,  // a constant in YOUR bundle (default: DEFAULT_PROGRAM_ID)
});
// throws UnsafeWithdrawTxError if the tx is anything other than exactly this withdraw
```

`programId` and `expectedAdmin` must come from the client (a bundled constant, or read from chain), **never** from the server response being checked: a server that chooses the program ID can point the check at a program of its own. The assertion accepts legacy `Transaction`s only and rejects a `VersionedTransaction`.

## Listen to events (for the settlement listener)

Events drive the backend ledger. Credit/debit only from **finalized** transactions and de-duplicate by source, never by content. `decodeVaultTransactionEvents` does the rest:

```ts
import { decodeVaultTransactionEvents, vaultEventKey } from "@x2c-fun/casinovault-sdk";

const tx = await connection.getTransaction(sig, {
  commitment: "finalized",
  maxSupportedTransactionVersion: 0,
});
// Throws MissingTransactionDataError if tx/meta is null (retry; never treat as "no events").
// Returns [] if meta.err is set: a failed tx's logs AND inner instructions still
// contain the events emitted before the failure, and they must not be credited.
for (const ev of decodeVaultTransactionEvents(tx, { programId, source: "cpi" })) {
  const key = vaultEventKey(sig, ev); // `${sig}:cpi:${instructionIndex}:${eventIndex}`
  // upsert on `key` (UNIQUE) so restarts/backfills never double-credit
  if (ev.name === "depositEvent") credit(ev.data.user, ev.data.amount, key);
  if (ev.name === "withdrawEvent") settle(ev.data.requestId, ev.data, key);
}
```

- **Consume ONE source.** `DepositEvent` and `WithdrawEvent` are emitted twice per instruction: in the logs (`emit!`, `source: "log"`) and as a self-CPI (`emit_cpi!`, `source: "cpi"`). Reading both double-credits. The source is part of the key, so pick one and keep it.
- **`"cpi"` is the recommended default.** It reads `meta.innerInstructions`, accepting only inner instructions to the vault program whose first account is its `__event_authority` PDA and whose data starts with Anchor's `EVENT_IX_TAG`. It cannot be lost to log truncation. Only `DepositEvent` and `WithdrawEvent` are emitted this way; admin events (`pauseStateChangedEvent`, `limitsUpdatedEvent`, …) are in the logs only, so read those with `source: "log"`.
- `"log"` reads `Program data:` lines emitted while the vault program is executing, attributed to their top-level instruction. It throws `MissingTransactionDataError` if logs are missing or truncated.
- A vault payload the v0.2 IDL cannot decode (e.g. a pre-upgrade v0.1-layout event) throws `UndecodableEventError` (with `.signature` and `.instructionIndex`) instead of being dropped. Decode those with the v0.1 IDL or reconcile them by hand.

`parseVaultEventsFromLogs(program, logs)` remains as a low-level helper. It does **not** check `meta.err`, detect truncation, attribute instructions, or report undecodable payloads, so do not use it for balances.

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
| Constants | `DEFAULT_PROGRAM_ID`, `*_SEED`, `BPF_LOADER_UPGRADEABLE_PROGRAM_ID` |
| PDAs | `deriveVaultStatePda`, `derivePoolVaultPda`, `deriveEventAuthorityPda`, `deriveProgramDataAddress` |
| Program | `createConnection`, `getProvider`, `getProgram`, `getReadonlyProgram` |
| IDL | `CASINO_VAULT_IDL`, `loadVaultIdl`, type `CasinoVault` |
| Instructions | `toU64Bn` (u64 range check), `buildDepositIx`, `buildWithdrawIx`, `buildInitializeIx`, `buildSetPausedIx`, `buildProposeAdminIx`, `buildAcceptAdminIx`, `buildSetLimitsIx` |
| Withdraw | `buildWithdrawTransaction`, `assertSafeWithdrawTx`, `UnsafeWithdrawTxError`, `MAX_PRIORITY_FEE_LAMPORTS` |
| Reads | `fetchVaultState`, `getPoolBalance`, `getWithdrawable`, `fetchUpgradeAuthority` |
| Events | `decodeVaultTransactionEvents`, `vaultEventKey`, `MissingTransactionDataError`, `UndecodableEventError`, `EVENT_IX_TAG`, types `VaultEventRecord`/`VaultEventSource`/`VaultEventName`/`VaultEventMap`; low-level `parseVaultEventsFromLogs`, `onVaultEvent`; deprecated `eventSourceKey` |
| Reconcile | `reconcilePool`, `reconcilePoolLive` |
| Format | `solToLamports`, `lamportsToSol` (exact, locale-independent), `shortAddress`, `LAMPORTS_PER_SOL_BIGINT` |

## License

MIT
