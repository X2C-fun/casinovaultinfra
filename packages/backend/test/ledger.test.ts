import { describe, it, expect, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import type { DecodedVaultEvent } from "@x2c-fun/casinovault-sdk";
import { MemoryLedger } from "../src/ledger/memory";
import { InsufficientFundsError } from "../src/ledger/types";
import { applyParsedEvents } from "../src/services/settlement";

const addr = () => Keypair.generate().publicKey;

describe("MemoryLedger — balances and holds", () => {
  it("credits a deposit idempotently by source key", () => {
    const l = new MemoryLedger();
    expect(l.credit("alice", 1000n, "sig:0")).toBe("credited");
    expect(l.credit("alice", 1000n, "sig:0")).toBe("duplicate"); // replay
    expect(l.getBalance("alice").available).toBe(1000n);
  });

  it("places a hold as debit-at-approval and blocks the double-spend", () => {
    const l = new MemoryLedger();
    l.credit("alice", 1000n, "dep:0");

    const hold = l.placeHold({
      ownerKey: "alice",
      amount: 1000n,
      destination: "aliceWallet",
      lastValidBlockHeight: 100,
    });
    expect(hold.requestId).toBe(1n);
    expect(l.getBalance("alice")).toMatchObject({ available: 0n, pending: 1000n });

    // The classic attack: a second approval against the same balance must fail.
    expect(() =>
      l.placeHold({
        ownerKey: "alice",
        amount: 1000n,
        destination: "aliceWallet",
        lastValidBlockHeight: 100,
      }),
    ).toThrow(InsufficientFundsError);
  });

  it("settles a hold (final debit), idempotently", () => {
    const l = new MemoryLedger();
    l.credit("alice", 1000n, "dep:0");
    const hold = l.placeHold({
      ownerKey: "alice",
      amount: 1000n,
      destination: "aliceWallet",
      lastValidBlockHeight: 100,
    });

    const first = l.settleHold({
      requestId: hold.requestId,
      user: "aliceWallet",
      amount: 1000n,
      txSignature: "wsig",
    });
    expect(first.kind).toBe("settled");
    expect(l.getBalance("alice")).toMatchObject({ available: 0n, pending: 0n });

    // A duplicate settle (listener backfill) must not debit twice.
    expect(
      l.settleHold({ requestId: hold.requestId, user: "aliceWallet", amount: 1000n, txSignature: "wsig" }).kind,
    ).toBe("already");
  });

  it("flags a mismatched or unknown request_id", () => {
    const l = new MemoryLedger();
    l.credit("alice", 1000n, "dep:0");
    const hold = l.placeHold({
      ownerKey: "alice",
      amount: 1000n,
      destination: "aliceWallet",
      lastValidBlockHeight: 100,
    });
    expect(
      l.settleHold({ requestId: hold.requestId, user: "mallory", amount: 1000n, txSignature: "x" }).kind,
    ).toBe("mismatch");
    expect(l.settleHold({ requestId: 999n, user: "x", amount: 1n, txSignature: "y" }).kind).toBe(
      "notfound",
    );
  });

  it("releases an expired hold back to available", () => {
    const l = new MemoryLedger();
    l.credit("alice", 1000n, "dep:0");
    const hold = l.placeHold({
      ownerKey: "alice",
      amount: 1000n,
      destination: "aliceWallet",
      lastValidBlockHeight: 100,
    });
    expect(l.releaseHold(hold.requestId)).toBe("released");
    expect(l.getBalance("alice")).toMatchObject({ available: 1000n, pending: 0n });
    // Cannot release twice, and cannot settle a released hold.
    expect(l.releaseHold(hold.requestId)).toBe("cannot");
  });

  it("totals sum available + pending across owners", () => {
    const l = new MemoryLedger();
    l.credit("a", 500n, "d:0");
    l.credit("b", 300n, "d:1");
    l.placeHold({ ownerKey: "a", amount: 200n, destination: "aw", lastValidBlockHeight: 1 });
    const t = l.totals();
    expect(t.available).toBe(600n);
    expect(t.pending).toBe(200n);
  });
});

describe("applyParsedEvents — settlement from events", () => {
  function depositEvent(user: ReturnType<typeof addr>, amount: bigint): DecodedVaultEvent {
    return {
      name: "depositEvent",
      data: { user, amount, vaultBalance: amount, timestamp: 0n },
    };
  }
  function withdrawEvent(
    user: ReturnType<typeof addr>,
    amount: bigint,
    requestId: bigint,
  ): DecodedVaultEvent {
    return {
      name: "withdrawEvent",
      data: { user, admin: addr(), requestId, amount, vaultBalance: 0n, timestamp: 0n },
    };
  }

  it("credits deposits and never double-credits on replay", async () => {
    const l = new MemoryLedger();
    const user = addr();
    const events = [depositEvent(user, 1000n)];
    const handlers = { onIncident: vi.fn() };
    await applyParsedEvents(l, "sigA", events, handlers);
    await applyParsedEvents(l, "sigA", events, handlers); // replay same tx
    expect(l.getBalance(user.toBase58()).available).toBe(1000n);
    expect(handlers.onIncident).not.toHaveBeenCalled();
  });

  it("settles a matching withdraw and raises an incident on an unmatched one", async () => {
    const l = new MemoryLedger();
    const user = addr();
    l.credit(user.toBase58(), 1000n, "seed:0");
    const hold = l.placeHold({
      ownerKey: user.toBase58(),
      amount: 1000n,
      destination: user.toBase58(),
      lastValidBlockHeight: 100,
    });

    const onIncident = vi.fn();
    await applyParsedEvents(l, "wsig", [withdrawEvent(user, 1000n, hold.requestId)], {
      onIncident,
    });
    expect(l.getBalance(user.toBase58()).pending).toBe(0n);
    expect(onIncident).not.toHaveBeenCalled();

    // A WithdrawEvent for a request_id with no open hold = leaked-approval shape.
    await applyParsedEvents(l, "evil", [withdrawEvent(addr(), 5000n, 424242n)], {
      onIncident,
    });
    expect(onIncident).toHaveBeenCalledTimes(1);
  });
});
