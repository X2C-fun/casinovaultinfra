"use client";

import { useCallback, useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";

import { derivePoolVaultPda, deriveVaultStatePda } from "@/lib/pdas";
import { getReadonlyProgram, PROGRAM_ID } from "@/lib/program";

export type VaultSnapshot = {
  initialized: boolean;
  admin: PublicKey | null;
  paused: boolean;
  vaultBump: number | null;
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
      setError(null);
      const program = getReadonlyProgram(connection);
      const rentReserve = await connection.getMinimumBalanceForRentExemption(0);
      const stateInfo = await connection.getAccountInfo(vaultState, "confirmed");

      if (!stateInfo) {
        setData({
          ...EMPTY,
          rentReserve,
          vaultState,
          poolVault,
        });
        return;
      }

      const state = await program.account.vaultState.fetch(vaultState);
      const poolLamports = await connection.getBalance(poolVault, "confirmed");
      const withdrawableLamports = Math.max(0, poolLamports - rentReserve);

      setData({
        initialized: true,
        admin: state.admin,
        paused: state.paused,
        vaultBump: state.vaultBump,
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
    void refresh();
    const id = window.setInterval(() => void refresh(), pollMs);
    return () => window.clearInterval(id);
  }, [refresh, pollMs]);

  return { data, loading, error, refresh };
}
