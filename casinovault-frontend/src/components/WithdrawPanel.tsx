"use client";

import { FormEvent, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Transaction } from "@solana/web3.js";

import { explorerTx } from "@/lib/constants";
import { solToLamports } from "@/lib/format";
import { assertSafeWithdrawTx } from "@/lib/withdrawTx";
import type { VaultSnapshot } from "@/hooks/useVaultState";

export function WithdrawPanel({
  vault,
  onDone,
}: {
  vault: VaultSnapshot | null;
  onDone: () => void;
}) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [amount, setAmount] = useState("0.05");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [txSig, setTxSig] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setMessage(null);
    setTxSig(null);

    if (!wallet.publicKey || !wallet.signTransaction) {
      setMessage("Connect a wallet first.");
      return;
    }
    if (!vault?.initialized) {
      setMessage("Vault is not initialized.");
      return;
    }
    if (vault.paused) {
      setMessage("Vault is paused.");
      return;
    }

    try {
      setBusy(true);
      const lamports = solToLamports(amount);
      if (vault.maxWithdrawPerTx > 0n && lamports > vault.maxWithdrawPerTx) {
        throw new Error("Amount exceeds the vault's per-withdrawal limit.");
      }

      // 1) Backend (this Next API) checks pool + signs as admin.
      const res = await fetch("/api/withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user: wallet.publicKey.toBase58(),
          amountLamports: lamports.toString(),
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        error?: string;
        transaction?: string;
        requestId?: string;
        blockhash?: string;
        lastValidBlockHeight?: number;
      };
      if (
        !res.ok ||
        !payload.transaction ||
        !payload.requestId ||
        !/^\d+$/.test(payload.requestId) ||
        !payload.blockhash ||
        typeof payload.lastValidBlockHeight !== "number"
      ) {
        throw new Error(payload.error ?? "Admin approval failed");
      }

      // 2) Verify the server's transaction is exactly the withdraw we asked
      //    for before the wallet is ever prompted.
      const raw = Uint8Array.from(atob(payload.transaction), (c) =>
        c.charCodeAt(0),
      );
      const tx = Transaction.from(raw);
      if (tx.recentBlockhash !== payload.blockhash) {
        throw new Error("Refusing to sign: blockhash mismatch.");
      }
      assertSafeWithdrawTx(tx, {
        user: wallet.publicKey,
        expectedLamports: lamports,
        expectedRequestId: BigInt(payload.requestId),
        expectedAdmin: vault.admin,
      });

      // 3) User signs the partially-signed transaction and sends it.
      const signed = await wallet.signTransaction(tx);
      const signature = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        maxRetries: 5,
      });
      const confirmation = await connection.confirmTransaction(
        {
          signature,
          blockhash: payload.blockhash,
          lastValidBlockHeight: payload.lastValidBlockHeight,
        },
        "confirmed",
      );
      if (confirmation.value.err) {
        throw new Error(`Withdrawal failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
      }

      setTxSig(signature);
      setMessage("Withdrawal confirmed.");
      onDone();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel action-panel">
      <h2>Withdraw</h2>
      <p className="panel-copy">
        Requires your signature <strong>and</strong> the admin co-sign from the
        server (<code>/api/withdraw</code>). The demo route is disabled unless
        the operator sets <code>VAULT_DEMO_UNSAFE_WITHDRAW=true</code>; it has no
        user balances and must not run against real funds.
      </p>

      <form onSubmit={onSubmit} className="stack-form">
        <label>
          Amount (SOL)
          <input
            type="number"
            min="0"
            step="any"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={busy || !wallet.connected}
          />
        </label>
        <button
          type="submit"
          className="btn primary"
          disabled={busy || !wallet.connected || !vault?.initialized}
        >
          {busy ? "Approve & sign…" : "Request withdrawal"}
        </button>
      </form>

      {message ? <p className="feedback">{message}</p> : null}
      {txSig ? (
        <a className="tx-link" href={explorerTx(txSig)} target="_blank" rel="noreferrer">
          View transaction
        </a>
      ) : null}
    </section>
  );
}
