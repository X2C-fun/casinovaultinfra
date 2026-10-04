"use client";

import { FormEvent, useState } from "react";
import { BN } from "@coral-xyz/anchor";
import {
  useAnchorWallet,
  useConnection,
  useWallet,
} from "@solana/wallet-adapter-react";
import { SystemProgram } from "@solana/web3.js";

import { explorerTx } from "@/lib/constants";
import { solToLamports } from "@/lib/format";
import { getProgram } from "@/lib/program";
import { derivePoolVaultPda, deriveVaultStatePda } from "@/lib/pdas";
import type { VaultSnapshot } from "@/hooks/useVaultState";

export function DepositPanel({
  vault,
  onDone,
}: {
  vault: VaultSnapshot | null;
  onDone: () => void;
}) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const anchorWallet = useAnchorWallet();
  const [amount, setAmount] = useState("0.1");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [txSig, setTxSig] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setMessage(null);
    setTxSig(null);

    if (!wallet.publicKey || !anchorWallet) {
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
      const program = getProgram(anchorWallet, connection);
      const [vaultState] = deriveVaultStatePda();
      const [poolVault] = derivePoolVaultPda();

      const signature = await program.methods
        .deposit(new BN(lamports.toString()))
        .accountsPartial({
          depositor: wallet.publicKey,
          vaultState,
          poolVault,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      setTxSig(signature);
      setMessage("Deposit confirmed.");
      onDone();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel action-panel">
      <h2>Deposit</h2>
      <p className="panel-copy">
        Send SOL from your wallet into the shared pool. Your backend should
        credit your database balance from the <code>DepositEvent</code>.
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
          {busy ? "Confirm in wallet…" : "Deposit SOL"}
        </button>
      </form>

      {message ? <p className="feedback">{message}</p> : null}
      {txSig ? (
        <a
          className="tx-link"
          href={explorerTx(txSig)}
          target="_blank"
          rel="noreferrer"
        >
          View transaction
        </a>
      ) : null}
    </section>
  );
}
