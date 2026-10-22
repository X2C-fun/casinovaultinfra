import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { loadApiAuthConfig, loadConfig } from "../src/config";
import { loadAdminKeypair, redactSecrets, safeErrorMessage } from "../src/admin";
import { SqliteLedger } from "../src/ledger/sqlite";

describe("config", () => {
  it("refuses LEDGER=memory outside tests unless explicitly allowed", () => {
    expect(() => loadConfig({ LEDGER: "memory", NODE_ENV: "production" })).toThrow(/tests only/);
    expect(loadConfig({ LEDGER: "memory", NODE_ENV: "production", ALLOW_MEMORY_LEDGER: "true" }).ledger).toBe("memory");
    expect(loadConfig({ LEDGER: "memory", NODE_ENV: "test" }).ledger).toBe("memory");
    expect(loadConfig({}).ledger).toBe("sqlite");
  });

  it("binds loopback by default and reads listener options", () => {
    const c = loadConfig({ UPGRADE_SLOT: "123", START_AFTER_SIGNATURE: "abc" });
    expect(c.host).toBe("127.0.0.1");
    expect(c.upgradeSlot).toBe(123);
    expect(c.startAfterSignature).toBe("abc");
    expect(loadConfig({ HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
    expect(() => loadConfig({ UPGRADE_SLOT: "-1" })).toThrow();
  });

  it("requires API_TOKEN unless ALLOW_UNAUTHENTICATED=true", () => {
    expect(() => loadApiAuthConfig({})).toThrow(/API_TOKEN/);
    expect(() => loadApiAuthConfig({ API_TOKEN: "short" })).toThrow(/16/);
    expect(loadApiAuthConfig({ API_TOKEN: "x".repeat(16) }).apiToken).toBe("x".repeat(16));
    expect(loadApiAuthConfig({ ALLOW_UNAUTHENTICATED: "true" })).toEqual({
      apiToken: undefined,
      allowUnauthenticated: true,
    });
  });

  it("rejects the .env.example placeholder token, and .env.example ships it empty", () => {
    expect(() => loadApiAuthConfig({ API_TOKEN: "change-me-to-a-long-random-string" })).toThrow(/placeholder/);
    expect(() => loadApiAuthConfig({ API_TOKEN: "CHANGE-ME-xxxxxxxxxxxxxxxx" })).toThrow(/placeholder/);
    const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
    const line = example.split(/\r?\n/).find((l) => l.startsWith("API_TOKEN="));
    expect(line).toBe("API_TOKEN=");
  });

  it("allows ALLOW_UNAUTHENTICATED only on a loopback HOST", () => {
    for (const HOST of ["127.0.0.1", "::1", "localhost", undefined]) {
      expect(loadApiAuthConfig({ ALLOW_UNAUTHENTICATED: "true", HOST }).allowUnauthenticated).toBe(true);
    }
    for (const HOST of ["0.0.0.0", "::", "10.0.0.5", "example.com"]) {
      expect(() => loadApiAuthConfig({ ALLOW_UNAUTHENTICATED: "true", HOST })).toThrow(/loopback/);
    }
    // A real token works on any host.
    expect(loadApiAuthConfig({ API_TOKEN: "x".repeat(32), HOST: "0.0.0.0" }).apiToken).toBeTruthy();
  });

  it("validates COMPUTE_UNIT_LIMIT (1..1,400,000) and the priority fee bound at startup", () => {
    expect(loadConfig({ COMPUTE_UNIT_LIMIT: "60000" }).computeUnitLimit).toBe(60_000);
    expect(loadConfig({ COMPUTE_UNIT_LIMIT: "1400000" }).computeUnitLimit).toBe(1_400_000);
    expect(() => loadConfig({ COMPUTE_UNIT_LIMIT: "0" })).toThrow(/COMPUTE_UNIT_LIMIT/);
    expect(() => loadConfig({ COMPUTE_UNIT_LIMIT: "1400001" })).toThrow(/COMPUTE_UNIT_LIMIT/);
    // ceil(price * limit / 1e6) must stay <= MAX_PRIORITY_FEE_LAMPORTS (1,000,000).
    expect(loadConfig({ COMPUTE_UNIT_PRICE_MICRO_LAMPORTS: "714285" }).computeUnitPriceMicroLamports).toBe(714_285n);
    expect(() => loadConfig({ COMPUTE_UNIT_PRICE_MICRO_LAMPORTS: "714286" })).toThrow(/MAX_PRIORITY_FEE_LAMPORTS/);
    expect(
      loadConfig({ COMPUTE_UNIT_PRICE_MICRO_LAMPORTS: "5000000", COMPUTE_UNIT_LIMIT: "200000" })
        .computeUnitPriceMicroLamports,
    ).toBe(5_000_000n);
    expect(() =>
      loadConfig({ COMPUTE_UNIT_PRICE_MICRO_LAMPORTS: "5000001", COMPUTE_UNIT_LIMIT: "200000" }),
    ).toThrow(/MAX_PRIORITY_FEE_LAMPORTS/);
    expect(() => loadConfig({ COMPUTE_UNIT_PRICE_MICRO_LAMPORTS: "18446744073709551616" })).toThrow(/u64/);
  });

  it(".env.example's UPGRADE_SLOT example is the canonical devnet upgrade slot", () => {
    const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
    expect(example).toMatch(/^# UPGRADE_SLOT=512813387 /m);
  });

  it("reads LISTENER_MAX_BACKLOG", () => {
    expect(loadConfig({ LISTENER_MAX_BACKLOG: "50000" }).listenerMaxBacklog).toBe(50000);
    expect(loadConfig({}).listenerMaxBacklog).toBeUndefined();
    expect(loadConfig({ LISTENER_MAX_BACKLOG: "1000" }).listenerMaxBacklog).toBe(1000);
    expect(() => loadConfig({ LISTENER_MAX_BACKLOG: "0" })).toThrow(/at least 1000/);
    expect(() => loadConfig({ LISTENER_MAX_BACKLOG: "999" })).toThrow(/at least 1000/);
    expect(loadConfig({ LISTENER_NOT_FOUND_INCIDENT_CYCLES: "3" }).listenerNotFoundIncidentCycles).toBe(3);
    expect(() => loadConfig({ LISTENER_NOT_FOUND_INCIDENT_CYCLES: "0" })).toThrow(/at least 1/);
    expect(loadConfig({}).houseBankrollLamports).toBe(0n);
    expect(loadConfig({ HOUSE_BANKROLL_LAMPORTS: "123" }).houseBankrollLamports).toBe(123n);
    expect(() => loadConfig({ HOUSE_BANKROLL_LAMPORTS: "-1" })).toThrow(/HOUSE_BANKROLL_LAMPORTS/);
  });
});

describe("loadAdminKeypair", () => {
  it("loads JSON-array keys", () => {
    const kp = Keypair.generate();
    expect(loadAdminKeypair(JSON.stringify([...kp.secretKey])).publicKey.equals(kp.publicKey)).toBe(true);
  });

  it("never echoes the secret in its errors", () => {
    const secretish = "[12,34,56,SECRETBYTES";
    for (const bad of [secretish, "[1,2,3]", "SECRET0OIl", "[" + "999,".repeat(63) + "999]"]) {
      let msg = "";
      try {
        loadAdminKeypair(bad);
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toMatch(/^ADMIN_SECRET_KEY/);
      expect(msg).not.toContain("SECRET0");
      expect(msg).not.toContain("SECRETBYTES");
      expect(msg).not.toContain("12,34");
    }
  });
});

describe("log redaction", () => {
  it("redacts URL credentials, secret query params and the configured RPC_URL", () => {
    const rpc = "https://mainnet.helius-rpc.com/v1/SECRETPATHKEY";
    const msg =
      `fetch ${rpc} failed; also https://user:pass@a.example/x, wss://tok123@b.example, ` +
      "https://c.example/rpc?api-key=K1&foo=1&apikey=K2&token=K3&key=K4&access_token=K5";
    const out = redactSecrets(msg, rpc);
    for (const secret of ["SECRETPATHKEY", "user:pass", "tok123", "K1", "K2", "K3", "K4", "K5"]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain("[RPC_URL]");
    expect(out).toContain("foo=1");
  });

  it("safeErrorMessage applies the redaction", () => {
    expect(safeErrorMessage(new Error("GET https://x:y@h/?token=abc"))).not.toMatch(/x:y|abc/);
  });
});

describe("SqliteLedger read-only open (reconcile)", () => {
  it("fails on a missing file instead of creating an empty ledger, and reads an existing one", () => {
    const dir = mkdtempSync(join(tmpdir(), "cv-ledger-"));
    try {
      const path = join(dir, "ledger.db");
      expect(() => new SqliteLedger(path, { readOnly: true })).toThrow();
      const rw = new SqliteLedger(path);
      rw.credit("alice", 5n, "d:0");
      rw.close();
      const ro = new SqliteLedger(path, { readOnly: true });
      expect(ro.totals().available).toBe(5n);
      expect(() => ro.credit("alice", 1n, "d:1")).toThrow(/readonly/i);
      ro.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
