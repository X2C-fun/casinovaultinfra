import { describe, it, expect } from "vitest";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  solToLamports,
  lamportsToSol,
  reconcilePool,
  eventSourceKey,
  deriveVaultStatePda,
  derivePoolVaultPda,
  DEFAULT_PROGRAM_ID,
  getReadonlyProgram,
  buildWithdrawTransaction,
  assertSafeWithdrawTx,
  UnsafeWithdrawTxError,
} from "./index";

describe("format", () => {
  it("parses SOL to exact lamports with no float error", () => {
    expect(solToLamports("0.1")).toBe(100_000_000n);
    expect(solToLamports("1")).toBe(1_000_000_000n);
    expect(solToLamports(".000000001")).toBe(1n);
  });

  it("rejects bad amounts", () => {
    expect(() => solToLamports("0")).toThrow();
    expect(() => solToLamports("1e3")).toThrow();
    expect(() => solToLamports("0.0000000001")).toThrow(); // 10 decimals
    expect(() => solToLamports("-1")).toThrow();
  });

  it("formats lamports back to SOL", () => {
    expect(lamportsToSol(1_000_000_000n)).toMatch(/^1\.0{2,}$/);
  });
});

describe("reconcilePool", () => {
  it("is balanced when pool equals liabilities + bankroll + reserve", () => {
    const r = reconcilePool({
      poolBalance: 1_000n,
      playerBalancesTotal: 600n,
      houseBankroll: 300n,
      rentReserve: 100n,
    });
    expect(r.balanced).toBe(true);
    expect(r.solvent).toBe(true);
    expect(r.difference).toBe(0n);
  });

  it("flags a shortfall as insolvent", () => {
    const r = reconcilePool({
      poolBalance: 900n,
      playerBalancesTotal: 600n,
      houseBankroll: 300n,
      rentReserve: 100n,
    });
    expect(r.solvent).toBe(false);
    expect(r.difference).toBe(-100n);
  });

  it("reports a surplus without failing solvency", () => {
    const r = reconcilePool({
      poolBalance: 1_100n,
      playerBalancesTotal: 600n,
      houseBankroll: 300n,
      rentReserve: 100n,
    });
    expect(r.solvent).toBe(true);
    expect(r.balanced).toBe(false);
    expect(r.difference).toBe(100n);
  });
});

describe("pdas + events", () => {
  it("derives deterministic PDAs", () => {
    const [a] = deriveVaultStatePda(DEFAULT_PROGRAM_ID);
    const [b] = deriveVaultStatePda(DEFAULT_PROGRAM_ID);
    expect(a.equals(b)).toBe(true);
    const [pool] = derivePoolVaultPda(DEFAULT_PROGRAM_ID);
    expect(pool.equals(a)).toBe(false);
  });

  it("builds a source-based event key", () => {
    expect(
      eventSourceKey({ signature: "sig", instructionIndex: 1, eventIndex: 2 }),
    ).toBe("sig:1:2");
  });
});

describe("assertSafeWithdrawTx", () => {
  // No network: building the instruction and asserting it are both offline.
  const connection = new Connection("http://localhost:8899");
  const program = getReadonlyProgram(connection);
  const userKp = Keypair.generate();
  const adminKp = Keypair.generate();
  const user = userKp.publicKey;
  const admin = adminKp.publicKey;

  // Mirrors the real flow: the backend builds the tx, sets a blockhash, and
  // partial-signs with the admin key before handing it to the client.
  async function serverBuilt(amount: bigint, requestId: bigint) {
    const tx = await buildWithdrawTransaction(program, {
      user,
      admin,
      amountLamports: amount,
      requestId,
    });
    tx.recentBlockhash = Keypair.generate().publicKey.toBase58(); // dummy 32-byte base58
    tx.partialSign(adminKp);
    return tx;
  }

  it("accepts a well-formed withdraw it built", async () => {
    const tx = await serverBuilt(500_000n, 42n);
    expect(() =>
      assertSafeWithdrawTx(tx, {
        user,
        expectedLamports: 500_000n,
        expectedRequestId: 42n,
        expectedAdmin: admin,
      }),
    ).not.toThrow();
  });

  it("rejects a mismatched amount", async () => {
    const tx = await serverBuilt(500_000n, 42n);
    expect(() =>
      assertSafeWithdrawTx(tx, {
        user,
        expectedLamports: 999_999n,
        expectedRequestId: 42n,
        expectedAdmin: admin,
      }),
    ).toThrow(UnsafeWithdrawTxError);
  });

  it("rejects a wrong request id and a wrong recipient", async () => {
    const tx = await serverBuilt(500_000n, 42n);
    expect(() =>
      assertSafeWithdrawTx(tx, {
        user,
        expectedLamports: 500_000n,
        expectedRequestId: 7n,
        expectedAdmin: admin,
      }),
    ).toThrow(UnsafeWithdrawTxError);
    expect(() =>
      assertSafeWithdrawTx(tx, {
        user: PublicKey.default,
        expectedLamports: 500_000n,
        expectedRequestId: 42n,
        expectedAdmin: admin,
      }),
    ).toThrow(UnsafeWithdrawTxError);
  });
});
