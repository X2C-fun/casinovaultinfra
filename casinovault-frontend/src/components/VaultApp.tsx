"use client";

import { SiteHeader } from "@/components/SiteHeader";
import { VaultStatus } from "@/components/VaultStatus";
import { DepositPanel } from "@/components/DepositPanel";
import { WithdrawPanel } from "@/components/WithdrawPanel";
import { useVaultState } from "@/hooks/useVaultState";

export function VaultApp() {
  const { data, loading, error, refresh } = useVaultState();

  return (
    <div className="page-shell">
      <SiteHeader />

      <main className="main-stage">
        <section className="hero">
          <h1>Casino Vault</h1>
          <p>
            Deposit and withdraw SOL against the shared on-chain pool. Balances
            live in your backend — this interface only moves custody.
          </p>
        </section>

        <VaultStatus
          data={data}
          loading={loading}
          error={error}
          onRefresh={() => void refresh()}
        />

        <div className="action-grid">
          <DepositPanel vault={data} onDone={() => void refresh()} />
          <WithdrawPanel vault={data} onDone={() => void refresh()} />
        </div>
      </main>
    </div>
  );
}
