/**
 * casino_fair DEVNET SMOKE TEST — a live request -> VRF callback round trip,
 * plus the negative checks a bare local validator cannot run (it has no VRF
 * program or oracle).
 *
 * What it does, with ANCHOR_WALLET as the player and fee payer:
 *   1. `init_flip` if the player's flip PDA does not exist yet.
 *   2. `request_flip` on a queue the program does not accept
 *      (DEFAULT_TEST_QUEUE) -> must fail with InvalidOracleQueue (6003).
 *   3. `request_flip` + `cancel_flip` in ONE transaction -> the cancel must
 *      fail with CancelTooEarly (6005); `request_flip` + `close_flip` in one
 *      transaction -> the close must fail with CloseWhileRequested (6006).
 *      (The devnet oracle settles within a couple of slots, faster than a
 *      separate transaction can land, so the request has to share the
 *      transaction. The failure rolls the request back too.)
 *   4. For each of FLIPS rounds (default 2):
 *      a. `request_flip(client_seed, guess)` on the base-layer DEFAULT_QUEUE;
 *      b. right after it, `callback_flip` signed by the player posing as
 *         `vrf_program_identity`, with the live request's exact arguments and
 *         winning randomness -> must fail with Anchor ConstraintAddress (2012);
 *      c. polls the flip until `Settled` (TIMEOUT_SECS, default 120), finds
 *         the oracle's callback transaction and checks the stored result
 *         against `last_randomness`.
 *   5. `close_flip` (now `Settled`) -> succeeds and returns the rent.
 *      Set KEEP_FLIP=1 to skip the close.
 *
 * The negative checks are sent with `skipPreflight`, so each one lands on
 * devnet as a failed transaction with a signature you can inspect. Each costs
 * one signature fee (5000 lamports). A full run spends about 0.003 SOL plus
 * the VRF request fees, and the flip rent comes back at the end.
 *
 * Usage (from the repository root, after `npm install`):
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=./keys/deployer.json \
 *   npx ts-node --compiler-options '{"module":"commonjs"}' \
 *     reference/casino_fair/scripts/devnet-smoke.ts
 *
 * Optional: PROGRAM_ID (defaults to the address in ../idl/casino_fair.json),
 * FLIPS, TIMEOUT_SECS, KEEP_FLIP=1.
 *
 * Exit code 0 only if every check passed. Devnet only: never run this with a
 * key that holds real funds.
 */

import * as anchor from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

/** ephemeral-vrf-sdk 0.17.3 `consts` (re-exported by ephemeral-rollups-sdk). */
const VRF_PROGRAM_ID = new PublicKey(
  "Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz",
);
const DEFAULT_QUEUE = new PublicKey(
  "Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh",
);
const DEFAULT_TEST_QUEUE = new PublicKey(
  "GKE6d7iv8kCBrsxr78W3xVdjGLLLJnxsGiuzrsZCGEvb",
);

/** Program error codes (src/errors.rs; Anchor offsets them by 6000). */
const ERR = {
  InvalidOracleQueue: 6003,
  NoRequestInFlight: 6004,
  CancelTooEarly: 6005,
  CloseWhileRequested: 6006,
  /** Anchor's built-in `address = ...` constraint failure. */
  ConstraintAddress: 2012,
} as const;

const RPC_URL =
  process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com";
const WALLET = process.env.ANCHOR_WALLET;
const FLIPS = Number(process.env.FLIPS ?? "2");
const TIMEOUT_MS = Number(process.env.TIMEOUT_SECS ?? "120") * 1000;
const KEEP_FLIP = process.env.KEEP_FLIP === "1";

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];

function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
}

function loadKeypair(file: string): Keypair {
  const bytes = JSON.parse(fs.readFileSync(file, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The `Custom` code of a failed transaction's error, if it has one. */
function customCode(err: unknown): number | undefined {
  const ie = (err as { InstructionError?: [number, unknown] } | null)
    ?.InstructionError;
  const inner = ie?.[1] as { Custom?: number } | undefined;
  return inner?.Custom;
}

/** Sends `ixs` (skipping preflight so a failure lands on-chain) and returns
 * the signature, slot and `meta.err` of the confirmed transaction. */
async function send(
  connection: Connection,
  payer: Keypair,
  ixs: TransactionInstruction[],
): Promise<{ signature: string; slot: number; err: unknown; logs: string[] }> {
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({
    feePayer: payer.publicKey,
    blockhash,
    lastValidBlockHeight,
  }).add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ...ixs);
  tx.sign(payer);
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries: 5,
  });
  try {
    await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed",
    );
  } catch {
    // web3.js rejects with the bare `meta.err` when the status poll sees a
    // failed transaction. That is an expected outcome here: the error is
    // read from the transaction itself below.
  }
  for (let i = 0; i < 20; i++) {
    const got = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (got) {
      return {
        signature,
        slot: got.slot,
        err: got.meta?.err ?? null,
        logs: got.meta?.logMessages ?? [],
      };
    }
    await sleep(500);
  }
  throw new Error(`transaction ${signature} not found after confirmation`);
}

/** Sends a transaction whose LAST instruction must fail with `expected`
 * (every earlier instruction must have succeeded). `send` puts a
 * ComputeBudget instruction first, so the last of `ixs` is at index
 * `ixs.length`. */
async function expectFailure(
  connection: Connection,
  payer: Keypair,
  name: string,
  ixs: TransactionInstruction[],
  expected: number,
): Promise<void> {
  const res = await send(connection, payer, ixs);
  const ie = (res.err as { InstructionError?: [number, unknown] } | null)
    ?.InstructionError;
  const ok = customCode(res.err) === expected && ie?.[0] === ixs.length;
  record(
    name,
    ok,
    `expected error ${expected} at instruction ${ixs.length}, got ${
      res.err === null ? "success" : JSON.stringify(res.err)
    } (tx ${res.signature})`,
  );
}

/** Decodes this program's events from a transaction's logs, recording which
 * program invoked it. (Anchor 0.32's `EventParser` returned nothing for the
 * oracle's fulfilment transactions, where `callback_flip` runs as a CPI of the
 * VRF program, so the logs are walked by hand.) */
function ownEvents(
  logs: string[],
  programId: PublicKey,
  coder: anchor.Coder,
): { name: string; data: Record<string, unknown>; caller?: string }[] {
  const me = programId.toBase58();
  const stack: string[] = [];
  const out: {
    name: string;
    data: Record<string, unknown>;
    caller?: string;
  }[] = [];
  for (const line of logs) {
    const invoke = /^Program (\S+) invoke \[\d+\]$/.exec(line);
    if (invoke) {
      stack.push(invoke[1]);
      continue;
    }
    if (/^Program \S+ (success|failed)/.test(line)) {
      stack.pop();
      continue;
    }
    if (stack[stack.length - 1] === me && line.startsWith("Program data: ")) {
      const ev = coder.events.decode(line.slice("Program data: ".length));
      if (ev) {
        out.push({
          name: ev.name,
          data: ev.data as Record<string, unknown>,
          caller: stack[stack.length - 2],
        });
      }
    }
  }
  return out;
}

type FlipAccount = {
  player: PublicKey;
  status: Record<string, unknown>;
  round: anchor.BN;
  clientSeed: number;
  guess: Record<string, unknown>;
  lastResult: Record<string, unknown>;
  lastRandomness: number[];
  won: boolean;
  requestedSlot: anchor.BN;
};

const statusOf = (f: FlipAccount) => Object.keys(f.status)[0];
const sideOf = (s: Record<string, unknown>) => Object.keys(s)[0];

async function main(): Promise<void> {
  if (!WALLET) throw new Error("set ANCHOR_WALLET to the player keypair file");
  const player = loadKeypair(WALLET);
  const connection = new Connection(RPC_URL, "confirmed");
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(player),
    { commitment: "confirmed" },
  );

  const idl = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "idl", "casino_fair.json"),
      "utf8",
    ),
  ) as anchor.Idl;
  if (process.env.PROGRAM_ID) idl.address = process.env.PROGRAM_ID;
  const program = new anchor.Program(idl, provider);
  const programId = program.programId;
  const [flipPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("flip"), player.publicKey.toBuffer()],
    programId,
  );
  // Untyped IDL, so the account namespace is indexed by name.
  const flipAccounts = (
    program.account as unknown as Record<string, anchor.AccountClient>
  )["flip"];
  const fetchFlip = async () =>
    (await flipAccounts.fetchNullable(flipPda)) as FlipAccount | null;

  const balanceBefore = await connection.getBalance(player.publicKey);
  console.log("cluster:  ", RPC_URL);
  console.log("program:  ", programId.toBase58());
  console.log("player:   ", player.publicKey.toBase58());
  console.log("flip PDA: ", flipPda.toBase58());
  console.log("balance:  ", balanceBefore / 1e9, "SOL\n");

  const programInfo = await connection.getAccountInfo(programId);
  if (!programInfo?.executable) {
    throw new Error(`program ${programId.toBase58()} is not deployed here`);
  }

  // 1. init_flip
  let flip = await fetchFlip();
  if (!flip) {
    const ix = await program.methods
      .initFlip()
      .accountsPartial({ player: player.publicKey, flip: flipPda })
      .instruction();
    const res = await send(connection, player, [ix]);
    record(
      "init_flip",
      res.err === null,
      `${res.err === null ? "ok" : JSON.stringify(res.err)} (tx ${res.signature})`,
    );
    flip = await fetchFlip();
    if (!flip) throw new Error("flip account missing after init_flip");
  } else {
    console.log(`flip exists (status ${statusOf(flip)}, round ${flip.round})`);
  }
  if (statusOf(flip) === "requested") {
    throw new Error(
      "flip is already Requested from an earlier run: wait for the oracle, or cancel_flip once 150 slots have passed",
    );
  }

  const requestIx = (queue: PublicKey, seed: number, guess: number) =>
    program.methods
      .requestFlip(seed, guess)
      .accountsPartial({
        payer: player.publicKey,
        flip: flipPda,
        oracleQueue: queue,
      })
      .instruction();

  // 2. A queue outside the allow-list is refused before the handler runs.
  await expectFailure(
    connection,
    player,
    "request_flip on DEFAULT_TEST_QUEUE rejected",
    [await requestIx(DEFAULT_TEST_QUEUE, 1, 0)],
    ERR.InvalidOracleQueue,
  );

  const cancelIx = await program.methods
    .cancelFlip()
    .accountsPartial({ player: player.publicKey, flip: flipPda })
    .instruction();
  const closeIx = await program.methods
    .closeFlip()
    .accountsPartial({ player: player.publicKey, flip: flipPda })
    .instruction();

  // 3. cancel / close while Requested. The devnet oracle settles within a
  // couple of slots, faster than a follow-up transaction can land, so each
  // check runs in the SAME transaction as a fresh request_flip: the request
  // succeeds (instruction 1) and the next instruction must fail with the
  // timing error. The failure rolls the whole transaction back, request
  // included, so these leave no request in flight.
  await expectFailure(
    connection,
    player,
    "cancel_flip in the request's own slot rejected (before the 150-slot timeout)",
    [await requestIx(DEFAULT_QUEUE, 2, 0), cancelIx],
    ERR.CancelTooEarly,
  );
  await expectFailure(
    connection,
    player,
    "close_flip while Requested rejected",
    [await requestIx(DEFAULT_QUEUE, 3, 0), closeIx],
    ERR.CloseWhileRequested,
  );

  // 4. Live rounds.
  for (let n = 1; n <= FLIPS; n++) {
    const seed = Math.floor(Math.random() * 256);
    const guess = n % 2; // alternate HEADS / TAILS
    console.log(
      `\n--- flip ${n}/${FLIPS}: guess ${guess === 0 ? "HEADS" : "TAILS"}, client_seed ${seed} ---`,
    );

    const req = await send(connection, player, [
      await requestIx(DEFAULT_QUEUE, seed, guess),
    ]);
    const requestedAt = Date.now();
    record(
      `round ${n}: request_flip on DEFAULT_QUEUE`,
      req.err === null,
      `${req.err === null ? "ok" : JSON.stringify(req.err)} (tx ${req.signature}, slot ${req.slot})`,
    );
    if (req.err !== null) {
      req.logs.forEach((l) => console.log("   ", l));
      break;
    }
    const live = await fetchFlip();
    if (!live) throw new Error("flip vanished after request_flip");
    const round = live.round;
    const requestedSlot = live.requestedSlot;
    console.log(
      `request committed: round ${round}, requested_slot ${requestedSlot}, status ${statusOf(live)}`,
    );

    // b. Spoofed callback, sent right after the request: the player signs
    // as `vrf_program_identity`, passes the live request's exact
    // (client_seed, round, requested_slot) and randomness that makes the guess
    // win. Without the #[vrf_callback] gate this would settle the flip (if
    // the oracle has not already). The address constraint must refuse it.
    const winning = new Array<number>(32).fill(0xa5);
    winning[31] = guess; // last-byte parity decides the side
    const spoofIx = await program.methods
      .callbackFlip(winning, seed, round, requestedSlot)
      .accountsPartial({ vrfProgramIdentity: player.publicKey, flip: flipPda })
      .instruction();
    await expectFailure(
      connection,
      player,
      `round ${n}: spoofed callback_flip (player as vrf_program_identity) rejected`,
      [spoofIx],
      ERR.ConstraintAddress,
    );

    // c. Wait for the oracle.
    let settled: FlipAccount | null = null;
    while (Date.now() - requestedAt < TIMEOUT_MS) {
      const f = await fetchFlip();
      if (f && statusOf(f) === "settled" && f.round.eq(round)) {
        settled = f;
        break;
      }
      await sleep(1000);
    }
    const waited = ((Date.now() - requestedAt) / 1000).toFixed(1);
    if (!settled) {
      const f = await fetchFlip();
      record(
        `round ${n}: VRF oracle fulfilled the request`,
        false,
        `still ${f ? statusOf(f) : "missing"} after ${waited}s (request tx ${req.signature})`,
      );
      break;
    }

    // Find the oracle's callback transaction among the flip's signatures
    // (the signature index can lag the account by a few seconds).
    let callbackSig: string | undefined;
    let callbackSlot: number | undefined;
    let oracleSigner: string | undefined;
    let viaVrfProgram = false;
    let settledEvent: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 10 && !callbackSig; attempt++) {
      if (attempt > 0) await sleep(2000);
      const sigs = await connection.getSignaturesForAddress(flipPda, {
        limit: 20,
      });
      for (const s of sigs) {
        if (s.err !== null || s.slot < req.slot) continue;
        const tx = await connection.getTransaction(s.signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
        const logs = tx?.meta?.logMessages ?? [];
        for (const ev of ownEvents(logs, programId, program.coder)) {
          if (
            ev.name.toLowerCase() === "flipsettledevent" &&
            (ev.data.round as anchor.BN).eq(round)
          ) {
            callbackSig = s.signature;
            callbackSlot = s.slot;
            settledEvent = ev.data;
            oracleSigner = tx?.transaction.message
              .getAccountKeys()
              .get(0)
              ?.toBase58();
            viaVrfProgram = ev.caller === VRF_PROGRAM_ID.toBase58();
          }
        }
        if (callbackSig) break;
      }
    }
    record(
      `round ${n}: VRF oracle fulfilled; callback_flip settled the flip`,
      callbackSig !== undefined && viaVrfProgram,
      `Settled after ${waited}s (${
        callbackSlot !== undefined ? callbackSlot - req.slot : "?"
      } slots); callback tx ${callbackSig ?? "not found"}, fee payer (oracle) ${oracleSigner ?? "?"}, called by the VRF program ${viaVrfProgram}`,
    );

    // The stored result must be the parity of the stored randomness.
    const rnd = settled.lastRandomness;
    const expectedSide = rnd[31] % 2 === 0 ? "heads" : "tails";
    const result = sideOf(settled.lastResult);
    const guessSide = sideOf(settled.guess);
    record(
      `round ${n}: result matches last_randomness and won flag`,
      result === expectedSide &&
        settled.won === (result === guessSide) &&
        settled.clientSeed === seed,
      `randomness ${Buffer.from(rnd).toString("hex")} -> ${result.toUpperCase()}; guess ${guessSide.toUpperCase()}; won ${settled.won}${
        settledEvent ? `; FlipSettledEvent won ${String(settledEvent.won)}` : ""
      }`,
    );
  }

  // 5. close_flip in a non-Requested state returns the rent.
  if (!KEEP_FLIP) {
    const f = await fetchFlip();
    if (f && statusOf(f) !== "requested") {
      const rent = (await connection.getAccountInfo(flipPda))?.lamports ?? 0;
      const res = await send(connection, player, [closeIx]);
      const gone = (await connection.getAccountInfo(flipPda)) === null;
      record(
        `close_flip (status ${statusOf(f)})`,
        res.err === null && gone,
        `${res.err === null ? "ok" : JSON.stringify(res.err)}, ${rent / 1e9} SOL rent returned, account ${gone ? "closed" : "STILL OPEN"} (tx ${res.signature})`,
      );
    } else {
      console.log("\nclose_flip skipped: flip is still Requested");
    }
  }

  const balanceAfter = await connection.getBalance(player.publicKey);
  console.log(
    `\nbalance: ${balanceAfter / 1e9} SOL (spent ${(balanceBefore - balanceAfter) / 1e9} SOL)`,
  );
  const failed = checks.filter((c) => !c.ok);
  console.log(
    `\n${checks.length - failed.length}/${checks.length} checks passed`,
  );
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
