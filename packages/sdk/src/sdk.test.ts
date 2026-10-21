import { describe, it, expect } from "vitest";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import * as sdk from "./index";
import {
  solToLamports,
  lamportsToSol,
  reconcilePool,
  eventSourceKey,
  deriveVaultStatePda,
  derivePoolVaultPda,
  deriveEventAuthorityPda,
  DEFAULT_PROGRAM_ID,
  getReadonlyProgram,
  buildDepositIx,
  buildWithdrawIx,
  buildSetLimitsIx,
  buildWithdrawTransaction,
  assertSafeWithdrawTx,
  toU64Bn,
  UnsafeWithdrawTxError,
  MAX_PRIORITY_FEE_LAMPORTS,
  LAMPORTS_PER_SOL_BIGINT,
} from "./index";

const U64_MAX = (1n << 64n) - 1n;
const utf8 = (s: string) => new TextEncoder().encode(s);

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

  it("formats lamports back to SOL exactly and locale-independently", () => {
    expect(lamportsToSol(1_000_000_000n)).toBe("1.00");
    expect(lamportsToSol(0n)).toBe("0.00");
    expect(lamportsToSol(1n)).toBe("0.000000001");
    expect(lamportsToSol(250_000_000n)).toBe("0.25");
    expect(lamportsToSol(500_000_000)).toBe("0.50");
    expect(lamportsToSol(1_234_567_890_123n)).toBe("1234.567890123");
    expect(lamportsToSol(U64_MAX)).toBe("18446744073.709551615");
    expect(lamportsToSol(-1_500_000_000n)).toBe("-1.50");
    expect(() => lamportsToSol(0.5)).toThrow(RangeError);
  });

  it("exports the bigint constant under a non-clashing name", () => {
    expect(LAMPORTS_PER_SOL_BIGINT).toBe(1_000_000_000n);
    expect("LAMPORTS_PER_SOL" in sdk).toBe(false);
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

describe("pdas", () => {
  it("match addresses derived independently from the literal program seeds", () => {
    const programId = new PublicKey("EXTH5XRAqc45efhoL5UjwhhLFV4smgaB4m6QVG74Vqa7");
    expect(DEFAULT_PROGRAM_ID.equals(programId)).toBe(true);
    const [state, stateBump] = PublicKey.findProgramAddressSync(
      [utf8("vault_state_v2")],
      programId,
    );
    const [pool, poolBump] = PublicKey.findProgramAddressSync([utf8("pool_vault")], programId);
    const [eventAuthority] = PublicKey.findProgramAddressSync(
      [utf8("__event_authority")],
      programId,
    );
    expect(deriveVaultStatePda(programId)[0].equals(state)).toBe(true);
    expect(deriveVaultStatePda(programId)[1]).toBe(stateBump);
    expect(derivePoolVaultPda(programId)[0].equals(pool)).toBe(true);
    expect(derivePoolVaultPda(programId)[1]).toBe(poolBump);
    expect(deriveEventAuthorityPda(programId)[0].equals(eventAuthority)).toBe(true);
    // Defaults target the canonical deployment.
    expect(deriveVaultStatePda()[0].equals(state)).toBe(true);
  });

  it("keeps the deprecated source key format", () => {
    expect(eventSourceKey({ signature: "sig", instructionIndex: 1, eventIndex: 2 })).toBe(
      "sig:1:2",
    );
  });
});

// No network: building instructions and asserting them are both offline.
const connection = new Connection("http://localhost:8899");
const program = getReadonlyProgram(connection);

describe("u64 argument validation", () => {
  const depositor = Keypair.generate().publicKey;
  const user = Keypair.generate().publicKey;
  const admin = Keypair.generate().publicKey;
  const authority = Keypair.generate().publicKey;

  it("toU64Bn accepts the full u64 range", () => {
    expect(toU64Bn("x", 0n).toString()).toBe("0");
    expect(toU64Bn("x", U64_MAX).toString()).toBe(U64_MAX.toString());
    expect(toU64Bn("x", 7).toString()).toBe("7");
  });

  it("toU64Bn rejects negatives, overflow and non-integers", () => {
    expect(() => toU64Bn("amount", -1n)).toThrow(/amount must be a u64/);
    expect(() => toU64Bn("amount", U64_MAX + 1n)).toThrow(RangeError);
    expect(() => toU64Bn("amount", 1.5)).toThrow(RangeError);
    expect(() => toU64Bn("amount", Number.MAX_SAFE_INTEGER + 2)).toThrow(RangeError);
  });

  it("deposit rejects an out-of-range amount instead of flipping its sign", async () => {
    expect(() => buildDepositIx(program, { depositor, amountLamports: -5n })).toThrow(
      /amountLamports must be a u64/,
    );
    expect(() => buildDepositIx(program, { depositor, amountLamports: 1n << 64n })).toThrow(
      RangeError,
    );
    const ix = await buildDepositIx(program, { depositor, amountLamports: U64_MAX });
    expect(new DataView(ix.data.buffer, ix.data.byteOffset).getBigUint64(8, true)).toBe(U64_MAX);
  });

  it("withdraw validates amount and requestId", () => {
    expect(() =>
      buildWithdrawIx(program, { user, admin, amountLamports: 1n, requestId: -1n }),
    ).toThrow(/requestId must be a u64/);
    expect(() =>
      buildWithdrawIx(program, { user, admin, amountLamports: -1n, requestId: 1n }),
    ).toThrow(/amountLamports must be a u64/);
  });

  it("set_limits validates both caps and the u32 window", () => {
    const base = { authority, maxWithdrawPerTx: 1n, maxWithdrawPerWindow: 1n, windowSeconds: 60 };
    expect(() => buildSetLimitsIx(program, { ...base, maxWithdrawPerTx: -1n })).toThrow(
      /maxWithdrawPerTx/,
    );
    expect(() =>
      buildSetLimitsIx(program, { ...base, maxWithdrawPerWindow: U64_MAX + 1n }),
    ).toThrow(/maxWithdrawPerWindow/);
    expect(() => buildSetLimitsIx(program, { ...base, windowSeconds: -1 })).toThrow(
      /windowSeconds/,
    );
    expect(() => buildSetLimitsIx(program, { ...base, windowSeconds: 2 ** 32 })).toThrow(
      /windowSeconds/,
    );
  });
});

describe("withdraw transaction", () => {
  const userKp = Keypair.generate();
  const adminKp = Keypair.generate();
  const user = userKp.publicKey;
  const admin = adminKp.publicKey;
  const opts = {
    user,
    expectedLamports: 500_000n,
    expectedRequestId: 42n,
    expectedAdmin: admin,
  };

  // Mirrors the real flow: the backend builds the tx, sets a blockhash, and
  // partial-signs with the admin key before handing it to the client.
  async function serverBuilt(
    extra: { computeUnitPriceMicroLamports?: bigint; computeUnitLimit?: number } = {},
  ) {
    const tx = await buildWithdrawTransaction(program, {
      user,
      admin,
      amountLamports: 500_000n,
      requestId: 42n,
      ...extra,
    });
    tx.recentBlockhash = Keypair.generate().publicKey.toBase58(); // dummy 32-byte base58
    tx.partialSign(adminKp);
    return tx;
  }

  /** Replaces the withdraw instruction with a tampered copy. */
  function tamper(
    tx: Transaction,
    edit: (ix: { programId: PublicKey; keys: TransactionInstruction["keys"]; data: Buffer }) => void,
  ) {
    const last = tx.instructions[tx.instructions.length - 1];
    const copy = {
      programId: last.programId,
      keys: last.keys.map((k) => ({ ...k })),
      data: Buffer.from(last.data),
    };
    edit(copy);
    tx.instructions[tx.instructions.length - 1] = new TransactionInstruction(copy);
  }

  const rejects = (tx: Transaction, reason: RegExp, o = opts) => {
    expect(() => assertSafeWithdrawTx(tx, o)).toThrow(UnsafeWithdrawTxError);
    expect(() => assertSafeWithdrawTx(tx, o)).toThrow(reason);
  };

  it("accepts a well-formed withdraw it built", async () => {
    const tx = await serverBuilt();
    expect(() => assertSafeWithdrawTx(tx, opts)).not.toThrow();
  });

  it("rejects a mismatched amount, request id and recipient", async () => {
    const tx = await serverBuilt();
    rejects(tx, /amount/, { ...opts, expectedLamports: 999_999n });
    rejects(tx, /request ID/, { ...opts, expectedRequestId: 7n });
    rejects(tx, /fee payer/, { ...opts, user: PublicKey.default });
  });

  it("rejects a wrong instruction discriminator", async () => {
    const tx = await serverBuilt();
    tamper(tx, (ix) => {
      ix.data[0] ^= 0xff;
    });
    rejects(tx, /not withdraw/);
  });

  it("rejects a wrong fee payer", async () => {
    const tx = await serverBuilt();
    tx.feePayer = adminKp.publicKey;
    rejects(tx, /fee payer/);
  });

  it("rejects an extra non-ComputeBudget instruction", async () => {
    const tx = await serverBuilt();
    tx.instructions.unshift(
      SystemProgram.transfer({ fromPubkey: user, toPubkey: admin, lamports: 1_000_000_000 }),
    );
    rejects(tx, /unexpected instruction before withdraw/);
  });

  it("rejects a withdraw sent to a different program", async () => {
    const tx = await serverBuilt();
    tamper(tx, (ix) => {
      ix.programId = Keypair.generate().publicKey;
    });
    rejects(tx, /different program/);
  });

  it("rejects a priority fee above the ceiling", async () => {
    const tx = await serverBuilt();
    tx.instructions.unshift(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000_000n }),
    );
    rejects(tx, /priority fee/);
  });

  it("rejects too many ComputeBudget instructions", async () => {
    const tx = await serverBuilt();
    for (let i = 0; i < 5; i++) {
      tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 }));
    }
    rejects(tx, /too many ComputeBudget/);
  });

  it("rejects a wrong event authority", async () => {
    const tx = await serverBuilt();
    tamper(tx, (ix) => {
      ix.keys[5].pubkey = Keypair.generate().publicKey;
    });
    rejects(tx, /event authority/);
  });

  it("rejects a wrong program account", async () => {
    const tx = await serverBuilt();
    tamper(tx, (ix) => {
      ix.keys[6].pubkey = Keypair.generate().publicKey;
    });
    rejects(tx, /program account/);
  });

  it("rejects an extra signer", async () => {
    const tx = await serverBuilt();
    tx.signatures.push({ publicKey: Keypair.generate().publicKey, signature: null });
    rejects(tx, /signer set/);
  });

  it("rejects a VersionedTransaction", async () => {
    const tx = await serverBuilt();
    const vtx = new VersionedTransaction(tx.compileMessage());
    rejects(vtx as unknown as Transaction, /VersionedTransaction/);
  });

  it("builder honours computeUnitLimit without a price", async () => {
    const tx = await serverBuilt({ computeUnitLimit: 50_000 });
    expect(tx.instructions).toHaveLength(2);
    expect(tx.instructions[0].programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(tx.instructions[0].data[0]).toBe(2); // SetComputeUnitLimit
    expect(() => assertSafeWithdrawTx(tx, opts)).not.toThrow();
  });

  it("builder accepts a priority fee within the ceiling and the assert agrees", async () => {
    // 1.4M CU * 714_285 µL / 1e6 = 999_999 lamports.
    const tx = await serverBuilt({ computeUnitPriceMicroLamports: 714_285n });
    expect(() => assertSafeWithdrawTx(tx, opts)).not.toThrow();
    // A limit lets a higher price through: 200k CU * 5M µL / 1e6 = 1M lamports.
    const tx2 = await serverBuilt({
      computeUnitPriceMicroLamports: 5_000_000n,
      computeUnitLimit: 200_000,
    });
    expect(tx2.instructions).toHaveLength(3);
    expect(() => assertSafeWithdrawTx(tx2, opts)).not.toThrow();
  });

  it("builder refuses what the assert would reject", async () => {
    await expect(serverBuilt({ computeUnitPriceMicroLamports: 714_286n })).rejects.toThrow(
      /MAX_PRIORITY_FEE_LAMPORTS/,
    );
    await expect(
      serverBuilt({ computeUnitPriceMicroLamports: 5_000_001n, computeUnitLimit: 200_000 }),
    ).rejects.toThrow(RangeError);
    await expect(serverBuilt({ computeUnitLimit: 0 })).rejects.toThrow(/computeUnitLimit/);
    await expect(serverBuilt({ computeUnitLimit: 1_400_001 })).rejects.toThrow(
      /computeUnitLimit/,
    );
    await expect(serverBuilt({ computeUnitPriceMicroLamports: -1n })).rejects.toThrow(
      RangeError,
    );
    expect(MAX_PRIORITY_FEE_LAMPORTS).toBe(1_000_000n);
  });
});
