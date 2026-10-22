import { describe, it, expect, afterEach, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { derivePoolVaultPda, getProgram } from "@x2c-fun/casinovault-sdk";
import type { ServiceContext } from "../src/context";
import type { Config } from "../src/config";
import type { Ledger } from "../src/ledger/types";
import { approveWithdrawal, prepareHouseWithdrawal, ApprovalError } from "../src/services/withdraw";
import { createApi, parseLamports } from "../src/server";
import { LEDGERS, addr } from "./helpers";

const PROGRAM_ID = addr();
const RENT_MIN = 890_880;

interface CtxOpts {
  paused?: boolean;
  maxWithdrawPerTx?: bigint;
  maxWithdrawPerWindow?: bigint;
  windowWithdrawn?: bigint;
  windowStartOffsetSec?: number;
  destBalance?: number;
  poolBalance?: number;
  breakBuild?: boolean;
  breakState?: Error;
  /** Runs while the withdraw transaction is being built (mid-approval). */
  onBuild?: () => void;
}

function makeCtx(ledger: Ledger, o: CtxOpts = {}): ServiceContext {
  const admin = Keypair.generate();
  const [pool] = derivePoolVaultPda(PROGRAM_ID);
  const connection = {
    getBalance: async (pk: PublicKey) =>
      pk.equals(pool) ? (o.poolBalance ?? 100 * RENT_MIN) : (o.destBalance ?? 1_000_000),
    getMinimumBalanceForRentExemption: async () => RENT_MIN,
    getLatestBlockhash: async () => ({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 500,
    }),
  };
  const wallet = {
    publicKey: admin.publicKey,
    signTransaction: async <T,>(t: T) => t,
    signAllTransactions: async <T,>(t: T[]) => t,
  };
  const real = getProgram(connection as never, wallet, PROGRAM_ID);
  const program = Object.create(real);
  const now = Math.floor(Date.now() / 1000);
  Object.defineProperty(program, "account", {
    value: {
      vaultState: {
        fetchNullable: async () => {
          if (o.breakState) throw o.breakState;
          return {
            admin: admin.publicKey,
            vaultBump: 255,
            paused: o.paused ?? false,
            pendingAdmin: null,
            maxWithdrawPerTx: o.maxWithdrawPerTx ?? 0n,
            maxWithdrawPerWindow: o.maxWithdrawPerWindow ?? 0n,
            windowSeconds: 3600,
            windowStart: BigInt(now + (o.windowStartOffsetSec ?? -10)),
            windowWithdrawn: o.windowWithdrawn ?? 0n,
          };
        },
      },
    },
  });
  if (o.onBuild) {
    Object.defineProperty(program, "methods", {
      get() {
        o.onBuild!();
        return real.methods;
      },
    });
  }
  if (o.breakBuild) {
    Object.defineProperty(program, "methods", {
      get() {
        throw new Error("simulated build failure");
      },
    });
  }
  const config: Config = {
    rpcUrl: "http://fake",
    programId: PROGRAM_ID,
    port: 0,
    host: "127.0.0.1",
    ledger: "memory",
    dbPath: ":memory:",
  };
  return { config, connection: connection as never, admin, program, ledger };
}

function fund(ledger: Ledger, owner: string, amount: bigint) {
  ledger.applyDepositEvent(`seed-${owner}:cpi:0:0`, { user: owner, amount });
}

describe.each(LEDGERS)("approveWithdrawal (%s)", (_name, make) => {
  it("approves: holds the balance and returns an admin-signed tx paying the owner", async () => {
    const ledger = make();
    const ctx = makeCtx(ledger);
    const owner = addr().toBase58();
    fund(ledger, owner, 5_000_000n);
    const a = await approveWithdrawal(ctx, { ownerKey: owner, amountLamports: 2_000_000n });
    expect(ledger.getBalance(owner)).toMatchObject({ available: 3_000_000n, pending: 2_000_000n });
    const hold = ledger.getHold(BigInt(a.requestId))!;
    expect(hold.destination).toBe(owner);
    const tx = Transaction.from(Buffer.from(a.transactionBase64, "base64"));
    expect(tx.feePayer?.toBase58()).toBe(owner);
    const adminSig = tx.signatures.find((s) => s.publicKey.equals(ctx.admin.publicKey));
    expect(adminSig?.signature).not.toBeNull();
  });

  it("refuses a destination other than the owner", async () => {
    const ledger = make();
    const ctx = makeCtx(ledger);
    const owner = addr().toBase58();
    fund(ledger, owner, 5_000_000n);
    await expect(
      approveWithdrawal(ctx, { ownerKey: owner, destination: addr().toBase58(), amountLamports: 1_000_000n }),
    ).rejects.toMatchObject({ code: "destination_mismatch" });
    expect(ledger.listOpenHolds()).toHaveLength(0);
  });

  it("refuses owner === the admin wallet (its balance is the house bankroll)", async () => {
    const ledger = make();
    const ctx = makeCtx(ledger);
    const adminKey = ctx.admin.publicKey.toBase58();
    fund(ledger, adminKey, 5_000_000n);
    await expect(
      approveWithdrawal(ctx, { ownerKey: adminKey, amountLamports: 1_000_000n }),
    ).rejects.toMatchObject({ code: "admin_owner", status: 400 });
    expect(ledger.listOpenHolds()).toHaveLength(0);
  });

  it("refuses every approval while the kill-switch is set", async () => {
    const ledger = make();
    const ctx = makeCtx(ledger);
    const owner = addr().toBase58();
    fund(ledger, owner, 5_000_000n);
    ledger.openIncident("leak");
    await expect(
      approveWithdrawal(ctx, { ownerKey: owner, amountLamports: 1_000_000n }),
    ).rejects.toMatchObject({ code: "withdrawals_blocked" });
    expect(ledger.listOpenHolds()).toHaveLength(0);
  });

  it("releases the hold immediately when building the transaction fails", async () => {
    const ledger = make();
    const ctx = makeCtx(ledger, { breakBuild: true });
    const owner = addr().toBase58();
    fund(ledger, owner, 5_000_000n);
    await expect(
      approveWithdrawal(ctx, { ownerKey: owner, amountLamports: 1_000_000n }),
    ).rejects.toThrow("simulated build failure");
    expect(ledger.getBalance(owner)).toMatchObject({ available: 5_000_000n, pending: 0n });
    expect(ledger.listOpenHolds()).toHaveLength(0);
  });

  it("refuses and releases when the kill-switch opens while the tx is being built", async () => {
    const ledger = make();
    const ctx = makeCtx(ledger, { onBuild: () => ledger.openIncident("opened mid-approval") });
    const owner = addr().toBase58();
    fund(ledger, owner, 5_000_000n);
    await expect(
      approveWithdrawal(ctx, { ownerKey: owner, amountLamports: 1_000_000n }),
    ).rejects.toMatchObject({ code: "withdrawals_blocked" });
    expect(ledger.getBalance(owner)).toMatchObject({ available: 5_000_000n, pending: 0n });
    expect(ledger.listOpenHolds()).toHaveLength(0);
  });

  it("checks the per-tx cap, the window remaining, and the rent-exempt minimum", async () => {
    const owner = addr().toBase58();
    const l1 = make();
    fund(l1, owner, 5_000_000n);
    await expect(
      approveWithdrawal(makeCtx(l1, { maxWithdrawPerTx: 1_000_000n }), { ownerKey: owner, amountLamports: 1_000_001n }),
    ).rejects.toMatchObject({ code: "over_tx_cap" });

    // Window still open with 900k of 1M used: only 100k remains.
    await expect(
      approveWithdrawal(
        makeCtx(l1, { maxWithdrawPerWindow: 1_000_000n, windowWithdrawn: 900_000n }),
        { ownerKey: owner, amountLamports: 1_000_000n },
      ),
    ).rejects.toMatchObject({ code: "over_window_cap" });
    // Window expired: the full cap is available again.
    await expect(
      approveWithdrawal(
        makeCtx(l1, { maxWithdrawPerWindow: 1_000_000n, windowWithdrawn: 900_000n, windowStartOffsetSec: -7200 }),
        { ownerKey: owner, amountLamports: 1_000_000n },
      ),
    ).resolves.toBeTruthy();

    const l2 = make();
    fund(l2, owner, 5_000_000n);
    await expect(
      approveWithdrawal(makeCtx(l2, { destBalance: 0 }), { ownerKey: owner, amountLamports: BigInt(RENT_MIN - 1) }),
    ).rejects.toMatchObject({ code: "below_rent_exempt" });
    expect(l2.listOpenHolds()).toHaveLength(0);
  });

  it("house withdrawals only pay the admin and draw on the house bankroll", async () => {
    const ledgerNoAdmin = make();
    const ctx0 = makeCtx(ledgerNoAdmin);
    await expect(prepareHouseWithdrawal(ctx0, 1_000_000n)).rejects.toMatchObject({
      code: "destination_mismatch",
    });

    // Build a ctx whose ledger knows the admin key.
    const probe = makeCtx(make());
    const ledger = make({ adminKey: probe.admin.publicKey.toBase58() });
    const ctx = { ...probe, ledger };
    ledger.applyDepositEvent("h:cpi:0:0", { user: probe.admin.publicKey.toBase58(), amount: 3_000_000n });
    const { hold, tx } = await prepareHouseWithdrawal(ctx, 2_000_000n);
    expect(hold.isHouse).toBe(true);
    expect(hold.destination).toBe(probe.admin.publicKey.toBase58());
    expect(tx.feePayer?.equals(probe.admin.publicKey)).toBe(true);
    expect(ledger.houseBalance()).toEqual({ available: 1_000_000n, pending: 2_000_000n });
  });
});

describe("parseLamports", () => {
  it("accepts only positive decimal strings within u64", () => {
    expect(parseLamports("1")).toBe(1n);
    expect(parseLamports("18446744073709551615")).toBe((1n << 64n) - 1n);
    for (const bad of [1000, "0", "-5", "0x10", "1e9", " 5", "05", "18446744073709551616", "1.5", null]) {
      expect(() => parseLamports(bad)).toThrow();
    }
  });
});

describe("HTTP API", () => {
  const TOKEN = "t".repeat(32);
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
  });

  async function start(ctx: ServiceContext, auth = { apiToken: TOKEN, allowUnauthenticated: false }) {
    server = createApi(ctx, auth);
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  const authz = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

  it("requires the bearer token on everything but /health", async () => {
    const ledger = LEDGERS[0][1]();
    const base = await start(makeCtx(ledger));
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/balance?owner=x`)).status).toBe(401);
    expect(
      (await fetch(`${base}/balance?owner=x`, { headers: { authorization: "Bearer wrong" } })).status,
    ).toBe(401);
    expect((await fetch(`${base}/balance?owner=x`, { headers: authz })).status).toBe(200);
    const w = await fetch(`${base}/withdraw`, {
      method: "POST",
      body: JSON.stringify({ owner: addr().toBase58(), amountLamports: "1" }),
    });
    expect(w.status).toBe(401);
  });

  it("ALLOW_UNAUTHENTICATED skips the token check (local dev)", async () => {
    const base = await start(makeCtx(LEDGERS[0][1]()), { apiToken: undefined as never, allowUnauthenticated: true });
    expect((await fetch(`${base}/balance?owner=x`)).status).toBe(200);
  });

  it("rejects a `house` field (no house withdrawals over HTTP)", async () => {
    const ledger = LEDGERS[1][1]();
    const ctx = makeCtx(ledger);
    const base = await start(ctx);
    const res = await fetch(`${base}/withdraw`, {
      method: "POST",
      headers: authz,
      body: JSON.stringify({
        owner: ctx.admin.publicKey.toBase58(),
        destination: ctx.admin.publicKey.toBase58(),
        amountLamports: "1000000",
        house: true,
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/unknown field/);
    expect(ledger.listOpenHolds()).toHaveLength(0);
  });

  it("enforces the body size limit and strict amounts", async () => {
    const ledger = LEDGERS[0][1]();
    const base = await start(makeCtx(ledger));
    const owner = addr().toBase58();
    fund(ledger, owner, 5_000_000n);
    const big = await fetch(`${base}/withdraw`, {
      method: "POST",
      headers: authz,
      body: JSON.stringify({ owner, amountLamports: "1", pad: "x".repeat(20_000) }),
    });
    expect(big.status).toBe(413);
    for (const amountLamports of [1000000, "0x10", "-5", "1e6"]) {
      const res = await fetch(`${base}/withdraw`, {
        method: "POST",
        headers: authz,
        body: JSON.stringify({ owner, amountLamports }),
      });
      expect(res.status).toBe(400);
    }
    const ok = await fetch(`${base}/withdraw`, {
      method: "POST",
      headers: authz,
      body: JSON.stringify({ owner, amountLamports: "1000000" }),
    });
    expect(ok.status).toBe(200);
    expect(ledger.getBalance(owner).pending).toBe(1_000_000n);
  });

  it("refuses destination != owner and returns 503 while the kill-switch is set", async () => {
    const ledger = LEDGERS[0][1]();
    const base = await start(makeCtx(ledger));
    const owner = addr().toBase58();
    fund(ledger, owner, 5_000_000n);
    const mismatch = await fetch(`${base}/withdraw`, {
      method: "POST",
      headers: authz,
      body: JSON.stringify({ owner, destination: addr().toBase58(), amountLamports: "1000000" }),
    });
    expect(mismatch.status).toBe(400);
    ledger.openIncident("leak");
    const blocked = await fetch(`${base}/withdraw`, {
      method: "POST",
      headers: authz,
      body: JSON.stringify({ owner, amountLamports: "1000000" }),
    });
    expect(blocked.status).toBe(503);
    expect(ledger.listOpenHolds()).toHaveLength(0);
  });

  it("returns a generic message for internal errors and redacts the server log", async () => {
    const ledger = LEDGERS[0][1]();
    const base = await start(
      makeCtx(ledger, { breakState: new Error("rpc https://user:pw@rpc.example/?api-key=abc123 failed") }),
    );
    const owner = addr().toBase58();
    fund(ledger, owner, 5_000_000n);
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      logged.push(a.join(" "));
    });
    try {
      const res = await fetch(`${base}/withdraw`, {
        method: "POST",
        headers: authz,
        body: JSON.stringify({ owner, amountLamports: "1000000" }),
      });
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: "internal error" });
      expect(text).not.toContain("abc123");
    } finally {
      spy.mockRestore();
    }
    const line = logged.join("\n");
    expect(line).toContain("[REDACTED]");
    expect(line).not.toContain("abc123");
    expect(line).not.toContain("user:pw");
  });

  it("ApprovalError is the only error class whose message reaches callers", () => {
    expect(new ApprovalError("x", 400, "safe").message).toBe("safe");
  });
});
