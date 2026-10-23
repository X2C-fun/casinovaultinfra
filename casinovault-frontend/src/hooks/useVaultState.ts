"use client";

import { useCallback, useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import {
  derivePoolVaultPda,
  deriveVaultStatePda,
  fetchVaultState,
  getReadonlyProgram,
} from "@x2c-fun/casinovault-sdk";

import { PROGRAM_ID } from "@/lib/constants";

export type VaultSnapshot = {
  initialized: boolean;
  admin: PublicKey | null;
  paused: boolean;
  vaultBump: number | null;
  pendingAdmin: PublicKey | null;
  /** Per-withdrawal cap in lamports; 0 means none. */
  maxWithdrawPerTx: bigint;
  /** Per-window cap in lamports; 0 means none. */
  maxWithdrawPerWindow: bigint;
  windowSeconds: number;
  poolLamports: number;
  rentReserve: number;
  withdrawableLamports: number;
  vaultState: PublicKey;
  poolVault: PublicKey;
};

const EMPTY: Omit<
  VaultSnapshot,
  "vaultState" | "poolVault" | "rentReserve"
> & { rentReserve: number } = {
  initialized: false,
  admin: null,
  paused: false,
  vaultBump: null,
  pendingAdmin: null,
  maxWithdrawPerTx: 0n,
  maxWithdrawPerWindow: 0n,
  windowSeconds: 0,
  poolLamports: 0,
  rentReserve: 0,
  withdrawableLamports: 0,
};

export function useVaultState(pollMs = 12_000) {
  const { connection } = useConnection();
  const [vaultState] = useState(() => deriveVaultStatePda(PROGRAM_ID)[0]);
  const [poolVault] = useState(() => derivePoolVaultPda(PROGRAM_ID)[0]);
  const [data, setData] = useState<VaultSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const rentReserve = await connection.getMinimumBalanceForRentExemption(0);
      const program = getReadonlyProgram(connection, PROGRAM_ID);
      const state = await fetchVaultState(program, PROGRAM_ID);
      setError(null);

      if (!state) {
        setData({
          ...EMPTY,
          rentReserve,
          vaultState,
          poolVault,
        });
        return;
      }

      const poolLamports = await connection.getBalance(poolVault, "confirmed");
      const withdrawableLamports = Math.max(0, poolLamports - rentReserve);

      setData({
        initialized: true,
        admin: state.admin,
        paused: state.paused,
        vaultBump: state.vaultBump,
        pendingAdmin: state.pendingAdmin,
        maxWithdrawPerTx: state.maxWithdrawPerTx,
        maxWithdrawPerWindow: state.maxWithdrawPerWindow,
        windowSeconds: state.windowSeconds,
        poolLamports,
        rentReserve,
        withdrawableLamports,
        vaultState,
        poolVault,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [connection, vaultState, poolVault]);

  useEffect(() => {
    const first = window.setTimeout(() => void refresh(), 0);
    const id = window.setInterval(() => void refresh(), pollMs);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, [refresh, pollMs]);

  return { data, loading, error, refresh };
}
