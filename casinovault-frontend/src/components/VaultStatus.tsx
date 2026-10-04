"use client";

import { explorerAddress } from "@/lib/constants";
import { lamportsToSol, shortAddress } from "@/lib/format";
import type { VaultSnapshot } from "@/hooks/useVaultState";

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
          <dt>Rent reserve</dt>
          <dd>{lamportsToSol(data.rentReserve)} SOL (locked)</dd>
        </div>
      </dl>
    </section>
  );
}
