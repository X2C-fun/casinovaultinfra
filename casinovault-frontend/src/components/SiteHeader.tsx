"use client";

import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useWallet } from "@solana/wallet-adapter-react";

import { CLUSTER_LABEL, PROGRAM_ID, explorerAddress } from "@/lib/constants";
import { shortAddress } from "@/lib/format";

export function SiteHeader() {
  const { publicKey } = useWallet();

  return (
    <header className="site-header">
      <div className="brand-block">
        <p className="brand-mark">Casino Vault</p>
        <p className="brand-sub">
          Shared pool custody · {CLUSTER_LABEL}
        </p>
      </div>
      <div className="header-actions">
        <a
          className="ghost-link"
          href={explorerAddress(PROGRAM_ID.toBase58())}
          target="_blank"
          rel="noreferrer"
        >
          Program {shortAddress(PROGRAM_ID.toBase58())}
        </a>
        {publicKey ? (
          <span className="wallet-chip">{shortAddress(publicKey.toBase58(), 6)}</span>
        ) : null}
        <WalletMultiButton />
      </div>
    </header>
  );
}
