import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LedgerBindingError, verifyLedgerBinding } from "../src/binding";
import { SqliteLedger } from "../src/ledger/sqlite";
import { clearIncidentChecked, openMismatchedHolds } from "../src/services/incident";
import { LEDGERS, addr } from "./helpers";

const genesis = (hash: string) => ({ getGenesisHash: async () => hash });

describe.each(LEDGERS)("ledger cluster/program binding (%s)", (_name, make) => {
  it("binds on first open, then refuses another genesis hash or program id", async () => {
    const ledger = make();
    const program = addr();
    expect(await verifyLedgerBinding(ledger, genesis("devnet"), program)).toBe("bound");
    expect(ledger.getChainBinding()).toEqual({ genesisHash: "devnet", programId: program.toBase58() });
    expect(await verifyLedgerBinding(ledger, genesis("devnet"), program)).toBe("verified");
    await expect(verifyLedgerBinding(ledger, genesis("mainnet"), program)).rejects.toThrow(
      /genesis hash/,
    );
    await expect(verifyLedgerBinding(ledger, genesis("devnet"), addr())).rejects.toBeInstanceOf(
      LedgerBindingError,
    );
    // read-only callers compare too
    await expect(
      verifyLedgerBinding(ledger, genesis("mainnet"), program, { readOnly: true }),
    ).rejects.toThrow(/refusing to run/);
  });

  it("read-only callers never write a binding", async () => {
    const ledger = make();
    expect(await verifyLedgerBinding(ledger, genesis("devnet"), addr(), { readOnly: true })).toBe("unbound");
    expect(ledger.getChainBinding()).toBeNull();
  });
});

describe("SqliteLedger binding persistence and fileMustExist", () => {
  it("the binding survives a reopen (incl. read-only) and a mismatch is refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cv-bind-"));
    const path = join(dir, "ledger.db");
    const program = addr();
    try {
      const rw = new SqliteLedger(path);
      await verifyLedgerBinding(rw, genesis("devnet"), program);
      rw.close();
      const ro = new SqliteLedger(path, { readOnly: true });
      expect(await verifyLedgerBinding(ro, genesis("devnet"), program, { readOnly: true })).toBe("verified");
      await expect(
        verifyLedgerBinding(ro, genesis("localnet"), program, { readOnly: true }),
      ).rejects.toBeInstanceOf(LedgerBindingError);
      ro.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fileMustExist (incident clear, house-withdraw) fails on a missing file instead of creating one", () => {
    const dir = mkdtempSync(join(tmpdir(), "cv-must-"));
    const path = join(dir, "typo.db");
    try {
      expect(() => new SqliteLedger(path, { fileMustExist: true })).toThrow();
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.each(LEDGERS)("incident clear (%s)", (_name, make) => {
  it("refuses while a hold named by a WithdrawEvent mismatch is open; --force clears", () => {
    const ledger = make();
    const owner = addr().toBase58();
    ledger.credit(owner, 1000n, "seed");
    const hold = ledger.placeHold({ ownerKey: owner, amount: 400n, destination: owner, lastValidBlockHeight: 10 });
    // A WithdrawEvent with this request_id but another amount: mismatch, the hold stays open.
    const outcome = ledger.applyWithdrawEvent("evil:cpi:0:0", {
      requestId: hold.requestId,
      user: owner,
      amount: 999n,
      txSignature: "evil",
    });
    expect(outcome.kind).toBe("mismatch");
    expect(openMismatchedHolds(ledger).map((h) => h.requestId)).toEqual([hold.requestId]);

    const r = clearIncidentChecked(ledger);
    expect(r.kind).toBe("refused");
    expect(r.kind === "refused" && r.holds[0].requestId).toBe(hold.requestId);
    expect(ledger.getIncident()).not.toBeNull();

    expect(clearIncidentChecked(ledger, { force: true }).kind).toBe("cleared");
    expect(ledger.getIncident()).toBeNull();
  });

  it("clears normally once the mismatched hold is no longer open", () => {
    const ledger = make();
    const owner = addr().toBase58();
    ledger.credit(owner, 1000n, "seed");
    const hold = ledger.placeHold({ ownerKey: owner, amount: 400n, destination: owner, lastValidBlockHeight: 10 });
    ledger.applyWithdrawEvent("evil:cpi:0:0", { requestId: hold.requestId, user: owner, amount: 1n, txSignature: "evil" });
    // Operator resolves it (here: the genuine settlement arrives).
    ledger.applyWithdrawEvent("good:cpi:0:0", { requestId: hold.requestId, user: owner, amount: 400n, txSignature: "good" });
    expect(openMismatchedHolds(ledger)).toEqual([]);
    expect(clearIncidentChecked(ledger).kind).toBe("cleared");
    expect(clearIncidentChecked(ledger).kind).toBe("not_open");
  });
});
