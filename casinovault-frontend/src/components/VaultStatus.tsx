"use client";

import { explorerAddress } from "@/lib/constants";
import { lamportsToSol, shortAddress } from "@/lib/format";
import type { VaultSnapshot } from "@/hooks/useVaultState";

function formatWindow(seconds: number): string {
  if (seconds % 86_400 === 0) return seconds === 86_400 ? "day" : `${seconds / 86_400} days`;
  if (seconds % 3_600 === 0) return seconds === 3_600 ? "hour" : `${seconds / 3_600} hours`;
  if (seconds % 60 === 0) return seconds === 60 ? "minute" : `${seconds / 60} minutes`;
  return `${seconds}s`;
}

export function VaultStatus({
  data,
  loading,
  error,
  onRefresh,
}: {
  data: VaultSnapshot | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  if (loading && !data) {
    return <section className="panel status-panel">Loading vault…</section>;
  }

  if (error) {
    return (
      <section className="panel status-panel">
        <p className="error-text">{error}</p>
        <button type="button" className="btn secondary" onClick={onRefresh}>
          Retry
        </button>
      </section>
    );
  }

  if (!data?.initialized) {
    return (
      <section className="panel status-panel">
        <h2>Vault offline</h2>
        <p>
          The program is deployed, but <code>initialize</code> has not been run
          on this cluster yet.
        </p>
      </section>
    );
  }

  return (
    <section className="panel status-panel">
      <div className="panel-head">
        <h2>Pool status</h2>
        <button type="button" className="btn ghost" onClick={onRefresh}>
          Refresh
        </button>
      </div>

      <div className="stat-grid">
        <div>
          <p className="stat-label">Pool balance</p>
          <p className="stat-value">{lamportsToSol(data.poolLamports)} SOL</p>
        </div>
        <div>
          <p className="stat-label">Withdrawable</p>
          <p className="stat-value">
            {lamportsToSol(data.withdrawableLamports)} SOL
          </p>
        </div>
        <div>
          <p className="stat-label">Status</p>
          <p className={`stat-value ${data.paused ? "paused" : "live"}`}>
            {data.paused ? "Paused" : "Live"}
          </p>
        </div>
      </div>

      <dl className="meta-list">
        <div>
          <dt>Admin</dt>
          <dd>
            <a
              href={explorerAddress(data.admin!.toBase58())}
              target="_blank"
              rel="noreferrer"
            >
              {shortAddress(data.admin!.toBase58(), 6)}
            </a>
          </dd>
        </div>
        <div>
          <dt>Pool PDA</dt>
          <dd>
            <a
              href={explorerAddress(data.poolVault.toBase58())}
              target="_blank"
              rel="noreferrer"
            >
              {shortAddress(data.poolVault.toBase58(), 6)}
            </a>
          </dd>
        </div>
        <div>
          <dt>Withdrawal limits</dt>
          <dd>
            {data.maxWithdrawPerTx > 0n
              ? `${lamportsToSol(data.maxWithdrawPerTx)} SOL per withdrawal`
              : "No per-withdrawal cap"}
            {data.maxWithdrawPerWindow > 0n
              ? ` · ${lamportsToSol(data.maxWithdrawPerWindow)} SOL per ${formatWindow(data.windowSeconds)}`
              : ""}
          </dd>
        </div>
        {data.pendingAdmin ? (
          <div>
            <dt>Pending admin</dt>
            <dd>{shortAddress(data.pendingAdmin.toBase58(), 6)}</dd>
          </div>
        ) : null}
        <div>
          <dt>Rent reserve</dt>
          <dd>{lamportsToSol(data.rentReserve)} SOL (locked)</dd>
        </div>
      </dl>
    </section>
  );
}
