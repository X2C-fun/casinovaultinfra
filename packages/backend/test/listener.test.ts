import { describe, it, expect, vi } from "vitest";
import type { Ledger, LedgerOptions } from "../src/ledger/types";
import {
  ListenerConfigError,
  ListenerLeaseError,
  pollOnce,
  runListener,
  type ListenerDeps,
} from "../src/listener/listener";
import { FakeConnection, LEDGERS, addr, fakeTx } from "./helpers";

const PROGRAM_ID = addr();
const ADMIN = addr();

function setup(make: (o?: LedgerOptions) => Ledger, over: Partial<ListenerDeps> = {}) {
  const connection = new FakeConnection();
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

  it("an unknown/pruned cursor raises an incident instead of rescanning history", async () => {
    const { connection, ledger, deps } = setup(make);
    const user = addr();
    // History the RPC still has: slots 100..599. The stored cursor ("ghost",
    // slot 500) is not in it, so `until` never matches.
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

  it("stops and alerts when the backlog exceeds the cap", async () => {
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
});
