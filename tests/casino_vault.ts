/**
 * Integration tests for the pooled casino vault.
 *
 * They cover the happy path of every instruction plus the security properties
 * the program must guarantee: funds only leave the pool with the admin's
 * approval, they can only go to the signing user, the pool never drops below its
 * rent reserve, forged state accounts are rejected, and the pause switch stops
 * both directions.
 *
 * The state and pool PDAs are singletons, so the suite initializes the program
 * exactly once and requires a fresh validator (`anchor test` resets the ledger).
 */

import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { assert } from "chai";

import { CasinoVault } from "../target/types/casino_vault";
import { CpiProbe } from "../target/types/cpi_probe";
import {
  VAULT_STATE_SIZE,
  airdrop,
  balanceOf,
  derivePoolVaultPda,
  deriveVaultStatePda,
  expectAnchorError,
  expectEvent,
  expectFailure,
  fund,
  getTxDetails,
  newFundedWallet,
} from "./utils";

describe("casino_vault", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.casinoVault as Program<CasinoVault>;
  /** Test-only program that forwards vault calls through a CPI. */
  const probe = anchor.workspace.cpiProbe as Program<CpiProbe>;
  const connection = provider.connection;

  /** Backend authority for the whole suite. */
  const admin = Keypair.generate();

  let vaultState: PublicKey;
  let poolVault: PublicKey;
  let poolVaultBump: number;

  /** Lamports permanently reserved in the pool to keep it rent exempt. */
  let rentReserve: number;
  /** Rent paid for the `VaultState` account. */
  let stateRent: number;

  /** Accounts shared by `deposit`. */
  function depositAccounts(depositor: PublicKey) {
    return {
      depositor,
      vaultState,
      poolVault,
      systemProgram: SystemProgram.programId,
    };
  }

  /** Accounts shared by `withdraw`. */
  function withdrawAccounts(
    user: PublicKey,
    adminKey: PublicKey = admin.publicKey,
  ) {
    return {
      user,
      admin: adminKey,
      vaultState,
      poolVault,
      systemProgram: SystemProgram.programId,
    };
  }

  /** Deposits `lamports` from `wallet` into the pool. */
  async function deposit(wallet: Keypair, lamports: number): Promise<string> {
    return program.methods
      .deposit(new BN(lamports))
      .accountsPartial(depositAccounts(wallet.publicKey))
      .signers([wallet])
      .rpc({ commitment: "confirmed" });
  }

  /** Releases `lamports` from the pool to `wallet`, with admin approval. */
  async function withdraw(wallet: Keypair, lamports: number): Promise<string> {
    return program.methods
      .withdraw(new BN(lamports))
      .accountsPartial(withdrawAccounts(wallet.publicKey))
      .signers([wallet, admin])
      .rpc({ commitment: "confirmed" });
  }

  /** Flips the pause switch as the admin. */
  async function setPaused(paused: boolean): Promise<string> {
    return program.methods
      .setPaused(paused)
      .accountsPartial({ admin: admin.publicKey, vaultState })
      .signers([admin])
      .rpc({ commitment: "confirmed" });
  }

  before(async () => {
    // The provider wallet funds every player and pays the fees.
    await airdrop(provider, provider.wallet.publicKey, 100 * LAMPORTS_PER_SOL);

    [vaultState] = deriveVaultStatePda(program.programId);
    [poolVault, poolVaultBump] = derivePoolVaultPda(program.programId);

    rentReserve = await connection.getMinimumBalanceForRentExemption(0);
    stateRent =
      await connection.getMinimumBalanceForRentExemption(VAULT_STATE_SIZE);

    await fund(provider, admin.publicKey, LAMPORTS_PER_SOL);
  });

  describe("initialize", () => {
    it("requires the admin signature", async () => {
      await expectFailure(
        program.methods
          .initialize()
          .accountsPartial({
            admin: admin.publicKey,
            vaultState,
            poolVault,
            systemProgram: SystemProgram.programId,
          })
          .rpc(),
        /signature|signer/i,
      );
    });

    it("creates the singleton state, records the admin and parks the reserve", async () => {
      const adminBefore = await balanceOf(provider, admin.publicKey);

      const signature = await program.methods
        .initialize()
        .accountsPartial({
          admin: admin.publicKey,
          vaultState,
          poolVault,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc({ commitment: "confirmed" });

      const state = await program.account.vaultState.fetch(vaultState);
      assert.isTrue(state.admin.equals(admin.publicKey));
      assert.equal(state.vaultBump, poolVaultBump);
      assert.isFalse(state.paused);

      // The pool must stay a data-less system account so the System Program can
      // move lamports out of it under its seed.
      const poolInfo = await connection.getAccountInfo(poolVault, "confirmed");
      assert.isNotNull(poolInfo);
      assert.equal(poolInfo!.lamports, rentReserve);
      assert.equal(poolInfo!.data.length, 0);
      assert.isTrue(poolInfo!.owner.equals(SystemProgram.programId));

      // The admin paid both rents; fees are on the provider wallet here.
      assert.equal(
        await balanceOf(provider, admin.publicKey),
        adminBefore - stateRent - rentReserve,
      );

      const event = expectEvent(
        await getTxDetails(program, provider, signature),
        "vaultInitializedEvent",
      );
      assert.isTrue(event.admin.equals(admin.publicKey));
      assert.equal(event.vaultBump, poolVaultBump);
      assert.equal(event.rentReserve.toNumber(), rentReserve);
      assert.isAbove(event.timestamp.toNumber(), 0);
    });

    it("cannot be run a second time", async () => {
      const other = await newFundedWallet(provider, LAMPORTS_PER_SOL);

      await expectFailure(
        program.methods
          .initialize()
          .accountsPartial({
            admin: other.publicKey,
            vaultState,
            poolVault,
            systemProgram: SystemProgram.programId,
          })
          .signers([other])
          .rpc(),
        /already in use/i,
      );

      const state = await program.account.vaultState.fetch(vaultState);
      assert.isTrue(
        state.admin.equals(admin.publicKey),
        "the original admin must survive a hijack attempt",
      );
    });
  });

  describe("deposit", () => {
    it("moves SOL into the pool and emits DepositEvent", async () => {
      const player = await newFundedWallet(provider, 5 * LAMPORTS_PER_SOL);
      const amount = 2 * LAMPORTS_PER_SOL;
      const playerBefore = await balanceOf(provider, player.publicKey);
      const poolBefore = await balanceOf(provider, poolVault);

      const signature = await deposit(player, amount);

      assert.equal(
        await balanceOf(provider, player.publicKey),
        playerBefore - amount,
      );
      assert.equal(await balanceOf(provider, poolVault), poolBefore + amount);

      const event = expectEvent(
        await getTxDetails(program, provider, signature),
        "depositEvent",
      );
      assert.isTrue(event.user.equals(player.publicKey));
      assert.equal(event.amount.toNumber(), amount);
      assert.equal(event.vaultBalance.toNumber(), poolBefore + amount);
      assert.isAbove(event.timestamp.toNumber(), 0);
    });

    it("pools deposits from unrelated wallets into one vault", async () => {
      const alice = await newFundedWallet(provider, 3 * LAMPORTS_PER_SOL);
      const bob = await newFundedWallet(provider, 6 * LAMPORTS_PER_SOL);
      const poolBefore = await balanceOf(provider, poolVault);

      await deposit(alice, LAMPORTS_PER_SOL);
      await deposit(bob, 5 * LAMPORTS_PER_SOL);

      assert.equal(
        await balanceOf(provider, poolVault),
        poolBefore + 6 * LAMPORTS_PER_SOL,
        "both deposits land in the same pool vault",
      );
    });

    it("supports the depositor paying the transaction fee", async () => {
      const player = await newFundedWallet(provider, 3 * LAMPORTS_PER_SOL);
      const amount = LAMPORTS_PER_SOL;
      const playerBefore = await balanceOf(provider, player.publicKey);

      const tx = await program.methods
        .deposit(new BN(amount))
        .accountsPartial(depositAccounts(player.publicKey))
        .transaction();

      const signature = await sendAndConfirmTransaction(
        connection,
        tx,
        [player],
        { commitment: "confirmed" },
      );

      const { fee, feePayer } = await getTxDetails(
        program,
        provider,
        signature,
      );
      assert.isTrue(
        feePayer.equals(player.publicKey),
        "the player must be the fee payer",
      );
      assert.equal(
        await balanceOf(provider, player.publicKey),
        playerBefore - amount - fee,
      );
    });

    it("rejects a zero amount", async () => {
      const player = await newFundedWallet(provider, 2 * LAMPORTS_PER_SOL);

      await expectAnchorError(
        program.methods
          .deposit(new BN(0))
          .accountsPartial(depositAccounts(player.publicKey))
          .signers([player])
          .rpc(),
        "InvalidAmount",
      );
    });

    it("rejects an amount larger than the depositor's balance", async () => {
      const player = await newFundedWallet(provider, 2 * LAMPORTS_PER_SOL);

      await expectAnchorError(
        program.methods
          .deposit(new BN(10 * LAMPORTS_PER_SOL))
          .accountsPartial(depositAccounts(player.publicKey))
          .signers([player])
          .rpc(),
        "InsufficientFunds",
      );
    });

    it("rejects an amount that would overflow the pool balance", async () => {
      const player = await newFundedWallet(provider, 2 * LAMPORTS_PER_SOL);

      await expectAnchorError(
        program.methods
          .deposit(new BN("18446744073709551615"))
          .accountsPartial(depositAccounts(player.publicKey))
          .signers([player])
          .rpc(),
        "MathOverflow",
      );
    });

    it("rejects a pool vault that is not the program's PDA", async () => {
      const player = await newFundedWallet(provider, 2 * LAMPORTS_PER_SOL);
      const fakePool = Keypair.generate().publicKey;

      await expectAnchorError(
        program.methods
          .deposit(new BN(LAMPORTS_PER_SOL))
          .accountsPartial({
            ...depositAccounts(player.publicKey),
            poolVault: fakePool,
          })
          .signers([player])
          .rpc(),
        "ConstraintSeeds",
      );
    });
  });

  describe("withdraw", () => {
    /** House bankroll, so winners can be paid more than they deposited. */
    const bankroll = 20 * LAMPORTS_PER_SOL;

    before(async () => {
      const house = await newFundedWallet(
        provider,
        bankroll + LAMPORTS_PER_SOL,
      );
      await deposit(house, bankroll);
    });

    it("releases SOL to the user when both authorities sign", async () => {
      const player = await newFundedWallet(provider, 3 * LAMPORTS_PER_SOL);
      await deposit(player, 2 * LAMPORTS_PER_SOL);

      const amount = LAMPORTS_PER_SOL;
      const playerBefore = await balanceOf(provider, player.publicKey);
      const poolBefore = await balanceOf(provider, poolVault);

      const signature = await withdraw(player, amount);

      assert.equal(
        await balanceOf(provider, player.publicKey),
        playerBefore + amount,
      );
      assert.equal(await balanceOf(provider, poolVault), poolBefore - amount);

      const event = expectEvent(
        await getTxDetails(program, provider, signature),
        "withdrawEvent",
      );
      assert.isTrue(event.user.equals(player.publicKey));
      assert.isTrue(event.admin.equals(admin.publicKey));
      assert.equal(event.amount.toNumber(), amount);
      assert.equal(event.vaultBalance.toNumber(), poolBefore - amount);
    });

    it("pays a winner more than they ever deposited", async () => {
      const winner = await newFundedWallet(provider, 2 * LAMPORTS_PER_SOL);
      const deposited = LAMPORTS_PER_SOL;
      const winnings = 4 * LAMPORTS_PER_SOL;

      await deposit(winner, deposited);
      const winnerBefore = await balanceOf(provider, winner.publicKey);

      // The extra 3 SOL comes out of the shared bankroll: this is the whole
      // reason the vault is pooled instead of per-user.
      await withdraw(winner, winnings);

      assert.equal(
        await balanceOf(provider, winner.publicKey),
        winnerBefore + winnings,
      );
    });

    it("lets the house pull profits back out to the admin wallet", async () => {
      const amount = 2 * LAMPORTS_PER_SOL;
      const adminBefore = await balanceOf(provider, admin.publicKey);

      // The admin signs both roles: recipient and approver.
      await program.methods
        .withdraw(new BN(amount))
        .accountsPartial(withdrawAccounts(admin.publicKey))
        .signers([admin])
        .rpc({ commitment: "confirmed" });

      assert.equal(
        await balanceOf(provider, admin.publicKey),
        adminBefore + amount,
      );
    });

    it("rejects a withdrawal without the admin signature", async () => {
      const player = await newFundedWallet(provider, LAMPORTS_PER_SOL);

      await expectFailure(
        program.methods
          .withdraw(new BN(LAMPORTS_PER_SOL))
          .accountsPartial(withdrawAccounts(player.publicKey))
          .signers([player])
          .rpc(),
        /signature|signer/i,
      );
    });

    it("rejects a withdrawal without the user signature", async () => {
      const player = await newFundedWallet(provider, LAMPORTS_PER_SOL);

      await expectFailure(
        program.methods
          .withdraw(new BN(LAMPORTS_PER_SOL))
          .accountsPartial(withdrawAccounts(player.publicKey))
          .signers([admin])
          .rpc(),
        /signature|signer/i,
      );
    });

    it("rejects an admin that is not the registered one", async () => {
      const player = await newFundedWallet(provider, LAMPORTS_PER_SOL);
      const rogueAdmin = Keypair.generate();

      await expectAnchorError(
        program.methods
          .withdraw(new BN(LAMPORTS_PER_SOL))
          .accountsPartial(
            withdrawAccounts(player.publicKey, rogueAdmin.publicKey),
          )
          .signers([player, rogueAdmin])
          .rpc(),
        "Unauthorized",
      );
    });

    it("rejects a substituted vault state account", async () => {
      const attacker = await newFundedWallet(provider, 2 * LAMPORTS_PER_SOL);

      // An attacker cannot bring their own state account naming themselves
      // admin. The state PDA address is fixed by its seed, and any other address
      // either holds no program-owned data...
      await expectAnchorError(
        program.methods
          .withdraw(new BN(LAMPORTS_PER_SOL))
          .accountsPartial({
            ...withdrawAccounts(attacker.publicKey, attacker.publicKey),
            vaultState: Keypair.generate().publicKey,
          })
          .signers([attacker])
          .rpc(),
        "AccountNotInitialized",
      );

      // ...or is owned by the wrong program, which Anchor refuses to
      // deserialize as `VaultState`.
      await expectAnchorError(
        program.methods
          .withdraw(new BN(LAMPORTS_PER_SOL))
          .accountsPartial({
            ...withdrawAccounts(attacker.publicKey, attacker.publicKey),
            vaultState: attacker.publicKey,
          })
          .signers([attacker])
          .rpc(),
        "AccountOwnedByWrongProgram",
      );
    });

    it("rejects a zero amount", async () => {
      const player = await newFundedWallet(provider, LAMPORTS_PER_SOL);

      await expectAnchorError(
        program.methods
          .withdraw(new BN(0))
          .accountsPartial(withdrawAccounts(player.publicKey))
          .signers([player, admin])
          .rpc(),
        "InvalidAmount",
      );
    });

    it("rejects more than the pool's withdrawable balance", async () => {
      const player = await newFundedWallet(provider, LAMPORTS_PER_SOL);
      const withdrawable = (await balanceOf(provider, poolVault)) - rentReserve;

      await expectAnchorError(
        program.methods
          .withdraw(new BN(withdrawable + 1))
          .accountsPartial(withdrawAccounts(player.publicKey))
          .signers([player, admin])
          .rpc(),
        "InsufficientFunds",
      );
    });

    it("refuses to spend the rent reserve", async () => {
      const player = await newFundedWallet(provider, LAMPORTS_PER_SOL);
      const poolLamports = await balanceOf(provider, poolVault);

      await expectAnchorError(
        program.methods
          .withdraw(new BN(poolLamports))
          .accountsPartial(withdrawAccounts(player.publicKey))
          .signers([player, admin])
          .rpc(),
        "InsufficientFunds",
      );
    });
  });

  describe("cross-program invocation", () => {
    // Anchor's EventParser drops events emitted while another program is on
    // the call stack, so a CPI'd deposit would never be credited and a CPI'd
    // withdrawal would never settle its hold. The vault refuses both.

    it("rejects a deposit forwarded by another program", async () => {
      const player = await newFundedWallet(provider, 2 * LAMPORTS_PER_SOL);
      const poolBefore = await balanceOf(provider, poolVault);

      await expectAnchorError(
        probe.methods
          .forwardDeposit(new BN(LAMPORTS_PER_SOL))
          .accountsPartial({
            ...depositAccounts(player.publicKey),
            vaultProgram: program.programId,
          })
          .signers([player])
          .rpc(),
        "CpiNotAllowed",
      );
      assert.equal(await balanceOf(provider, poolVault), poolBefore);
    });

    it("rejects a withdrawal forwarded by another program", async () => {
      const player = await newFundedWallet(provider, LAMPORTS_PER_SOL);
      const poolBefore = await balanceOf(provider, poolVault);

      await expectAnchorError(
        probe.methods
          .forwardWithdraw(new BN(LAMPORTS_PER_SOL))
          .accountsPartial({
            ...withdrawAccounts(player.publicKey),
            vaultProgram: program.programId,
          })
          .signers([player, admin])
          .rpc(),
        "CpiNotAllowed",
      );
      assert.equal(await balanceOf(provider, poolVault), poolBefore);
    });

    it("still accepts the same deposit sent directly", async () => {
      const player = await newFundedWallet(provider, 2 * LAMPORTS_PER_SOL);
      const poolBefore = await balanceOf(provider, poolVault);
      await deposit(player, LAMPORTS_PER_SOL);
      assert.equal(
        await balanceOf(provider, poolVault),
        poolBefore + LAMPORTS_PER_SOL,
      );
    });
  });

  describe("set_paused", () => {
    it("rejects a pause attempt from anybody but the admin", async () => {
      const attacker = await newFundedWallet(provider, LAMPORTS_PER_SOL);

      await expectAnchorError(
        program.methods
          .setPaused(true)
          .accountsPartial({ admin: attacker.publicKey, vaultState })
          .signers([attacker])
          .rpc(),
        "Unauthorized",
      );

      const state = await program.account.vaultState.fetch(vaultState);
      assert.isFalse(state.paused);
    });

    it("stops both directions while paused and resumes afterwards", async () => {
      const player = await newFundedWallet(provider, 3 * LAMPORTS_PER_SOL);
      await deposit(player, LAMPORTS_PER_SOL);

      const pauseSignature = await setPaused(true);
      try {
        const pauseEvent = expectEvent(
          await getTxDetails(program, provider, pauseSignature),
          "pauseStateChangedEvent",
        );
        assert.isTrue(pauseEvent.admin.equals(admin.publicKey));
        assert.isTrue(pauseEvent.paused);
        assert.isTrue(
          (await program.account.vaultState.fetch(vaultState)).paused,
        );

        await expectAnchorError(
          deposit(player, LAMPORTS_PER_SOL),
          "VaultPaused",
        );
        await expectAnchorError(
          withdraw(player, LAMPORTS_PER_SOL),
          "VaultPaused",
        );
      } finally {
        const resumeSignature = await setPaused(false);
        const resumeEvent = expectEvent(
          await getTxDetails(program, provider, resumeSignature),
          "pauseStateChangedEvent",
        );
        assert.isFalse(resumeEvent.paused);
      }

      assert.isFalse(
        (await program.account.vaultState.fetch(vaultState)).paused,
      );

      // Both directions work again once resumed.
      const poolBefore = await balanceOf(provider, poolVault);
      await deposit(player, LAMPORTS_PER_SOL);
      await withdraw(player, LAMPORTS_PER_SOL);
      assert.equal(await balanceOf(provider, poolVault), poolBefore);
    });
  });

  describe("backend listener", () => {
    it("ignores the DepositEvent left in the logs of a failed transaction", async () => {
      // [deposit(1 SOL), transfer that cannot succeed]: the whole transaction
      // reverts, yet the deposit's event is already in the logs. A listener
      // that does not check `meta.err` would credit 1 SOL for a fee.
      const attacker = await newFundedWallet(provider, 2 * LAMPORTS_PER_SOL);
      const poolBefore = await balanceOf(provider, poolVault);

      const depositIx = await program.methods
        .deposit(new BN(LAMPORTS_PER_SOL))
        .accountsPartial(depositAccounts(attacker.publicKey))
        .instruction();
      const failingIx = SystemProgram.transfer({
        fromPubkey: attacker.publicKey,
        toPubkey: provider.wallet.publicKey,
        lamports: 5 * LAMPORTS_PER_SOL,
      });

      const tx = new Transaction().add(depositIx, failingIx);
      const latest = await connection.getLatestBlockhash("confirmed");
      tx.feePayer = attacker.publicKey;
      tx.recentBlockhash = latest.blockhash;
      tx.sign(attacker);
      const signature = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: true,
      });
      await connection.confirmTransaction(
        { signature, ...latest },
        "confirmed",
      );

      const raw = await connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      assert.isNotNull(raw!.meta!.err, "the transaction must have failed");
      const parser = new anchor.EventParser(program.programId, program.coder);
      assert.lengthOf(
        [...parser.parseLogs(raw!.meta!.logMessages!)],
        1,
        "the raw logs do carry a DepositEvent",
      );

      const details = await getTxDetails(program, provider, signature);
      assert.isNotNull(details.err);
      assert.lengthOf(
        details.events,
        0,
        "a failed transaction yields no events",
      );
      assert.equal(
        await balanceOf(provider, poolVault),
        poolBefore,
        "no lamports moved",
      );
    });

    it("delivers DepositEvent over the websocket subscription", async () => {
      const player = await newFundedWallet(provider, 3 * LAMPORTS_PER_SOL);
      const amount = LAMPORTS_PER_SOL;
      const poolBefore = await balanceOf(provider, poolVault);

      const received = new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("no DepositEvent received within 30s")),
          30_000,
        );
        const listener = program.addEventListener(
          "depositEvent",
          (event: any) => {
            if (!event.user.equals(player.publicKey)) return;
            clearTimeout(timeout);
            void program.removeEventListener(listener);
            resolve(event);
          },
        );
      });

      await deposit(player, amount);

      const event = await received;
      assert.equal(event.amount.toNumber(), amount);
      assert.equal(
        event.vaultBalance.toNumber(),
        poolBefore + amount,
        "the event carries the pool balance the backend reconciles against",
      );
    });
  });
});
