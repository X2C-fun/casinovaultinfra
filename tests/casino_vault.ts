/**
 * Integration tests for the pooled casino vault.
 *
 * They cover the happy path of every instruction plus the security properties
 * the program must guarantee: only the upgrade authority can initialize, set
 * caps or rotate the admin; funds only leave the pool with the admin's
 * approval, can only go to the signing user and respect the caps; the pool
 * never drops below its rent reserve; forged state accounts are rejected; and
 * the pause switch stops both directions.
 *
 * The state and pool PDAs are singletons, so the suite initializes the program
 * exactly once and requires a fresh validator (`anchor test` resets the ledger).
 * `Anchor.toml` sets `[test] upgradeable = true`, which makes the provider
 * wallet the program's upgrade authority.
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
  const connection = provider.connection;

  /** Upgrade authority: the provider wallet that deployed the program. */
  const authority = provider.wallet.publicKey;

  /** Backend authority. Replaced by the admin-rotation tests at the end. */
  let admin = Keypair.generate();

  let vaultState: PublicKey;
  let poolVault: PublicKey;
  let poolVaultBump: number;

  /** Lamports permanently reserved in the pool to keep it rent exempt. */
  let rentReserve: number;

  let nextRequestId = 1;
  /** Fresh backend withdrawal ID, as a real backend would allocate. */
  function requestId(): BN {
    return new BN(nextRequestId++);
  }

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
  async function withdraw(
    wallet: Keypair,
    lamports: number,
    id: BN = requestId(),
    approver: Keypair = admin,
  ): Promise<string> {
    return program.methods
      .withdraw(new BN(lamports), id)
      .accountsPartial(withdrawAccounts(wallet.publicKey, approver.publicKey))
      .signers([wallet, approver])
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

  /** Sets the withdrawal caps as the upgrade authority. */
  async function setLimits(
    perTx: number,
    perWindow: number,
    windowSeconds: number,
  ): Promise<string> {
    return program.methods
      .setLimits(new BN(perTx), new BN(perWindow), windowSeconds)
      .accountsPartial({ authority, vaultState })
      .rpc({ commitment: "confirmed" });
  }

  before(async () => {
    // The provider wallet funds every player and pays the fees.
    await airdrop(provider, provider.wallet.publicKey, 100 * LAMPORTS_PER_SOL);

    [vaultState] = deriveVaultStatePda(program.programId);
    [poolVault, poolVaultBump] = derivePoolVaultPda(program.programId);

    rentReserve = await connection.getMinimumBalanceForRentExemption(0);

    await fund(provider, admin.publicKey, LAMPORTS_PER_SOL);
  });

  describe("initialize", () => {
    it("rejects a signer that is not the upgrade authority", async () => {
      const intruder = await newFundedWallet(provider, LAMPORTS_PER_SOL);

      await expectAnchorError(
        program.methods
          .initialize()
          .accountsPartial({
            authority: intruder.publicKey,
            admin: intruder.publicKey,
            vaultState,
            poolVault,
            systemProgram: SystemProgram.programId,
          })
          .signers([intruder])
          .rpc(),
        "NotUpgradeAuthority",
      );
    });

    it("requires the admin signature", async () => {
      await expectFailure(
        program.methods
          .initialize()
          .accountsPartial({
            authority,
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
          authority,
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
      assert.isNull(state.pendingAdmin);
      assert.equal(state.maxWithdrawPerTx.toNumber(), 0);
      assert.equal(state.maxWithdrawPerWindow.toNumber(), 0);
      assert.equal(state.windowSeconds, 0);

      const stateInfo = await connection.getAccountInfo(vaultState);
      assert.equal(stateInfo!.data.length, VAULT_STATE_SIZE);

      // The pool must stay a data-less system account so the System Program can
      // move lamports out of it under its seed.
      const poolInfo = await connection.getAccountInfo(poolVault, "confirmed");
      assert.isNotNull(poolInfo);
      assert.equal(poolInfo!.lamports, rentReserve);
      assert.equal(poolInfo!.data.length, 0);
      assert.isTrue(poolInfo!.owner.equals(SystemProgram.programId));

      // The upgrade authority pays all rent; the admin only signs.
      assert.equal(await balanceOf(provider, admin.publicKey), adminBefore);

      const event = expectEvent(
        await getTxDetails(program, provider, signature),
        "vaultInitializedEvent",
      );
      assert.isTrue(event.authority.equals(authority));
      assert.isTrue(event.admin.equals(admin.publicKey));
      assert.equal(event.vaultBump, poolVaultBump);
      assert.equal(event.rentReserve.toNumber(), rentReserve);
      assert.equal(event.vaultBalance.toNumber(), rentReserve);
      assert.isAbove(event.timestamp.toNumber(), 0);
    });

    it("cannot be run a second time", async () => {
      const other = await newFundedWallet(provider, LAMPORTS_PER_SOL);

      await expectFailure(
        program.methods
          .initialize()
          .accountsPartial({
            authority,
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
        "the original admin must survive a second initialize",
      );
    });
  });

  describe("deposit", () => {
    it("moves SOL into the pool and emits DepositEvent via log and CPI", async () => {
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

      const details = await getTxDetails(program, provider, signature);
      for (const source of ["events", "cpiEvents"] as const) {
        const event = expectEvent(details, "depositEvent", source);
        assert.isTrue(event.user.equals(player.publicKey));
        assert.equal(event.amount.toNumber(), amount);
        assert.equal(event.vaultBalance.toNumber(), poolBefore + amount);
        assert.isAbove(event.timestamp.toNumber(), 0);
      }
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

    it("releases SOL to the user and echoes request_id in both events", async () => {
      const player = await newFundedWallet(provider, 3 * LAMPORTS_PER_SOL);
      await deposit(player, 2 * LAMPORTS_PER_SOL);

      const amount = LAMPORTS_PER_SOL;
      const id = new BN("18446744073709551615");
      const playerBefore = await balanceOf(provider, player.publicKey);
      const poolBefore = await balanceOf(provider, poolVault);

      const signature = await withdraw(player, amount, id);

      assert.equal(
        await balanceOf(provider, player.publicKey),
        playerBefore + amount,
      );
      assert.equal(await balanceOf(provider, poolVault), poolBefore - amount);

      const details = await getTxDetails(program, provider, signature);
      for (const source of ["events", "cpiEvents"] as const) {
        const event = expectEvent(details, "withdrawEvent", source);
        assert.isTrue(event.user.equals(player.publicKey));
        assert.isTrue(event.admin.equals(admin.publicKey));
        assert.isTrue(event.requestId.eq(id), "u64::MAX request_id survives");
        assert.equal(event.amount.toNumber(), amount);
        assert.equal(event.vaultBalance.toNumber(), poolBefore - amount);
      }
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
        .withdraw(new BN(amount), requestId())
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
          .withdraw(new BN(LAMPORTS_PER_SOL), requestId())
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
          .withdraw(new BN(LAMPORTS_PER_SOL), requestId())
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
        withdraw(player, LAMPORTS_PER_SOL, requestId(), rogueAdmin),
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
          .withdraw(new BN(LAMPORTS_PER_SOL), requestId())
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
          .withdraw(new BN(LAMPORTS_PER_SOL), requestId())
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

      await expectAnchorError(withdraw(player, 0), "InvalidAmount");
    });

    it("rejects more than the pool's withdrawable balance", async () => {
      const player = await newFundedWallet(provider, LAMPORTS_PER_SOL);
      const withdrawable = (await balanceOf(provider, poolVault)) - rentReserve;

      await expectAnchorError(
        withdraw(player, withdrawable + 1),
        "InsufficientFunds",
      );
    });

    it("refuses to spend the rent reserve", async () => {
      const player = await newFundedWallet(provider, LAMPORTS_PER_SOL);
      const poolLamports = await balanceOf(provider, poolVault);

      await expectAnchorError(
        withdraw(player, poolLamports),
        "InsufficientFunds",
      );
    });
  });

  describe("set_limits", () => {
    afterEach(async () => {
      await setLimits(0, 0, 0);
    });

    it("rejects the admin and any other non-authority signer", async () => {
      for (const signer of [admin, Keypair.generate()]) {
        await expectAnchorError(
          program.methods
            .setLimits(new BN(1), new BN(0), 0)
            .accountsPartial({ authority: signer.publicKey, vaultState })
            .signers([signer])
            .rpc(),
          "NotUpgradeAuthority",
        );
      }
    });

    it("rejects a window cap without a window length and vice versa", async () => {
      await expectAnchorError(
        setLimits(0, LAMPORTS_PER_SOL, 0),
        "InvalidLimits",
      );
      await expectAnchorError(setLimits(0, 0, 60), "InvalidLimits");
    });

    it("enforces the per-transaction cap", async () => {
      const signature = await setLimits(LAMPORTS_PER_SOL, 0, 0);
      const event = expectEvent(
        await getTxDetails(program, provider, signature),
        "limitsUpdatedEvent",
      );
      assert.isTrue(event.authority.equals(authority));
      assert.equal(event.maxWithdrawPerTx.toNumber(), LAMPORTS_PER_SOL);

      const player = await newFundedWallet(provider, LAMPORTS_PER_SOL);
      await withdraw(player, LAMPORTS_PER_SOL);
      await expectAnchorError(
        withdraw(player, LAMPORTS_PER_SOL + 1),
        "WithdrawLimitExceeded",
      );
    });

    it("enforces the per-window cap across withdrawals", async () => {
      await setLimits(0, 2 * LAMPORTS_PER_SOL, 3600);
      const player = await newFundedWallet(provider, LAMPORTS_PER_SOL);

      await withdraw(player, 1.5 * LAMPORTS_PER_SOL);
      await expectAnchorError(
        withdraw(player, LAMPORTS_PER_SOL),
        "WindowLimitExceeded",
      );
      await withdraw(player, 0.5 * LAMPORTS_PER_SOL);

      const state = await program.account.vaultState.fetch(vaultState);
      assert.equal(state.windowWithdrawn.toNumber(), 2 * LAMPORTS_PER_SOL);
      assert.equal(state.windowSeconds, 3600);
    });

    it("applies to house withdrawals too", async () => {
      await setLimits(LAMPORTS_PER_SOL, 0, 0);

      await expectAnchorError(
        program.methods
          .withdraw(new BN(2 * LAMPORTS_PER_SOL), requestId())
          .accountsPartial(withdrawAccounts(admin.publicKey))
          .signers([admin])
          .rpc(),
        "WithdrawLimitExceeded",
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

  describe("admin rotation", () => {
    /** Proposes `next` (or cancels with `null`) as the upgrade authority. */
    async function propose(next: PublicKey | null): Promise<string> {
      return program.methods
        .proposeAdmin(next)
        .accountsPartial({ authority, vaultState })
        .rpc({ commitment: "confirmed" });
    }

    /** Accepts the pending admin role as `signer`. */
    async function accept(signer: Keypair): Promise<string> {
      return program.methods
        .acceptAdmin()
        .accountsPartial({ newAdmin: signer.publicKey, vaultState })
        .signers([signer])
        .rpc({ commitment: "confirmed" });
    }

    it("rejects acceptance when nothing is pending", async () => {
      await expectAnchorError(accept(Keypair.generate()), "NotPendingAdmin");
    });

    it("rejects proposals from the admin or any other non-authority", async () => {
      for (const signer of [admin, Keypair.generate()]) {
        await expectAnchorError(
          program.methods
            .proposeAdmin(signer.publicKey)
            .accountsPartial({ authority: signer.publicKey, vaultState })
            .signers([signer])
            .rpc(),
          "NotUpgradeAuthority",
        );
      }
    });

    it("rejects the default public key", async () => {
      await expectAnchorError(propose(PublicKey.default), "InvalidAdmin");
    });

    it("keeps the current admin until the proposal is accepted, and can cancel", async () => {
      const candidate = Keypair.generate();
      const signature = await propose(candidate.publicKey);

      const event = expectEvent(
        await getTxDetails(program, provider, signature),
        "adminProposedEvent",
      );
      assert.isTrue(event.authority.equals(authority));
      assert.isTrue(event.currentAdmin.equals(admin.publicKey));
      assert.isTrue(event.pendingAdmin.equals(candidate.publicKey));

      let state = await program.account.vaultState.fetch(vaultState);
      assert.isTrue(state.admin.equals(admin.publicKey));
      assert.isTrue(state.pendingAdmin!.equals(candidate.publicKey));

      // The current admin still approves withdrawals while a proposal is open.
      const player = await newFundedWallet(provider, LAMPORTS_PER_SOL);
      await withdraw(player, LAMPORTS_PER_SOL / 10);

      // Only the proposed key may accept.
      await expectAnchorError(accept(Keypair.generate()), "NotPendingAdmin");

      await propose(null);
      state = await program.account.vaultState.fetch(vaultState);
      assert.isNull(state.pendingAdmin);
      await expectAnchorError(accept(candidate), "NotPendingAdmin");
    });

    it("rotates the admin; the old key loses withdraw and pause rights", async () => {
      const oldAdmin = admin;
      const newAdmin = Keypair.generate();
      await fund(provider, newAdmin.publicKey, LAMPORTS_PER_SOL);

      await propose(newAdmin.publicKey);
      const signature = await accept(newAdmin);

      const event = expectEvent(
        await getTxDetails(program, provider, signature),
        "adminChangedEvent",
      );
      assert.isTrue(event.previousAdmin.equals(oldAdmin.publicKey));
      assert.isTrue(event.newAdmin.equals(newAdmin.publicKey));

      const state = await program.account.vaultState.fetch(vaultState);
      assert.isTrue(state.admin.equals(newAdmin.publicKey));
      assert.isNull(state.pendingAdmin);

      const player = await newFundedWallet(provider, LAMPORTS_PER_SOL);
      await expectAnchorError(
        withdraw(player, LAMPORTS_PER_SOL / 10, requestId(), oldAdmin),
        "Unauthorized",
      );
      await expectAnchorError(
        program.methods
          .setPaused(true)
          .accountsPartial({ admin: oldAdmin.publicKey, vaultState })
          .signers([oldAdmin])
          .rpc(),
        "Unauthorized",
      );

      admin = newAdmin;
      await withdraw(player, LAMPORTS_PER_SOL / 10);
    });

    it("recovers from a leaked admin in a single transaction", async () => {
      const replacement = Keypair.generate();

      const tx = new Transaction().add(
        await program.methods
          .proposeAdmin(replacement.publicKey)
          .accountsPartial({ authority, vaultState })
          .instruction(),
        await program.methods
          .acceptAdmin()
          .accountsPartial({ newAdmin: replacement.publicKey, vaultState })
          .instruction(),
      );
      await provider.sendAndConfirm(tx, [replacement], {
        commitment: "confirmed",
      });

      const state = await program.account.vaultState.fetch(vaultState);
      assert.isTrue(state.admin.equals(replacement.publicKey));
      admin = replacement;
    });
  });

  describe("backend listener", () => {
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
