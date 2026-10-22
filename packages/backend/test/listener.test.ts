import { describe, it, expect, vi } from "vitest";
import type { ConfirmedSignatureInfo, PublicKey } from "@solana/web3.js";
import type { Ledger, LedgerOptions } from "../src/ledger/types";
import {
  collectNewSignatures,
  ListenerConfigError,
  ListenerLeaseError,
  MAX_PAGES_PER_SCAN,
  pollOnce,
  runListener,
  type ListenerConnection,
  type ListenerDeps,
} from "../src/listener/listener";
import { ledgerLiabilities } from "../src/services/solvency";
import { FakeConnection, LEDGERS, addr, fakeTx } from "./helpers";

const deposit = (c: FakeConnection, sig: string, slot: number, user: PublicKey, amount = 1n) =>
  c.add(sig, slot, fakeTx(PROGRAM_ID, sig, slot, [{ kind: "deposit", user, amount }]));

const PROGRAM_ID = addr();
const ADMIN = addr();

function setup(
  make: (o?: LedgerOptions) => Ledger,
  over: Partial<ListenerDeps> = {},
  opts: { anchor?: boolean } = {},
) {
  const connection = new FakeConnection();
  // The upgrade transaction at UPGRADE_SLOT (0): a no-cursor scan must
  // positively reach it before it trusts an empty history.
  // An older "deploy" transaction too: a cursor at the upgrade slot is only
  // provably complete when a response also lists something older.
  if (opts.anchor !== false) {
    connection.add("deploy", -1, fakeTx(PROGRAM_ID, "deploy", -1, []));
    connection.add("upgrade0", 0, fakeTx(PROGRAM_ID, "upgrade0", 0, []));
  }
  const ledger = make({ adminKey: ADMIN.toBase58() });
  let paused = false;
  const deps: ListenerDeps = {
    connection,
    ledger,
    programId: PROGRAM_ID,
    pageSize: 200,
    releaseSafetyBlocks: 150,
    upgradeSlot: 0, // the "no cursor" start point required by assertListenerCanStart
    pauseVault: vi.fn(async () => {
      paused = true;
      return "pausesig";
    }),
    isVaultPaused: vi.fn(async () => paused),
    alert: vi.fn(),
    log: () => {},
    ...over,
  };
  return { connection, ledger, deps };
}

describe.each(LEDGERS)("listener (%s)", (_name, make) => {
  it("pages backwards through >1 page and processes all oldest-first", async () => {
    const { connection, ledger, deps } = setup(make);
    const user = addr();
    for (let i = 0; i < 450; i++) {
      const sig = `sig${i}`;
      connection.add(sig, 1000 + i, fakeTx(PROGRAM_ID, sig, 1000 + i, [{ kind: "deposit", user, amount: 1n }]));
    }
    const r = await pollOnce(deps);
    expect(r.drained).toBe(true);
    expect(r.processed).toBe(450);
    expect(connection.sigCalls).toBeGreaterThanOrEqual(3); // 200 + 200 + 50 (+ empty)
    expect(connection.txCalls).toEqual(Array.from({ length: 450 }, (_, i) => `sig${i}`));
    expect(ledger.getBalance(user.toBase58()).available).toBe(450n);
    expect(ledger.getProgress()).toMatchObject({ cursor: "sig449", slot: 1449 });

    // Next cycle: only new signatures are fetched.
    connection.add("sig450", 2000, fakeTx(PROGRAM_ID, "sig450", 2000, [{ kind: "deposit", user, amount: 1n }]));
    connection.txCalls = [];
    const r2 = await pollOnce(deps);
    expect(connection.txCalls).toEqual(["sig450"]);
    expect(r2.processed).toBe(1);
    expect(ledger.getBalance(user.toBase58()).available).toBe(451n);
  });

  it("stops without advancing the cursor when getTransaction returns null, then resumes", async () => {
    const { connection, ledger, deps } = setup(make);
    const user = addr();
    connection.add("a", 1, fakeTx(PROGRAM_ID, "a", 1, [{ kind: "deposit", user, amount: 5n }]));
    connection.add("b", 2, null); // RPC has not got it yet
    connection.add("c", 3, fakeTx(PROGRAM_ID, "c", 3, [{ kind: "deposit", user, amount: 7n }]));

    const r = await pollOnce(deps);
    expect(r.drained).toBe(false);
    expect(r.stoppedAt).toBe("b");
    expect(ledger.getCursor()).toBe("a");
    expect(ledger.getBalance(user.toBase58()).available).toBe(5n); // c not applied
    expect(ledger.getProgress().drainedThroughBlockHeight).toBeNull();

    connection.txs.set("b", fakeTx(PROGRAM_ID, "b", 2, [{ kind: "deposit", user, amount: 1n }]));
    const r2 = await pollOnce(deps);
    expect(r2.drained).toBe(true);
    expect(ledger.getCursor()).toBe("c");
    expect(ledger.getBalance(user.toBase58()).available).toBe(13n);
  });

  it("skips failed transactions (signature err and meta.err) without crediting", async () => {
    const { connection, ledger, deps } = setup(make);
    const user = addr();
    // Failed per the signature list: never even fetched.
    connection.add("f1", 1, fakeTx(PROGRAM_ID, "f1", 1, [{ kind: "deposit", user, amount: 100n }], { err: { x: 1 } }), { x: 1 });
    // Failed per meta.err only: fetched, decoder returns [].
    connection.add("f2", 2, fakeTx(PROGRAM_ID, "f2", 2, [{ kind: "deposit", user, amount: 100n }], { err: { InstructionError: [1, "Custom"] } }));
    connection.add("ok", 3, fakeTx(PROGRAM_ID, "ok", 3, [{ kind: "deposit", user, amount: 1n }]));
    const r = await pollOnce(deps);
    expect(r.drained).toBe(true);
    expect(connection.txCalls).toEqual(["f2", "ok"]);
    expect(ledger.getBalance(user.toBase58()).available).toBe(1n);
    expect(ledger.getCursor()).toBe("ok");
  });

  it("settles withdrawals from emit_cpi events and pauses on an unmatched one", async () => {
    const { connection, ledger, deps } = setup(make);
    const user = addr();
    connection.add("dep", 1, fakeTx(PROGRAM_ID, "dep", 1, [{ kind: "deposit", user, amount: 1000n }]));
    await pollOnce(deps);
    const hold = ledger.placeHold({
      ownerKey: user.toBase58(),
      amount: 400n,
      destination: user.toBase58(),
      lastValidBlockHeight: 900,
    });
    connection.add("w", 2, fakeTx(PROGRAM_ID, "w", 2, [{ kind: "withdraw", user, admin: ADMIN, requestId: hold.requestId, amount: 400n }]));
    connection.add("evil", 3, fakeTx(PROGRAM_ID, "evil", 3, [{ kind: "withdraw", user: addr(), admin: ADMIN, requestId: 77n, amount: 5n }]));
    await pollOnce(deps);
    expect(ledger.getHold(hold.requestId)?.status).toBe("settled");
    expect(ledger.getBalance(user.toBase58())).toMatchObject({ available: 600n, pending: 0n });
    expect(ledger.getIncident()).not.toBeNull();
    expect(deps.pauseVault).toHaveBeenCalledTimes(1);
  });

  it("retries the pause every cycle until the vault reads paused", async () => {
    let failures = 2;
    let paused = false;
    const pauseVault = vi.fn(async () => {
      if (failures-- > 0) throw new Error("rpc down");
      paused = true;
      return "ok";
    });
    const { ledger, deps } = setup(make, { pauseVault, isVaultPaused: async () => paused });
    ledger.openIncident("pre-existing");
    await pollOnce(deps);
    await pollOnce(deps);
    expect(paused).toBe(false);
    await pollOnce(deps);
    expect(paused).toBe(true);
    await pollOnce(deps);
    expect(pauseVault).toHaveBeenCalledTimes(3); // not called once paused
    expect(ledger.getIncident()).not.toBeNull(); // only an operator clears it
  });

  it("an undecodable (v0.1-layout) event opens the incident and is skipped, not looped on", async () => {
    const { connection, ledger, deps } = setup(make);
    const user = addr();
    connection.add("old", 1, fakeTx(PROGRAM_ID, "old", 1, [{ kind: "garbage" }]));
    connection.add("new", 2, fakeTx(PROGRAM_ID, "new", 2, [{ kind: "deposit", user, amount: 3n }]));
    const r = await pollOnce(deps);
    expect(r.drained).toBe(true);
    expect(ledger.getIncident()?.reason).toMatch(/undecodable/);
    expect(ledger.listIncidents()[0].detail).toContain("old");
    expect(ledger.getCursor()).toBe("new");
    expect(ledger.getBalance(user.toBase58()).available).toBe(3n);
    expect(deps.alert).toHaveBeenCalled();
    connection.txCalls = [];
    await pollOnce(deps);
    expect(connection.txCalls).toEqual([]); // not re-fetched
  });

  it("UPGRADE_SLOT / START_AFTER_SIGNATURE skip v0.1-era history", async () => {
    const user = addr();
    const a = setup(make, { upgradeSlot: 10 });
    a.connection.add("v1", 5, fakeTx(PROGRAM_ID, "v1", 5, [{ kind: "garbage" }]));
    a.connection.add("upgrade", 10, fakeTx(PROGRAM_ID, "upgrade", 10, []));
    a.connection.add("v2", 11, fakeTx(PROGRAM_ID, "v2", 11, [{ kind: "deposit", user, amount: 9n }]));
    await pollOnce(a.deps);
    expect(a.ledger.getIncident()).toBeNull();
    expect(a.connection.txCalls).toEqual(["v2"]);
    expect(a.ledger.getBalance(user.toBase58()).available).toBe(9n);

    const b = setup(make, { startAfterSignature: "upgrade", upgradeSlot: undefined });
    b.connection.add("v1", 5, fakeTx(PROGRAM_ID, "v1", 5, [{ kind: "garbage" }]));
    b.connection.add("upgrade", 10, fakeTx(PROGRAM_ID, "upgrade", 10, []));
    b.connection.add("v2", 11, fakeTx(PROGRAM_ID, "v2", 11, [{ kind: "deposit", user, amount: 9n }]));
    await pollOnce(b.deps);
    // "upgrade" is fetched once only to learn its slot (the paging floor).
    expect(b.connection.txCalls).toEqual(["upgrade", "v2"]);
    expect(b.ledger.getIncident()).toBeNull();
  });

  it("releases an expired hold only after a full drain AND tip > lastValidBlockHeight + margin", async () => {
    const { connection, ledger, deps } = setup(make);
    const user = addr().toBase58();
    ledger.credit(user, 1000n, "seed");
    const hold = ledger.placeHold({ ownerKey: user, amount: 100n, destination: user, lastValidBlockHeight: 1000 });

    // Tip not past the margin yet: no release even though drained.
    connection.blockHeight = 1150;
    let r = await pollOnce(deps);
    expect(r.drained).toBe(true);
    expect(r.released).toBe(0);

    // Tip past the margin, but the drain stops at a missing transaction: no release.
    connection.blockHeight = 1151;
    connection.add("missing", 5, null);
    r = await pollOnce(deps);
    expect(r.drained).toBe(false);
    expect(r.released).toBe(0);
    expect(ledger.getHold(hold.requestId)?.status).toBe("open");

    // Drained and past the margin: released.
    connection.txs.set("missing", fakeTx(PROGRAM_ID, "missing", 5, []));
    r = await pollOnce(deps);
    expect(r.drained).toBe(true);
    expect(r.released).toBe(1);
    expect(ledger.getBalance(user)).toMatchObject({ available: 1000n, pending: 0n });
    expect(ledger.getProgress().drainedThroughBlockHeight).toBe(1151);
  });

  it("uses the block height measured BEFORE the drain for release", async () => {
    const { connection, ledger, deps } = setup(make);
    const user = addr().toBase58();
    ledger.credit(user, 1000n, "seed");
    ledger.placeHold({ ownerKey: user, amount: 100n, destination: user, lastValidBlockHeight: 1000 });
    connection.blockHeight = 1100;
    // The tip moves during the drain; the old pre-drain value must be used.
    const orig = connection.getSignaturesForAddress.bind(connection);
    connection.getSignaturesForAddress = async (...args) => {
      connection.blockHeight = 5000;
      return orig(...args);
    };
    const r = await pollOnce(deps);
    expect(r.tipBefore).toBe(1100);
    expect(r.released).toBe(0);
  });

  it("refuses to start with no cursor, START_AFTER_SIGNATURE or UPGRADE_SLOT", async () => {
    const { deps } = setup(make, { upgradeSlot: undefined });
    await expect(pollOnce(deps)).rejects.toBeInstanceOf(ListenerConfigError);
    await expect(runListener(deps)).rejects.toThrow(/START_AFTER_SIGNATURE/);
  });

  it("an unknown/pruned cursor halts (no rescan of history), and only a persistent miss opens an incident", async () => {
    const { connection, ledger, deps } = setup(make, { notFoundIncidentCycles: 2 });
    const user = addr();
    // History the RPC still has: slots 100..599. The stored cursor ("ghost",
    // slot 500) is not in it.
    for (let i = 100; i < 600; i++) {
      connection.add(`s${i}`, i, fakeTx(PROGRAM_ID, `s${i}`, i, [{ kind: "deposit", user, amount: 1n }]));
    }
    ledger.setCursor("ghost", 500);
    const r = await pollOnce(deps);
    expect(r.halted).toBe("cursor_not_found");
    expect(r.drained).toBe(false);
    expect(connection.txCalls).toEqual([]); // nothing processed
    expect(connection.sigCalls).toBe(1); // stopped at the first page below the floor
    expect(ledger.getCursor()).toBe("ghost");
    expect(ledger.getBalance(user.toBase58()).available).toBe(0n);
    expect(ledger.getIncident()).toBeNull(); // one miss: halt only
    expect((await pollOnce(deps)).halted).toBe("cursor_not_found");
    expect(ledger.getIncident()?.reason).toMatch(/cursor not found/);
    expect(deps.alert).toHaveBeenCalled();
  });

  it("a START_AFTER_SIGNATURE the RPC cannot find halts with an alert", async () => {
    const { connection, ledger, deps } = setup(make, { startAfterSignature: "nope", upgradeSlot: undefined });
    connection.add("x", 5, fakeTx(PROGRAM_ID, "x", 5, [{ kind: "deposit", user: addr(), amount: 1n }]));
    connection.txs.delete("nope");
    const r = await pollOnce(deps);
    expect(r.halted).toBe("start_not_found");
    expect(ledger.getCursor()).toBeNull();
    expect(deps.alert).toHaveBeenCalled();
  });

  it("stops and alerts when the backlog exceeds the cap on first start (no cursor)", async () => {
    const { connection, ledger, deps } = setup(make, { maxBacklog: 100 });
    const user = addr();
    for (let i = 1; i <= 450; i++) {
      connection.add(`b${i}`, i, fakeTx(PROGRAM_ID, `b${i}`, i, [{ kind: "deposit", user, amount: 1n }]));
    }
    const r = await pollOnce(deps);
    expect(r.halted).toBe("backlog_exceeded");
    expect(connection.txCalls).toEqual([]);
    expect(ledger.getCursor()).toBeNull();
    expect(connection.sigCalls).toBe(1); // 200 > 100 after the first page
    expect(deps.alert).toHaveBeenCalledWith(expect.stringMatching(/backlog/), expect.anything());
    expect(ledger.getIncident()).toBeNull();
  });

  it("alerts after N consecutive cycles stuck on the same missing transaction", async () => {
    const { connection, deps } = setup(make, { stuckAlertCycles: 3 });
    connection.add("gone", 1, null);
    const stuckAlerts = () =>
      (deps.alert as ReturnType<typeof vi.fn>).mock.calls.filter(([m]) => /stuck/.test(m)).length;
    await pollOnce(deps);
    await pollOnce(deps);
    expect(stuckAlerts()).toBe(0);
    await pollOnce(deps);
    expect(stuckAlerts()).toBe(1);
    await pollOnce(deps);
    await pollOnce(deps);
    await pollOnce(deps);
    expect(stuckAlerts()).toBe(2);
  });

  it("does not release expired holds while an incident is open", async () => {
    const { connection, ledger, deps } = setup(make);
    const user = addr().toBase58();
    ledger.credit(user, 1000n, "seed");
    const hold = ledger.placeHold({ ownerKey: user, amount: 100n, destination: user, lastValidBlockHeight: 10 });
    ledger.openIncident("leak");
    connection.blockHeight = 10_000;
    const r = await pollOnce(deps);
    expect(r.drained).toBe(true);
    expect(r.released).toBe(0);
    expect(ledger.getHold(hold.requestId)?.status).toBe("open");
    ledger.clearIncident();
    expect((await pollOnce(deps)).released).toBe(1);
  });

  it("only one listener per ledger: the lease blocks a second holder until it expires", async () => {
    const { connection, ledger, deps } = setup(make, { leaseHolder: "A", leaseTtlMs: 60_000 });
    const user = addr();
    connection.add("t1", 1, fakeTx(PROGRAM_ID, "t1", 1, [{ kind: "deposit", user, amount: 1n }]));
    expect((await pollOnce(deps)).processed).toBe(1);

    const other: ListenerDeps = { ...deps, leaseHolder: "B" };
    connection.add("t2", 2, fakeTx(PROGRAM_ID, "t2", 2, [{ kind: "deposit", user, amount: 1n }]));
    const r = await pollOnce(other);
    expect(r.halted).toBe("lease_held");
    expect(ledger.getBalance(user.toBase58()).available).toBe(1n);
    await expect(runListener(other)).rejects.toBeInstanceOf(ListenerLeaseError);

    // Expired lease can be taken over; A then loses it.
    expect(ledger.acquireListenerLease("B", 60_000, Date.now() + 61_000)).toBe(true);
    expect(ledger.acquireListenerLease("A", 60_000)).toBe(false);
    ledger.releaseListenerLease("B");
    expect(ledger.acquireListenerLease("A", 60_000)).toBe(true);
  });

  // --- H1 / NEW-2: the scan must positively reach the cursor ---------------------

  it("pruned history (only newer sigs, then an empty page) → halt, no release; incident only when persistent", async () => {
    const { connection, ledger, deps } = setup(make, { notFoundIncidentCycles: 3 }, { anchor: false });
    const user = addr();
    const player = addr().toBase58();
    ledger.credit(player, 1000n, "seed");
    const hold = ledger.placeHold({ ownerKey: player, amount: 400n, destination: player, lastValidBlockHeight: 10 });
    // The cursor (slot 50) and the withdraw that settled the hold (slot 60)
    // are both gone from this node; it only has slots 100..109.
    ledger.setCursor("c50", 50);
    for (let i = 100; i < 110; i++) deposit(connection, `n${i}`, i, user);
    connection.blockHeight = 10_000;
    for (let cycle = 1; cycle <= 3; cycle++) {
      const r = await pollOnce(deps);
      expect(r.halted).toBe("cursor_not_found");
      expect(r.drained).toBe(false);
      expect(r.released).toBe(0);
      // A flaky/pruned node alone does not pause the vault...
      expect(ledger.getIncident() === null).toBe(cycle < 3);
    }
    // ...only the third consecutive miss does.
    expect(ledger.getIncident()?.reason).toMatch(/cursor not found/);
    expect(deps.pauseVault).toHaveBeenCalledTimes(1);
    expect(ledger.getHold(hold.requestId)?.status).toBe("open");
    expect(ledger.getBalance(player)).toMatchObject({ available: 600n, pending: 400n });
    expect(connection.txCalls).toEqual([]);
    expect(ledger.getCursor()).toBe("c50");
  });

  it("an empty listing with a stored cursor → cursor_not_found (not 'nothing new')", async () => {
    const { connection, ledger, deps } = setup(make, {}, { anchor: false });
    ledger.setCursor("c50", 50);
    const r = await pollOnce(deps);
    expect(r.halted).toBe("cursor_not_found");
    expect(connection.sigCalls).toBe(1);
    expect(ledger.getIncident()).toBeNull();
  });

  it("one empty page from a flaky node halts the cycle without an incident; the next cycle proceeds", async () => {
    const { connection, ledger, deps } = setup(make);
    const user = addr();
    deposit(connection, "d1", 10, user);
    await pollOnce(deps);
    deposit(connection, "d2", 11, user);
    const orig = connection.getSignaturesForAddress.bind(connection);
    let once = true;
    connection.getSignaturesForAddress = async (a, o) => (once ? ((once = false), []) : orig(a, o));
    const r = await pollOnce(deps);
    expect(r.halted).toBe("cursor_not_found");
    expect(ledger.getIncident()).toBeNull();
    expect(deps.pauseVault).not.toHaveBeenCalled();
    expect((await pollOnce(deps)).drained).toBe(true);
    expect(ledger.getBalance(user.toBase58()).available).toBe(2n);
  });

  it("cursor-not-found cycles count as failed cycles for the runListener alert", async () => {
    const { ledger, deps } = setup(make, {}, { anchor: false });
    ledger.setCursor("c50", 50);
    await runListener(deps, { intervalMs: 0, failureAlertCycles: 3, maxCycles: 3 });
    expect(deps.alert).toHaveBeenCalledWith(
      expect.stringMatching(/consecutive cycles/),
      expect.objectContaining({ consecutiveFailures: 3, lastError: "halted: cursor_not_found" }),
    );
  });

  it("a legacy cursor whose transaction the node does not return halts (no immediate incident)", async () => {
    const { connection, ledger, deps } = setup(make);
    ledger.setCursor("legacy"); // no slot stored
    connection.txs.delete("legacy");
    const r = await pollOnce(deps);
    expect(r.halted).toBe("cursor_not_found");
    expect(ledger.getIncident()).toBeNull();
  });

  it("a normal drain pages with `before` only and stops at the cursor signature itself", async () => {
    const { connection, ledger, deps } = setup(make);
    const user = addr();
    deposit(connection, "a", 1, user);
    deposit(connection, "b", 2, user);
    await pollOnce(deps);
    deposit(connection, "c", 3, user);
    connection.txCalls = [];
    connection.sigOptions = [];
    const r = await pollOnce(deps);
    expect(r.drained).toBe(true);
    expect(connection.txCalls).toEqual(["c"]);
    expect(connection.sigOptions).toHaveLength(1);
    expect(connection.sigOptions.every((o) => o.until === undefined)).toBe(true);
    expect(ledger.getCursor()).toBe("c");
    expect(ledger.getBalance(user.toBase58()).available).toBe(3n);
  });

  // --- NEW-4: processed signatures of the cursor's slot are remembered ------------

  it("a same-slot signature listed after the cursor is processed once and never refetched", async () => {
    const { connection, ledger, deps } = setup(make);
    const user = addr();
    deposit(connection, "x", 5, user, 10n);
    await pollOnce(deps);
    expect(ledger.getProgress()).toMatchObject({ cursor: "x", slot: 5, slotSignatures: ["x"] });
    // Another node orders slot 5 differently: "y" is listed AFTER the cursor.
    const y = { signature: "y", slot: 5, err: null, memo: null, blockTime: null };
    connection.sigs.splice(connection.sigs.findIndex((s) => s.signature === "x"), 0, y);
    connection.txs.set("y", fakeTx(PROGRAM_ID, "y", 5, [{ kind: "deposit", user, amount: 7n }]));
    connection.txCalls = [];
    let r = await pollOnce(deps);
    expect(r).toMatchObject({ processed: 1, drained: true });
    expect(connection.txCalls).toEqual(["y"]);
    expect(ledger.getBalance(user.toBase58()).available).toBe(17n);
    expect(ledger.getProgress().slotSignatures.sort()).toEqual(["x", "y"]);
    // Later cycles neither refetch nor re-apply anything.
    connection.txCalls = [];
    r = await pollOnce(deps);
    expect(r).toMatchObject({ processed: 0, drained: true });
    expect(connection.txCalls).toEqual([]);
    // And a full replay of already-processed transactions is a no-op.
    ledger.setCursor("upgrade0", 0);
    await pollOnce(deps);
    expect(ledger.getBalance(user.toBase58()).available).toBe(17n);
    expect(ledger.getIncident()).toBeNull();
  });

  it("an already-processed same-slot tx that the node no longer serves does not block releases", async () => {
    const { connection, ledger, deps } = setup(make);
    const user = addr();
    deposit(connection, "a", 10, user);
    deposit(connection, "b", 10, user);
    expect((await pollOnce(deps)).drained).toBe(true);
    const player = addr().toBase58();
    ledger.credit(player, 100n, "seed");
    const hold = ledger.placeHold({ ownerKey: player, amount: 50n, destination: player, lastValidBlockHeight: 10 });
    connection.blockHeight = 10_000;
    connection.txs.set("a", null); // older same-slot tx no longer served
    const r = await pollOnce(deps);
    expect(r.drained).toBe(true);
    expect(r.released).toBe(1);
    expect(ledger.getHold(hold.requestId)?.status).toBe("released");
  });

  // --- NEW-1: page boundaries on slot edges ----------------------------------------

  it("intra-slot order differing between nodes at a page boundary skips nothing", async () => {
    const { connection, ledger, deps } = setup(make, { pageSize: 3 });
    const user = addr();
    deposit(connection, "c0", 5, user);
    await pollOnce(deps);
    for (const s of ["x", "y", "z"]) deposit(connection, s, 20, user);
    for (const s of ["n1", "n2"]) deposit(connection, s, 30, user);
    const orig = connection.getSignaturesForAddress.bind(connection);
    let call = 0;
    connection.getSignaturesForAddress = async (a, o) => {
      call++;
      // node A (odd calls) orders slot 20 x,y,z (oldest-first); node B (even) z,x,y
      const order = call % 2 ? ["x", "y", "z"] : ["z", "x", "y"];
      connection.sigs.sort(
        (p, q) => p.slot - q.slot || (p.slot === 20 ? order.indexOf(p.signature) - order.indexOf(q.signature) : 0),
      );
      return orig(a, o);
    };
    const r = await pollOnce(deps);
    expect(r.drained).toBe(true);
    expect(r.processed).toBe(5);
    expect(ledger.getBalance(user.toBase58()).available).toBe(6n);
    // The single-slot page was re-requested with the maximum limit.
    expect(connection.sigOptions.some((o) => o.limit === 1000)).toBe(true);
  });

  it("chunked processing + node order flips + a crash mid-cycle: every deposit applied exactly once", async () => {
    const { connection, ledger, deps } = setup(make, { pageSize: 3, maxBacklog: 4 });
    const user = addr();
    for (let i = 0; i < 9; i++) deposit(connection, `d${i}`, 10 + Math.floor(i / 3), user);
    ledger.setCursor("upgrade0", 0);
    let crashOnce = true;
    const orig = connection.getTransaction.bind(connection);
    connection.getTransaction = async (s: string) => {
      if (s === "d4" && crashOnce) {
        crashOnce = false;
        throw new Error("boom");
      }
      return orig(s);
    };
    let drained = false;
    for (let c = 0; c < 10 && !drained; c++) {
      connection.sigs.sort(
        (a, b) => a.slot - b.slot || (c % 2 ? a.signature.localeCompare(b.signature) : b.signature.localeCompare(a.signature)),
      );
      try {
        drained = (await pollOnce(deps)).drained;
      } catch {
        // the injected crash
      }
    }
    expect(drained).toBe(true);
    expect(ledger.getBalance(user.toBase58()).available).toBe(9n);
    expect(ledger.getIncident()).toBeNull();
  });

  it("a slot with more than 1000 signatures halts with an alert instead of risking a skip", async () => {
    const { connection, ledger, deps } = setup(make, { pageSize: 3 });
    const user = addr();
    deposit(connection, "c0", 5, user);
    await pollOnce(deps);
    for (let i = 0; i < 1001; i++) connection.add(`big${i}`, 20, null);
    connection.txCalls = [];
    const r = await pollOnce(deps);
    expect(r.halted).toBe("slot_too_large");
    expect(connection.txCalls).toEqual([]);
    expect(ledger.getCursor()).toBe("c0");
    expect(deps.alert).toHaveBeenCalledWith(expect.stringMatching(/more than 1000/), expect.anything());
  });

  // --- NEW-6: START_AFTER_SIGNATURE skips its whole slot --------------------------

  it("START_AFTER_SIGNATURE: other transactions in the start slot are skipped, not decoded", async () => {
    const { connection, ledger, deps } = setup(make, { upgradeSlot: undefined, startAfterSignature: "upg" });
    const user = addr();
    // A v0.1-era tx in the upgrade slot, listed after (older than) the upgrade tx.
    deposit(connection, "old", 50, user, 7n);
    connection.add("upg", 50, fakeTx(PROGRAM_ID, "upg", 50, []));
    deposit(connection, "new", 51, user, 1n);
    const r = await pollOnce(deps);
    expect(r.drained).toBe(true);
    expect(ledger.getBalance(user.toBase58()).available).toBe(1n); // "old" not credited
    expect(connection.txCalls).toEqual(["upg", "new"]); // "old" never fetched
    expect(ledger.getCursor()).toBe("new");
  });

  it("a START_AFTER_SIGNATURE lookup returning null (lagging node) halts without an incident", async () => {
    const { connection, ledger, deps } = setup(make, { upgradeSlot: undefined, startAfterSignature: "upg" });
    connection.add("upg", 50, null);
    const r = await pollOnce(deps);
    expect(r.halted).toBe("start_not_found");
    expect(ledger.getIncident()).toBeNull();
    expect(ledger.getCursor()).toBeNull();
  });

  it("UPGRADE_SLOT start with no entry at/below the slot in the listing halts (no processing)", async () => {
    const { connection, ledger, deps } = setup(make, { upgradeSlot: 10 }, { anchor: false });
    deposit(connection, "v2", 11, addr());
    const r = await pollOnce(deps);
    expect(r.halted).toBe("start_not_found");
    expect(connection.txCalls).toEqual([]);
    expect(ledger.getCursor()).toBeNull();
    expect(deps.alert).toHaveBeenCalledWith(expect.stringMatching(/start point not found/), expect.anything());
  });

  // --- M1 / NEW-5: large backlogs ---------------------------------------------------

  it("with a cursor, a backlog above maxBacklog alerts and is processed in the same cycle; release only once drained", async () => {
    const { connection, ledger, deps } = setup(make, { maxBacklog: 10 });
    const user = addr();
    deposit(connection, "first", 1, user);
    await pollOnce(deps);
    const player = addr().toBase58();
    ledger.credit(player, 100n, "seed");
    const hold = ledger.placeHold({ ownerKey: player, amount: 50n, destination: player, lastValidBlockHeight: 10 });
    connection.blockHeight = 10_000;
    for (let i = 0; i < 25; i++) deposit(connection, `k${i}`, 100 + i, user);
    connection.txs.set("k20", null); // not served yet
    const backlogAlerts = () =>
      (deps.alert as ReturnType<typeof vi.fn>).mock.calls.filter(([m]) => /LISTENER_MAX_BACKLOG/.test(m)).length;

    let r = await pollOnce(deps);
    expect(r).toMatchObject({ processed: 20, drained: false, released: 0, stoppedAt: "k20" });
    expect(backlogAlerts()).toBe(1);
    expect(ledger.getHold(hold.requestId)?.status).toBe("open");

    connection.txs.set("k20", fakeTx(PROGRAM_ID, "k20", 120, [{ kind: "deposit", user, amount: 1n }]));
    const sigCallsBefore = connection.sigCalls;
    r = await pollOnce(deps);
    expect(r).toMatchObject({ processed: 5, drained: true, released: 1 });
    expect(connection.sigCalls - sigCallsBefore).toBe(1); // one page, no re-paging
    expect(backlogAlerts()).toBe(1); // 5 <= 10: no alert
    expect(ledger.getCursor()).toBe("k24");
    expect(ledger.getBalance(user.toBase58()).available).toBe(26n);
  });

  it("with a cursor, a backlog above the hard safety cap halts with an alert", async () => {
    const { connection, ledger, deps } = setup(make, { maxBacklog: 5, hardBacklogCap: 20 });
    const user = addr();
    deposit(connection, "first", 1, user);
    await pollOnce(deps);
    for (let i = 0; i < 25; i++) deposit(connection, `k${i}`, 100 + i, user);
    connection.txCalls = [];
    const r = await pollOnce(deps);
    expect(r.halted).toBe("backlog_exceeded");
    expect(connection.txCalls).toEqual([]);
    expect(ledger.getCursor()).toBe("first");
    expect(deps.alert).toHaveBeenCalledWith(expect.stringMatching(/hard safety cap/), expect.anything());
  });

  it("refuses maxBacklog < 1 and pageSize outside 1..1000", async () => {
    await expect(pollOnce(setup(make, { maxBacklog: 0 }).deps)).rejects.toBeInstanceOf(ListenerConfigError);
    await expect(pollOnce(setup(make, { pageSize: 1001 }).deps)).rejects.toBeInstanceOf(ListenerConfigError);
  });

  // --- NEW-8: lease re-checked right before release --------------------------------

  it("does not release when the lease is lost right before the release step", async () => {
    const { ledger, deps } = setup(make, { leaseHolder: "A" });
    const player = addr().toBase58();
    ledger.credit(player, 100n, "seed");
    const hold = ledger.placeHold({ ownerKey: player, amount: 50n, destination: player, lastValidBlockHeight: 10 });
    (deps.connection as unknown as FakeConnection).blockHeight = 10_000;
    const real = ledger.acquireListenerLease.bind(ledger);
    let calls = 0;
    ledger.acquireListenerLease = (h, ttl, now) => (++calls >= 2 ? false : real(h, ttl, now));
    const r = await pollOnce(deps);
    expect(r.halted).toBe("lease_held");
    expect(r.released).toBe(0);
    expect(ledger.getHold(hold.requestId)?.status).toBe("open");
  });

  // --- M2: a lagging RPC node must not answer the release proof -------------------

  it("passes the finalized slot measured with tipBefore as minContextSlot to every listing", async () => {
    const { connection, deps } = setup(make);
    connection.epochSlot = 777;
    deposit(connection, "a", 1, addr());
    await pollOnce(deps);
    expect(connection.sigOptions.length).toBeGreaterThan(0);
    expect(connection.sigOptions.every((o) => o.minContextSlot === 777)).toBe(true);
  });

  it("a lagging node (minContextSlot not reached) stops the cycle: nothing processed, no release", async () => {
    const { connection, ledger, deps } = setup(make);
    const player = addr().toBase58();
    ledger.credit(player, 100n, "seed");
    const hold = ledger.placeHold({ ownerKey: player, amount: 50n, destination: player, lastValidBlockHeight: 10 });
    connection.blockHeight = 10_000;
    deposit(connection, "a", 1, addr());
    connection.nodeSlot = connection.epochSlot - 1;
    const r = await pollOnce(deps);
    expect(r.halted).toBe("node_lagging");
    expect(r.drained).toBe(false);
    expect(r.released).toBe(0);
    expect(connection.txCalls).toEqual([]);
    expect(ledger.getHold(hold.requestId)?.status).toBe("open");
    expect(ledger.getProgress().drainedThroughBlockHeight).toBeNull();

    connection.nodeSlot = connection.epochSlot;
    expect((await pollOnce(deps)).released).toBe(1);
  });

  // --- L3: unexpected errors page the operator ------------------------------------

  it("alerts after N consecutive failed cycles (and again every N), resetting on success", async () => {
    const { connection, deps } = setup(make);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let failNext = 12;
    const orig = connection.getEpochInfo.bind(connection);
    connection.getEpochInfo = async () => {
      if (failNext-- > 0) throw new Error("rpc down");
      return orig();
    };
    const failing = () =>
      (deps.alert as ReturnType<typeof vi.fn>).mock.calls.filter(([m]) => /consecutive/.test(m));
    await runListener(deps, { intervalMs: 0, failureAlertCycles: 5, maxCycles: 12 });
    expect(failing()).toHaveLength(2); // at 5 and 10
    expect(failing()[1][1]).toMatchObject({ consecutiveFailures: 10, lastError: "Error: rpc down" });
    failNext = 4;
    (deps.alert as ReturnType<typeof vi.fn>).mockClear();
    await runListener(deps, { intervalMs: 0, failureAlertCycles: 5, maxCycles: 6 });
    expect(failing()).toHaveLength(0); // 4 failures then a success: no alert
    errSpy.mockRestore();
  });
});

// --- Final check: short pages, stalls, randomized property ------------------------

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}
function shuffle<T>(a: T[], r: () => number): T[] {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}
/** Newest-first listing with a caller-chosen intra-slot order. */
function listing(
  sigs: ConfirmedSignatureInfo[],
  order: (slot: number, xs: ConfirmedSignatureInfo[]) => ConfirmedSignatureInfo[],
) {
  const by = new Map<number, ConfirmedSignatureInfo[]>();
  for (const s of sigs) (by.get(s.slot) ?? by.set(s.slot, []).get(s.slot)!).push(s);
  return [...by.keys()].sort((a, b) => b - a).flatMap((sl) => order(sl, by.get(sl)!));
}
function pageOf(list: ConfirmedSignatureInfo[], before: string | undefined, limit: number) {
  let start = 0;
  if (before) {
    const i = list.findIndex((s) => s.signature === before);
    if (i < 0) return [];
    start = i + 1;
  }
  return list.slice(start, start + limit);
}

/**
 * Model of Agave's getSignaturesForAddress with BigTable: the blockstore holds
 * slots >= lowestBlockstoreSlot (intra-slot order A); when it returns fewer
 * than `limit`, BigTable (all slots, order B) is queried with before = the
 * last blockstore result and limit - k, and results already present are
 * FILTERED OUT — so a page can be short although older history exists.
 */
class AgaveMergeConnection extends FakeConnection {
  constructor(public lowestBlockstoreSlot: number) {
    super();
  }
  orderA = (_s: number, xs: ConfirmedSignatureInfo[]) => [...xs].sort((a, b) => (a.signature < b.signature ? -1 : 1));
  orderB = (_s: number, xs: ConfirmedSignatureInfo[]) => [...xs].sort((a, b) => (a.signature < b.signature ? 1 : -1));
  override async getSignaturesForAddress(_a: PublicKey, o: { before?: string; limit?: number } = {}) {
    this.sigCalls++;
    const limit = o.limit ?? 1000;
    const bs = listing(this.sigs.filter((s) => s.slot >= this.lowestBlockstoreSlot), this.orderA);
    const results = pageOf(bs, o.before, limit);
    if (results.length < limit) {
      const btBefore = results.length ? results[results.length - 1].signature : o.before;
      const bt = pageOf(listing(this.sigs, this.orderB), btBefore, limit - results.length);
      const set = new Set(results.map((r) => r.signature));
      for (const r of bt) if (r.signature !== o.before && !set.has(r.signature)) results.push(r);
    }
    return results;
  }
}

/** Load balancer where every response uses a fresh random intra-slot order. */
class ShuffleConnection extends FakeConnection {
  constructor(public r: () => number) {
    super();
  }
  onList?: () => void;
  override async getSignaturesForAddress(_a: PublicKey, o: { before?: string; limit?: number } = {}) {
    this.sigCalls++;
    this.onList?.();
    const seedR = rng(Math.floor(this.r() * 1e9));
    return pageOf(listing(this.sigs, (_s, xs) => shuffle(xs, seedR)), o.before, o.limit ?? 1000);
  }
  override async getTransaction(signature: string) {
    this.txCalls.push(signature);
    if (this.r() < 0.03) return null; // lagging node
    return this.txs.get(signature) ?? null;
  }
}

function baseDeps(connection: FakeConnection, ledger: Ledger, over: Partial<ListenerDeps> = {}): ListenerDeps {
  return {
    connection,
    ledger,
    programId: PROGRAM_ID,
    releaseSafetyBlocks: 150,
    upgradeSlot: 0,
    pauseVault: vi.fn(async () => "p"),
    isVaultPaused: vi.fn(async () => false),
    alert: vi.fn(),
    log: () => {},
    ...over,
  };
}

describe.each(LEDGERS)("listener scan edge cases (%s)", (_name, make) => {
  it("a short Agave blockstore+BigTable page that truncates the cursor slot does not end the scan", async () => {
    const c = new AgaveMergeConnection(100);
    const ledger = make({ adminKey: ADMIN.toBase58() });
    const user = addr();
    c.add("anchor", 1, fakeTx(PROGRAM_ID, "anchor", 1, []));
    // Cursor slot 50 (BigTable only): "c1" processed, "c0" not yet.
    c.add("c1", 50, fakeTx(PROGRAM_ID, "c1", 50, []));
    c.add("c0", 50, fakeTx(PROGRAM_ID, "c0", 50, [{ kind: "deposit", user, amount: 7n }]));
    ledger.setCursor("c1", 50);
    // Lowest blockstore slot 100: 10 entries (orders A/B disagree), plus 980 newer.
    for (let i = 0; i < 10; i++) c.add(`L${i}`, 100, fakeTx(PROGRAM_ID, `L${i}`, 100, []));
    for (let i = 0; i < 980; i++) {
      const sig = `n${String(i).padStart(4, "0")}`;
      c.add(sig, 200 + i, fakeTx(PROGRAM_ID, sig, 200 + i, []));
    }
    const r = await pollOnce(baseDeps(c, ledger, { pageSize: 1000 }));
    // Never "drained" without having seen c0.
    expect(r.drained && !c.txCalls.includes("c0")).toBe(false);
    expect(r.drained).toBe(true);
    expect(ledger.getBalance(user.toBase58()).available).toBe(7n);
  });

  it("a cursor in the oldest slot the node has cannot be proven complete: halt, no release", async () => {
    const c = new FakeConnection();
    const ledger = make();
    c.add("only", 50, fakeTx(PROGRAM_ID, "only", 50, []));
    ledger.setCursor("only", 50);
    const player = addr().toBase58();
    ledger.credit(player, 100n, "seed");
    const hold = ledger.placeHold({ ownerKey: player, amount: 50n, destination: player, lastValidBlockHeight: 10 });
    c.blockHeight = 10_000;
    const r = await pollOnce(baseDeps(c, ledger));
    expect(r.halted).toBe("cursor_not_found");
    expect(ledger.getHold(hold.requestId)?.status).toBe("open");
  });

  it("two nodes with opposite intra-slot orders do not loop the scan", async () => {
    const c = new FakeConnection();
    c.add("old", 50, null);
    c.add("cur", 100, null);
    for (let i = 0; i < 999; i++) c.add(`d${String(i).padStart(4, "0")}`, 200, null);
    for (const s of ["a", "b", "c"]) c.add(s, 300, null);
    c.add("top", 400, null);
    let call = 0;
    const conn = {
      async getSignaturesForAddress(_a: PublicKey, o: { before?: string; limit?: number } = {}) {
        call++;
        if (call > 50) throw new Error("LOOPED >50 pages");
        const asc = call % 2 === 0;
        const l = listing(c.sigs, (sl, xs) =>
          sl === 300 ? [...xs].sort((x, y) => (asc === x.signature < y.signature ? -1 : 1)) : xs,
        );
        return pageOf(l, o.before, o.limit ?? 1000);
      },
    } as unknown as ListenerConnection;
    const r = await collectNewSignatures(conn, PROGRAM_ID, {
      stop: { kind: "signature", slot: 100, processed: new Set(["cur"]) },
      pageSize: 1000,
      cap: 1e6,
    });
    expect(r.status).toBe("ok");
    expect(r.status === "ok" && r.sigs.length).toBe(1003);
    expect(call).toBeLessThan(10);
  });

  it("a scan whose pages keep adding nothing new halts as stalled (with an alert)", async () => {
    const c = new FakeConnection();
    c.add("deploy", -1, fakeTx(PROGRAM_ID, "deploy", -1, []));
    c.add("cur", 100, fakeTx(PROGRAM_ID, "cur", 100, []));
    for (let i = 0; i < 999; i++) c.add(`d${String(i).padStart(4, "0")}`, 200, null);
    for (const s of ["a", "b", "c"]) c.add(s, 300, null);
    const ledger = make();
    ledger.setCursor("cur", 100);
    // Adversarial nodes: whatever `before` is in slot 300, the rest of slot 300
    // comes back first, so a page never reaches past slot 200's top edge.
    c.getSignaturesForAddress = async (_a, o = {}) => {
      c.sigCalls++;
      const limit = o.limit ?? 1000;
      const s300 = c.sigs.filter((s) => s.slot === 300);
      const rest = c.sigs.filter((s) => s.slot < 300).reverse();
      if (!o.before) return [...s300, ...rest].slice(0, limit);
      const others = s300.filter((s) => s.signature !== o.before);
      return [...others, ...rest].slice(0, limit);
    };
    const deps = baseDeps(c, ledger, { pageSize: 1000 });
    const r = await pollOnce(deps);
    expect(r.halted).toBe("scan_stalled");
    expect(c.sigCalls).toBeLessThan(10);
    expect(deps.alert).toHaveBeenCalledWith(expect.stringMatching(/no progress/), expect.anything());
  });

  it("more than MAX_PAGES_PER_SCAN pages halts the scan", async () => {
    const c = new FakeConnection();
    const ledger = make();
    c.add("deploy", -1, fakeTx(PROGRAM_ID, "deploy", -1, []));
    c.add("cur", 0, fakeTx(PROGRAM_ID, "cur", 0, []));
    for (let i = 1; i <= MAX_PAGES_PER_SCAN + 5; i++) c.add(`p${i}`, i, null);
    ledger.setCursor("cur", 0);
    const deps = baseDeps(c, ledger, { pageSize: 2 }); // one trusted entry per page
    const r = await pollOnce(deps);
    expect(r.halted).toBe("scan_stalled");
    expect(c.txCalls).toEqual([]);
  });

  it("property: random intra-slot orders, page sizes, crashes → exactly-once, and no drain before every finalized sig is applied", async () => {
    for (let seed = 1; seed <= 30; seed++) {
      const r = rng(seed);
      const c = new ShuffleConnection(r);
      const ledger = make({ adminKey: ADMIN.toBase58() });
      const users = new Map<string, PublicKey>();
      let slot = 1;
      let n = 0;
      const addSig = (atSlot: number) => {
        const sig = `s${seed}_${n++}`;
        const u = addr();
        users.set(sig, u);
        const failed = r() < 0.1;
        c.add(
          sig,
          atSlot,
          fakeTx(PROGRAM_ID, sig, atSlot, [{ kind: "deposit", user: u, amount: 1n }], failed ? { err: "x" } : {}),
          failed ? "x" : null,
        );
        if (failed) users.delete(sig);
      };
      c.add(`deploy${seed}`, -1, fakeTx(PROGRAM_ID, `deploy${seed}`, -1, []));
      c.add(`anchor${seed}`, 0, fakeTx(PROGRAM_ID, `anchor${seed}`, 0, []));
      const pageSize = 1 + Math.floor(r() * 40);
      const realSet = ledger.setCursor.bind(ledger);
      ledger.setCursor = (s: string, sl?: number) => {
        if (r() < 0.02) throw new Error("crash before cursor");
        realSet(s, sl);
        if (r() < 0.02) throw new Error("crash after cursor");
      };
      const deps = baseDeps(c, ledger, { pageSize, maxBacklog: 100_000 });
      for (let cycle = 0; cycle < 40; cycle++) {
        const k = Math.floor(r() * 4);
        for (let j = 0; j < k; j++) {
          slot++;
          const m = 1 + Math.floor(r() * (r() < 0.3 ? 3 * pageSize : 4));
          for (let q = 0; q < Math.min(m, 900); q++) addSig(slot);
        }
        c.epochSlot = slot;
        c.blockHeight = slot;
        // Signatures landing mid-cycle in a newer slot.
        c.onList = () => {
          if (r() < 0.1) addSig(slot + 1);
        };
        const tipSlot = slot;
        let res;
        try {
          res = await pollOnce(deps);
        } catch {
          continue;
        }
        if (res.drained) {
          for (const [sig, u] of users) {
            const info = c.sigs.find((s) => s.signature === sig)!;
            if (info.slot <= tipSlot && ledger.getBalance(u.toBase58()).available !== 1n) {
              throw new Error(`seed ${seed} cycle ${cycle}: drained but ${sig}@${info.slot} not applied (pageSize ${pageSize})`);
            }
          }
        }
        if (cycle === 39) slot++;
      }
      for (const [, u] of users) {
        expect(ledger.getBalance(u.toBase58()).available <= 1n).toBe(true); // never applied twice
      }
    }
  }, 120_000);
});

// --- Solvency gate -------------------------------------------------------------------

describe.each(LEDGERS)("solvency gate before release (%s)", (_name, make) => {
  /** A ledger with one funded player and one expired 400-lamport hold. */
  function gateSetup(over: Partial<ListenerDeps> = {}) {
    const { connection, ledger, deps } = setup(make, over);
    const player = addr().toBase58();
    ledger.credit(player, 1000n, "seed");
    ledger.credit(addr().toBase58(), 500n, "seed2");
    const hold = ledger.placeHold({ ownerKey: player, amount: 400n, destination: player, lastValidBlockHeight: 10 });
    connection.blockHeight = 10_000;
    const liabilities = (() => {
      const l = ledgerLiabilities(ledger, deps.extraHouseLamports ?? 0n);
      return l.playerBalancesTotal + l.houseBankroll + BigInt(connection.rentExemptMinimum);
    })();
    return { connection, ledger, deps, player, hold, liabilities };
  }

  it("normal: pool == liabilities → released (balance read at finalized with the cycle's minContextSlot)", async () => {
    const { connection, ledger, deps, hold, liabilities } = gateSetup();
    connection.poolBalance = Number(liabilities);
    connection.epochSlot = 4242;
    connection.nodeSlot = connection.balanceNodeSlot = 5000;
    const r = await pollOnce(deps);
    expect(r.released).toBe(1);
    expect(r.releaseBlockedShortfall).toBeUndefined();
    expect(ledger.getHold(hold.requestId)?.status).toBe("released");
    expect(connection.balanceOptions).toEqual([{ commitment: "finalized", minContextSlot: 4242 }]);
  });

  it("surplus: pool > liabilities → released", async () => {
    const { connection, deps, liabilities } = gateSetup();
    connection.poolBalance = Number(liabilities) + 1_000_000;
    expect((await pollOnce(deps)).released).toBe(1);
  });

  it("HOUSE_BANKROLL_LAMPORTS counts as a liability", async () => {
    const { connection, deps, liabilities } = gateSetup({ extraHouseLamports: 5_000n });
    connection.poolBalance = Number(liabilities) - 1; // liabilities include the 5000
    expect((await pollOnce(deps)).released).toBe(0);
    connection.poolBalance = Number(liabilities);
    expect((await pollOnce(deps)).released).toBe(1);
  });

  it("an unseen withdraw (listing misses it, pool is short) → no release; alert after N cycles", async () => {
    const { connection, ledger, deps, hold, liabilities } = gateSetup({ shortfallAlertCycles: 3 });
    // The withdraw of 400 landed (pool paid out) but the listing never showed it.
    connection.poolBalance = Number(liabilities - 400n);
    const shortfallAlerts = () =>
      (deps.alert as ReturnType<typeof vi.fn>).mock.calls.filter(([m]) => /below ledger liabilities/.test(m)).length;
    for (let i = 1; i <= 3; i++) {
      const r = await pollOnce(deps);
      expect(r.drained).toBe(true);
      expect(r.released).toBe(0);
      expect(r.releaseBlockedShortfall).toBe(400n);
      expect(shortfallAlerts()).toBe(i === 3 ? 1 : 0);
    }
    expect(ledger.getHold(hold.requestId)?.status).toBe("open");
    expect(ledger.getIncident()).toBeNull(); // no immediate incident
  });

  it("no expired hold → no balance read at all", async () => {
    const { connection, deps } = setup(make);
    await pollOnce(deps);
    expect(connection.balanceOptions).toEqual([]);
  });

  it("a balance read from a lagging node halts the cycle: no release", async () => {
    const { connection, ledger, deps, hold, liabilities } = gateSetup();
    connection.poolBalance = Number(liabilities);
    connection.balanceNodeSlot = connection.epochSlot - 1;
    const r = await pollOnce(deps);
    expect(r.halted).toBe("node_lagging");
    expect(r.released).toBe(0);
    expect(r.drained).toBe(false);
    expect(ledger.getHold(hold.requestId)?.status).toBe("open");
  });
});
