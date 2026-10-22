/**
 * Unit tests for `sendWithRetry` in scripts/common.ts. They stub the RPC
 * connection, so they need no validator and also run with
 *   npx ts-mocha -p ./tsconfig.json tests/send_with_retry.ts
 *
 * The property under test: a second transaction (a second deposit or
 * withdrawal) is built only after the first one is PROVEN expired. Every
 * uncertain answer must keep re-sending the same signed bytes.
 */

import * as anchor from "@coral-xyz/anchor";
import {
  Keypair,
  SignatureStatus,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { assert } from "chai";

import { sendWithRetry } from "../scripts/common";

const LAST_VALID = 1_000;
const FINALIZED_SLOT = 5_000;

type StatusAnswer = SignatureStatus | null | Error;

interface Script {
  /** `getSignatureStatuses` without history (the regular poll). */
  recent?: (builds: number) => StatusAnswer;
  /** `getSignatureStatuses` with `searchTransactionHistory: true`. */
  history?: (call: number) => StatusAnswer;
  /** Context slot of the history lookup. */
  historySlot?: number;
  /** `getEpochInfo("finalized").blockHeight`, or an error. */
  finalizedHeight?: number | Error;
}

const confirmed: SignatureStatus = {
  slot: 1,
  confirmations: 1,
  err: null,
  confirmationStatus: "confirmed",
};

function harness(script: Script) {
  const payer = Keypair.generate();
  const calls = { builds: 0, sends: 0, history: 0, epochInfo: 0 };
  const sent = new Set<string>();

  const connection = {
    rpcEndpoint: "stub",
    async getLatestBlockhash() {
      return {
        blockhash: Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: LAST_VALID,
      };
    },
    async sendRawTransaction(raw: Buffer | Uint8Array) {
      calls.sends++;
      sent.add(Buffer.from(raw).toString("base64"));
      return "sig";
    },
    async getSignatureStatuses(
      _sigs: string[],
      config?: { searchTransactionHistory?: boolean },
    ) {
      let answer: StatusAnswer;
      if (config?.searchTransactionHistory) {
        calls.history++;
        answer = (script.history ?? (() => null))(calls.history);
      } else {
        answer = (script.recent ?? (() => null))(calls.builds);
      }
      if (answer instanceof Error) throw answer;
      const slot = config?.searchTransactionHistory
        ? (script.historySlot ?? FINALIZED_SLOT)
        : FINALIZED_SLOT;
      return { context: { slot }, value: [answer] };
    },
    async getEpochInfo(commitment?: string) {
      calls.epochInfo++;
      assert.equal(commitment, "finalized");
      const h = script.finalizedHeight ?? LAST_VALID + 1;
      if (h instanceof Error) throw h;
      return {
        epoch: 0,
        slotIndex: 0,
        slotsInEpoch: 432_000,
        absoluteSlot: FINALIZED_SLOT,
        blockHeight: h,
      };
    },
    async getBlockHeight() {
      // A "confirmed" height from some other node: far past expiry. It must
      // not be used for the rebuild decision.
      return LAST_VALID + 10_000;
    },
  };

  const provider = {
    connection,
    wallet: {
      publicKey: payer.publicKey,
      async signTransaction(tx: Transaction) {
        tx.partialSign(payer);
        return tx;
      },
    },
  } as unknown as anchor.AnchorProvider;

  const build = async () => {
    calls.builds++;
    return new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1,
      }),
    );
  };

  const run = (deadlineMs = 200) =>
    sendWithRetry(provider, build, [], "test", {
      resendIntervalMs: 0,
      deadlineMs,
    });

  return { calls, sent, run };
}

describe("sendWithRetry (stubbed RPC)", () => {
  let warn: typeof console.warn;
  before(() => {
    warn = console.warn;
    console.warn = () => {};
  });
  after(() => {
    console.warn = warn;
  });

  it("returns the first signature when only the history lookup sees it", async () => {
    // The recent-cache poll keeps saying "missing" (lagging node / transient
    // error) while the transaction has in fact landed.
    const h = harness({ history: () => confirmed });
    const sig = await h.run();
    assert.isString(sig);
    assert.equal(h.calls.builds, 1);
  });

  it("never rebuilds while the history lookup errors", async () => {
    const h = harness({ history: () => new Error("fetch failed") });
    try {
      await h.run();
      assert.fail("expected UNKNOWN");
    } catch (err) {
      assert.match((err as Error).message, /status UNKNOWN/);
    }
    assert.equal(h.calls.builds, 1);
    assert.equal(h.sent.size, 1, "only the original bytes were sent");
    assert.isAbove(h.calls.sends, 1, "the same bytes were re-sent");
  });

  it("never rebuilds while the history lookup comes from a lagging node", async () => {
    const h = harness({ historySlot: FINALIZED_SLOT - 1 });
    try {
      await h.run();
      assert.fail("expected UNKNOWN");
    } catch (err) {
      assert.match((err as Error).message, /status UNKNOWN/);
    }
    assert.equal(h.calls.builds, 1);
  });

  it("never rebuilds while the finalized height is not past expiry", async () => {
    // getBlockHeight (confirmed) says expired; finalized does not.
    const h = harness({ finalizedHeight: LAST_VALID });
    try {
      await h.run();
      assert.fail("expected UNKNOWN");
    } catch (err) {
      assert.match((err as Error).message, /status UNKNOWN/);
    }
    assert.equal(h.calls.builds, 1);
    assert.equal(h.calls.history, 0, "no history lookup before expiry");
  });

  it("never rebuilds while the finalized height cannot be read", async () => {
    const h = harness({ finalizedHeight: new Error("429 Too Many Requests") });
    try {
      await h.run();
      assert.fail("expected UNKNOWN");
    } catch (err) {
      assert.match((err as Error).message, /status UNKNOWN/);
    }
    assert.equal(h.calls.builds, 1);
  });

  it("never rebuilds while the transaction is only processed", async () => {
    const h = harness({
      history: () => ({ ...confirmed, confirmationStatus: "processed" }),
    });
    try {
      await h.run();
      assert.fail("expected UNKNOWN");
    } catch (err) {
      assert.match((err as Error).message, /status UNKNOWN/);
    }
    assert.equal(h.calls.builds, 1);
  });

  it("reports an on-chain failure found by the history lookup", async () => {
    const h = harness({
      history: () => ({ ...confirmed, err: { InstructionError: [0, 1] } }),
    });
    try {
      await h.run();
      assert.fail("expected failure");
    } catch (err) {
      assert.match((err as Error).message, /failed on-chain/);
    }
    assert.equal(h.calls.builds, 1);
  });

  it("rebuilds once expiry is proven, and returns when the new one lands", async () => {
    // Build 1: never seen anywhere, finalized height past expiry, history
    // lookup from an up-to-date node says unknown -> proven expired.
    // Build 2: the regular poll sees it confirmed.
    const h = harness({
      recent: (builds) => (builds >= 2 ? confirmed : null),
    });
    const sig = await h.run(5_000);
    assert.isString(sig);
    assert.equal(h.calls.builds, 2);
    assert.equal(h.sent.size, 2);
  });
});
