"use client";

import { FormEvent, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Transaction } from "@solana/web3.js";

import { explorerTx } from "@/lib/constants";
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

      // 1) Backend (this Next API) checks pool + signs as admin.
      const res = await fetch("/api/withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user: wallet.publicKey.toBase58(),
          amountSol: amount,
        }),
      });
      const payload = (await res.json()) as {
        error?: string;
        transaction?: string;
      };
      if (!res.ok || !payload.transaction) {
        throw new Error(payload.error ?? "Admin approval failed");
      }

      // 2) User signs the partially-signed transaction and sends it.
      const raw = Uint8Array.from(atob(payload.transaction), (c) =>
        c.charCodeAt(0),
      );
      const tx = Transaction.from(raw);
      const signed = await wallet.signTransaction(tx);
      const signature = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        maxRetries: 5,
      });
      await connection.confirmTransaction(signature, "confirmed");

      setTxSig(signature);
      setMessage("Withdrawal confirmed. Debit the off-chain balance after this event.");
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
        server (<code>/api/withdraw</code>). Set <code>ADMIN_SECRET_KEY</code> in
        <code>.env.local</code>.
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
