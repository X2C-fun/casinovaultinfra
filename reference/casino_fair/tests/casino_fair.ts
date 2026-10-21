/**
 * Tests for the provably-fair coin-flip reference program.
 *
 * ## What runs on a bare `anchor test` validator, and what does not
 *
 * A bare local validator has NO MagicBlock VRF oracle: no VRF program to CPI
 * into on `request_flip`, and nothing to produce a `callback_flip`. So the
 * happy path (request accepted → oracle fulfils → round settled) is an
 * *integration* test against devnet or an ephemeral rollup — see
 * `docs/fairness.md` for the manual devnet steps. Those cases are written here
 * as `it.skip` so they document the shape without failing the suite.
 *
 * What IS exercised locally are the checks that run *before* any VRF CPI, and
 * the callback's identity gate:
 *
 *   - `init_flip` creates the account in `Idle`.
 *   - `request_flip` rejects a non-coin-side guess (`InvalidGuess`) and an
 *     unrecognised oracle queue (`InvalidOracleQueue`) — both fail ahead of the
 *     oracle CPI.
 *   - `callback_flip` invoked WITHOUT the real scoped VRF identity signer is
 *     rejected. This is the test that proves the `#[vrf_callback]` macro is
 *     doing its job: strip it and this spoofed call would settle a flip.
 *
 * NOTE: the exact names of the accounts injected by the `#[vrf]` /
 * `#[vrf_callback]` macros (e.g. `vrfProgramIdentity`) should be confirmed
 * against the generated IDL in `target/idl/casino_fair.json`. On this machine
 * the IDL could not be generated: the MagicBlock SDK pulls a transitive crate
 * requiring Rust `edition2024`, which the installed Solana platform-tools Cargo
 * (1.84) cannot build. See `docs/fairness.md` ("Local build limitation").
 */

import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { assert } from "chai";

import { CasinoFair } from "../target/types/casino_fair";
import { airdrop, expectAnchorError, expectFailure, fund } from "./utils";

/** Seed prefix, mirrored from `programs/casino_fair/src/constants.rs`. */
const FLIP_SEED = Buffer.from("flip");

/** The base-layer (Solana) VRF queue, `vrf::consts::DEFAULT_QUEUE`. */
const DEFAULT_QUEUE = new PublicKey(
  "Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh",
);

/** Coin sides, matching the `CoinSide` numeric contract. */
const HEADS = 0;
const TAILS = 1;

describe("casino_fair", () => {
  // Use a "confirmed" provider for the same reason the vault suite does: a
  // "processed" blockhash can be unknown to the simulating bank.
  const envProvider = anchor.AnchorProvider.env();
  const provider = new anchor.AnchorProvider(
    new anchor.web3.Connection(envProvider.connection.rpcEndpoint, "confirmed"),
    envProvider.wallet,
    { commitment: "confirmed", preflightCommitment: "confirmed" },
  );
  anchor.setProvider(provider);

  const program = anchor.workspace.casinoFair as Program<CasinoFair>;

  /** Derives a player's flip PDA, `["flip", player]`. */
  function deriveFlipPda(player: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [FLIP_SEED, player.toBuffer()],
      program.programId,
    );
  }

  /** Creates a flip account for a fresh, funded player. */
  async function newPlayerWithFlip(): Promise<{
    player: Keypair;
    flip: PublicKey;
  }> {
    const player = Keypair.generate();
    await fund(provider, player.publicKey, LAMPORTS_PER_SOL);
    const [flip] = deriveFlipPda(player.publicKey);
    await program.methods
      .initFlip()
      .accountsPartial({
        player: player.publicKey,
        flip,
        systemProgram: SystemProgram.programId,
      })
      .signers([player])
      .rpc({ commitment: "confirmed" });
    return { player, flip };
  }

  before(async () => {
    await airdrop(provider, provider.wallet.publicKey, 100 * LAMPORTS_PER_SOL);
  });

  describe("init_flip", () => {
    it("creates the flip account in the Idle state", async () => {
      const { player, flip } = await newPlayerWithFlip();
      const account = await program.account.flip.fetch(flip);

      assert.isTrue(account.player.equals(player.publicKey));
      assert.property(account.status, "idle", "a fresh flip is Idle");
      assert.equal(account.round.toNumber(), 0);
      assert.isFalse(account.won);
    });

    it("rejects a second init for the same player", async () => {
      const { player, flip } = await newPlayerWithFlip();
      await expectFailure(
        program.methods
          .initFlip()
          .accountsPartial({
            player: player.publicKey,
            flip,
            systemProgram: SystemProgram.programId,
          })
          .signers([player])
          .rpc(),
        /already in use|in use/i,
      );
    });
  });

  describe("request_flip — validation that runs before the VRF CPI", () => {
    it("rejects a guess that is not a coin side", async () => {
      const { player, flip } = await newPlayerWithFlip();
      await expectAnchorError(
        program.methods
          .requestFlip(7, 2) // client_seed = 7, guess = 2 (invalid)
          .accountsPartial({
            payer: player.publicKey,
            flip,
            oracleQueue: DEFAULT_QUEUE,
          })
          .signers([player])
          .rpc(),
        "InvalidGuess",
      );
    });

    it("rejects an unrecognised oracle queue", async () => {
      const { player, flip } = await newPlayerWithFlip();
      const bogusQueue = Keypair.generate().publicKey;
      await expectAnchorError(
        program.methods
          .requestFlip(7, HEADS)
          .accountsPartial({
            payer: player.publicKey,
            flip,
            oracleQueue: bogusQueue,
          })
          .signers([player])
          .rpc(),
        "InvalidOracleQueue",
      );
    });
  });

  describe("callback_flip — identity enforcement", () => {
    it("rejects a spoofed callback with no valid VRF identity signer", async () => {
      const { flip } = await newPlayerWithFlip();

      // An attacker tries to settle the flip with randomness of their choosing,
      // supplying a key they control in place of the program's scoped VRF
      // identity. The `#[vrf_callback]` macro pins that signer to a PDA the
      // attacker cannot sign for, so the call must fail. Account name
      // (`vrfProgramIdentity`) should be confirmed against the generated IDL.
      const impostor = Keypair.generate();
      const randomness = new Array(32).fill(1); // would force a TAILS result
      await expectFailure(
        program.methods
          .callbackFlip(randomness, 7, new BN(1))
          .accountsPartial({
            flip,
            vrfProgramIdentity: impostor.publicKey,
          })
          .signers([impostor])
          .rpc(),
        /identity|signer|seeds|constraint|unknown|account/i,
      );
    });
  });

  describe("request → fulfillment (integration only — needs the VRF oracle)", () => {
    // These require the VRF program cloned into the validator AND a running
    // oracle to deliver the callback. A bare `anchor test` has neither, so they
    // are skipped here and run manually against devnet (see docs/fairness.md).

    it.skip("transitions Idle → Requested, recording guess, seed and round", async () => {
      const { player, flip } = await newPlayerWithFlip();
      await program.methods
        .requestFlip(42, TAILS)
        .accountsPartial({
          payer: player.publicKey,
          flip,
          oracleQueue: DEFAULT_QUEUE,
        })
        .signers([player])
        .rpc({ commitment: "confirmed" });

      const account = await program.account.flip.fetch(flip);
      assert.property(account.status, "requested");
      assert.equal(account.round.toNumber(), 1);
      assert.equal(account.clientSeed, 42);
      assert.property(account.guess, "tails");
    });

    it.skip("rejects a second request while one is in flight", async () => {
      const { player, flip } = await newPlayerWithFlip();
      const request = () =>
        program.methods
          .requestFlip(1, HEADS)
          .accountsPartial({
            payer: player.publicKey,
            flip,
            oracleQueue: DEFAULT_QUEUE,
          })
          .signers([player])
          .rpc({ commitment: "confirmed" });

      await request();
      await expectAnchorError(request(), "RequestInProgress");
    });

    it.skip("settles the round from the oracle callback and emits FlipSettledEvent", async () => {
      // Observed only when a real oracle fulfils the request: the flip reaches
      // `Settled`, `last_randomness` is populated, `won == (result === guess)`,
      // and exactly one FlipSettledEvent is emitted for the round. A duplicate
      // callback for the same round is a no-op (idempotency).
    });
  });
});
