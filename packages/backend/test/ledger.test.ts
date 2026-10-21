import { describe, it, expect, vi } from "vitest";
import {
  DestinationMismatchError,
  IncidentOpenError,
  InsufficientFundsError,
} from "../src/ledger/types";
import { applyVaultEvents } from "../src/services/settlement";
import { LEDGERS, addr, depositRecord, withdrawRecord } from "./helpers";

const ADMIN = addr().toBase58();

describe.each(LEDGERS)("%s — balances and holds", (_name, make) => {
  it("credits a deposit idempotently by source key", () => {
    const l = make();
    expect(l.credit("alice", 1000n, "sig:0")).toBe("credited");
    expect(l.credit("alice", 1000n, "sig:0")).toBe("duplicate"); // replay
    expect(l.getBalance("alice").available).toBe(1000n);
  });

  it("places a hold as debit-at-approval and blocks the double-spend", () => {
    const l = make();
    l.credit("alice", 1000n, "dep:0");
    const hold = l.placeHold({
      ownerKey: "alice",
      amount: 1000n,
      destination: "alice",
      lastValidBlockHeight: 100,
    });
    expect(hold.requestId).toBeGreaterThan(0n);
    expect(l.getBalance("alice")).toMatchObject({ available: 0n, pending: 1000n });

    // The classic attack: a second approval against the same balance must fail.
    expect(() =>
      l.placeHold({ ownerKey: "alice", amount: 1000n, destination: "alice", lastValidBlockHeight: 100 }),
    ).toThrow(InsufficientFundsError);
  });

  it("refuses a hold whose destination is not the owner", () => {
    const l = make();
    l.credit("alice", 1000n, "dep:0");
    expect(() =>
      l.placeHold({ ownerKey: "alice", amount: 10n, destination: "mallory", lastValidBlockHeight: 1 }),
    ).toThrow(DestinationMismatchError);
    expect(l.getBalance("alice")).toMatchObject({ available: 1000n, pending: 0n });
  });

  it("settles a hold (final debit); same-signature replay is 'already'", () => {
    const l = make();
    l.credit("alice", 1000n, "dep:0");
    const hold = l.placeHold({ ownerKey: "alice", amount: 1000n, destination: "alice", lastValidBlockHeight: 100 });
    const first = l.settleHold({ requestId: hold.requestId, user: "alice", amount: 1000n, txSignature: "wsig" });
    expect(first.kind).toBe("settled");
    expect(l.getBalance("alice")).toMatchObject({ available: 0n, pending: 0n });
    expect(
      l.settleHold({ requestId: hold.requestId, user: "alice", amount: 1000n, txSignature: "wsig" }).kind,
    ).toBe("already");
    expect(l.getBalance("alice")).toMatchObject({ available: 0n, pending: 0n });
  });

  it("a settled request_id replayed from a DIFFERENT signature is an incident", () => {
    const l = make();
    l.credit("alice", 1000n, "dep:0");
    const hold = l.placeHold({ ownerKey: "alice", amount: 500n, destination: "alice", lastValidBlockHeight: 100 });
    expect(l.applyWithdrawEvent("wsig:cpi:0:0", { requestId: hold.requestId, user: "alice", amount: 500n, txSignature: "wsig" }).kind).toBe("settled");
    const second = l.applyWithdrawEvent("other:cpi:0:0", {
      requestId: hold.requestId,
      user: "alice",
      amount: 500n,
      txSignature: "other",
    });
    expect(second.kind).toBe("replay");
    expect(l.getIncident()).not.toBeNull();
    // Same signature but a different event (2 withdraws in one tx) is also a replay.
    expect(
      l.settleHold({ requestId: hold.requestId, user: "alice", amount: 500n, txSignature: "wsig", eventKey: "wsig:cpi:0:1" }).kind,
    ).toBe("replay");
    // Balances untouched by the incidents.
    expect(l.getBalance("alice")).toMatchObject({ available: 500n, pending: 0n });
  });

  it("flags mismatched, unknown and released request_ids", () => {
    const l = make();
    l.credit("alice", 1000n, "dep:0");
    const hold = l.placeHold({ ownerKey: "alice", amount: 1000n, destination: "alice", lastValidBlockHeight: 100 });
    expect(l.settleHold({ requestId: hold.requestId, user: "mallory", amount: 1000n, txSignature: "x" }).kind).toBe("mismatch");
    expect(l.settleHold({ requestId: hold.requestId, user: "alice", amount: 999n, txSignature: "x" }).kind).toBe("mismatch");
    expect(l.settleHold({ requestId: 999n, user: "x", amount: 1n, txSignature: "y" }).kind).toBe("notfound");
    expect(l.releaseHold(hold.requestId)).toBe("released");
    expect(l.settleHold({ requestId: hold.requestId, user: "alice", amount: 1000n, txSignature: "z" }).kind).toBe("released");
  });

  it("releases an expired hold back to available, once", () => {
    const l = make();
    l.credit("alice", 1000n, "dep:0");
    const hold = l.placeHold({ ownerKey: "alice", amount: 1000n, destination: "alice", lastValidBlockHeight: 100 });
    expect(l.releaseHold(hold.requestId)).toBe("released");
    expect(l.getBalance("alice")).toMatchObject({ available: 1000n, pending: 0n });
    expect(l.releaseHold(hold.requestId)).toBe("cannot");
  });

  it("totals sum available + pending across players", () => {
    const l = make();
    l.credit("a", 500n, "d:0");
    l.credit("b", 300n, "d:1");
    l.placeHold({ ownerKey: "a", amount: 200n, destination: "a", lastValidBlockHeight: 1 });
    expect(l.totals()).toEqual({ available: 600n, pending: 200n });
  });

  it("uses random u64 request ids, unique, exact above 2^53", () => {
    const big = (1n << 63n) + 12345n; // not representable as a JS number
    const ids = [big, big, big + 1n]; // second draw collides → must redraw
    const l = make({ requestIdGenerator: () => ids.shift()! });
    l.credit("alice", 1000n, "dep:0");
    const h1 = l.placeHold({ ownerKey: "alice", amount: 1n, destination: "alice", lastValidBlockHeight: 1 });
    const h2 = l.placeHold({ ownerKey: "alice", amount: 2n, destination: "alice", lastValidBlockHeight: 1 });
    expect(h1.requestId).toBe(big);
    expect(h2.requestId).toBe(big + 1n);
    expect(l.getHold(big)?.amount).toBe(1n);
    expect(l.getHold(big + 1n)?.amount).toBe(2n);
    expect(l.getHold(big - 1n)).toBeNull();
    expect(
      l.applyWithdrawEvent("s:cpi:0:0", { requestId: big + 1n, user: "alice", amount: 2n, txSignature: "s" }).kind,
    ).toBe("settled");

    const r = make();
    r.credit("bob", 10_000n, "dep:0");
    const seen = new Set<bigint>();
    for (let i = 0; i < 200; i++) {
      const h = r.placeHold({ ownerKey: "bob", amount: 1n, destination: "bob", lastValidBlockHeight: 1 });
      expect(h.requestId).toBeGreaterThan(0n);
      expect(h.requestId).toBeLessThan(1n << 64n);
      seen.add(h.requestId);
    }
    expect(seen.size).toBe(200);
  });

  it("kill-switch blocks holds until cleared manually", () => {
    const l = make({ adminKey: ADMIN });
    l.credit("alice", 1000n, "dep:0");
    l.openIncident("test incident", { why: "test" });
    expect(l.getIncident()?.reason).toBe("test incident");
    expect(() =>
      l.placeHold({ ownerKey: "alice", amount: 1n, destination: "alice", lastValidBlockHeight: 1 }),
    ).toThrow(IncidentOpenError);
    l.openIncident("second"); // keeps the first reason, logs both
    expect(l.getIncident()?.reason).toBe("test incident");
    expect(l.listIncidents()).toHaveLength(2);
    expect(l.clearIncident()).toBe(true);
    expect(l.clearIncident()).toBe(false);
    expect(
      l.placeHold({ ownerKey: "alice", amount: 1n, destination: "alice", lastValidBlockHeight: 1 }).status,
    ).toBe("open");
  });

  it("persists listener progress", () => {
    const l = make();
    expect(l.getProgress()).toEqual({ cursor: null, slot: null, drainedThroughBlockHeight: null });
    l.setCursor("sigX", 42);
    l.setDrainedThroughBlockHeight(777);
    expect(l.getProgress()).toEqual({ cursor: "sigX", slot: 42, drainedThroughBlockHeight: 777 });
  });
});

describe.each(LEDGERS)("%s — house withdrawals", (_name, make) => {
  it("admin-wallet deposits fund the house bankroll, not a player balance", () => {
    const l = make({ adminKey: ADMIN });
    expect(l.applyDepositEvent("d:cpi:0:0", { user: ADMIN, amount: 5000n })).toBe("house");
    expect(l.applyDepositEvent("d:cpi:0:0", { user: ADMIN, amount: 5000n })).toBe("duplicate");
    expect(l.getBalance(ADMIN).available).toBe(0n);
    expect(l.totals()).toEqual({ available: 0n, pending: 0n });
    expect(l.houseBalance()).toEqual({ available: 5000n, pending: 0n });
  });

  it("refuses a house hold to a non-admin destination (or with no admin configured)", () => {
    const l = make({ adminKey: ADMIN });
    l.applyDepositEvent("d:cpi:0:0", { user: ADMIN, amount: 5000n });
    expect(() =>
      l.placeHouseHold({ amount: 100n, destination: addr().toBase58(), lastValidBlockHeight: 1 }),
    ).toThrow(DestinationMismatchError);
    const noAdmin = make();
    expect(() =>
      noAdmin.placeHouseHold({ amount: 1n, destination: ADMIN, lastValidBlockHeight: 1 }),
    ).toThrow(DestinationMismatchError);
    expect(l.houseBalance()).toEqual({ available: 5000n, pending: 0n });
  });

  it("house holds draw on, and settle against, the tracked bankroll", () => {
    const l = make({ adminKey: ADMIN });
    l.applyDepositEvent("d:cpi:0:0", { user: ADMIN, amount: 5000n });
    expect(() =>
      l.placeHouseHold({ amount: 6000n, destination: ADMIN, lastValidBlockHeight: 1 }),
    ).toThrow(InsufficientFundsError);
    const h = l.placeHouseHold({ amount: 2000n, destination: ADMIN, lastValidBlockHeight: 1 });
    expect(h.isHouse).toBe(true);
    expect(l.houseBalance()).toEqual({ available: 3000n, pending: 2000n });
    expect(
      l.applyWithdrawEvent("w:cpi:0:0", { requestId: h.requestId, user: ADMIN, amount: 2000n, txSignature: "w" }).kind,
    ).toBe("settled");
    expect(l.houseBalance()).toEqual({ available: 3000n, pending: 0n });

    const h2 = l.placeHouseHold({ amount: 1000n, destination: ADMIN, lastValidBlockHeight: 1 });
    expect(l.releaseHold(h2.requestId)).toBe("released");
    expect(l.houseBalance()).toEqual({ available: 3000n, pending: 0n });
  });

  it("a house hold matched by an event whose user is not the admin is an incident", () => {
    const l = make({ adminKey: ADMIN });
    l.applyDepositEvent("d:cpi:0:0", { user: ADMIN, amount: 5000n });
    const h = l.placeHouseHold({ amount: 2000n, destination: ADMIN, lastValidBlockHeight: 1 });
    const out = l.applyWithdrawEvent("w:cpi:0:0", {
      requestId: h.requestId,
      user: addr().toBase58(),
      amount: 2000n,
      txSignature: "w",
    });
    expect(out.kind).toBe("mismatch");
    expect(l.getIncident()).not.toBeNull();
  });
});

describe.each(LEDGERS)("%s — atomic event application", (_name, make) => {
  it("a crash between seen-marking and settlement applies neither", () => {
    let armed = true;
    const l = make({
      failpoint: (step) => {
        if (armed && step === "withdraw:after-seen") throw new Error("simulated crash");
      },
    });
    l.credit("alice", 1000n, "dep:0");
    const hold = l.placeHold({ ownerKey: "alice", amount: 400n, destination: "alice", lastValidBlockHeight: 1 });
    const ev = { requestId: hold.requestId, user: "alice", amount: 400n, txSignature: "w" };

    expect(() => l.applyWithdrawEvent("w:cpi:0:0", ev)).toThrow("simulated crash");
    expect(l.getHold(hold.requestId)?.status).toBe("open");
    expect(l.getBalance("alice")).toMatchObject({ available: 600n, pending: 400n });
    expect(l.recordEventSeen("probe")).toBe("new"); // store still usable

    // The retry (listener did not advance its cursor) applies it exactly once.
    armed = false;
    expect(l.applyWithdrawEvent("w:cpi:0:0", ev).kind).toBe("settled");
    expect(l.applyWithdrawEvent("w:cpi:0:0", ev).kind).toBe("duplicate");
    expect(l.getBalance("alice")).toMatchObject({ available: 600n, pending: 0n });
  });

  it("a crash after settlement but before commit rolls back the settlement and the incident", () => {
    let armed = true;
    const l = make({
      failpoint: (step) => {
        if (armed && step === "withdraw:after-settle") throw new Error("simulated crash");
      },
    });
    expect(() =>
      l.applyWithdrawEvent("x:cpi:0:0", { requestId: 5n, user: "u", amount: 1n, txSignature: "x" }),
    ).toThrow("simulated crash");
    expect(l.getIncident()).toBeNull();
    armed = false;
    expect(
      l.applyWithdrawEvent("x:cpi:0:0", { requestId: 5n, user: "u", amount: 1n, txSignature: "x" }).kind,
    ).toBe("notfound");
    expect(l.getIncident()).not.toBeNull();
  });

  it("a crash between seen-marking and a deposit credit applies neither", () => {
    let armed = true;
    const l = make({
      failpoint: (step) => {
        if (armed && step === "deposit:after-seen") throw new Error("simulated crash");
      },
    });
    expect(() => l.applyDepositEvent("d:cpi:0:0", { user: "alice", amount: 7n })).toThrow();
    expect(l.getBalance("alice").available).toBe(0n);
    armed = false;
    expect(l.applyDepositEvent("d:cpi:0:0", { user: "alice", amount: 7n })).toBe("credited");
    expect(l.getBalance("alice").available).toBe(7n);
  });
});

describe.each(LEDGERS)("%s — applyVaultEvents", (_name, make) => {
  it("credits deposits and never double-credits on replay", async () => {
    const l = make();
    const user = addr();
    const events = [depositRecord(user, 1000n)];
    const handlers = { onIncident: vi.fn() };
    await applyVaultEvents(l, "sigA", events, handlers);
    await applyVaultEvents(l, "sigA", events, handlers); // replay same tx
    expect(l.getBalance(user.toBase58()).available).toBe(1000n);
    expect(handlers.onIncident).not.toHaveBeenCalled();
  });

  it("two identical deposits in one tx are both credited (keyed by position)", async () => {
    const l = make();
    const user = addr();
    await applyVaultEvents(
      l,
      "sigB",
      [depositRecord(user, 10n, { ix: 0 }), depositRecord(user, 10n, { ix: 1 })],
      { onIncident: vi.fn() },
    );
    expect(l.getBalance(user.toBase58()).available).toBe(20n);
  });

  it("settles a matching withdraw and raises an incident on an unmatched one", async () => {
    const l = make();
    const user = addr();
    l.credit(user.toBase58(), 1000n, "seed:0");
    const hold = l.placeHold({
      ownerKey: user.toBase58(),
      amount: 1000n,
      destination: user.toBase58(),
      lastValidBlockHeight: 100,
    });

    const onIncident = vi.fn();
    await applyVaultEvents(l, "wsig", [withdrawRecord(user, 1000n, hold.requestId)], { onIncident });
    expect(l.getBalance(user.toBase58()).pending).toBe(0n);
    expect(onIncident).not.toHaveBeenCalled();
    expect(l.getIncident()).toBeNull();

    // A WithdrawEvent for a request_id with no open hold = leaked-approval shape.
    await applyVaultEvents(l, "evil", [withdrawRecord(addr(), 5000n, 424242n)], { onIncident });
    expect(onIncident).toHaveBeenCalledTimes(1);
    expect(l.getIncident()).not.toBeNull(); // durable kill-switch set by the ledger
  });
});
