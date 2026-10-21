import { AnchorProvider, Program } from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  type ConfirmOptions,
} from "@solana/web3.js";
import type { AnchorWallet } from "@solana/wallet-adapter-react";

import { loadVaultIdl, type CasinoVault } from "@x2c-fun/casinovault-sdk";
import { PROGRAM_ID, SOLANA_RPC } from "./constants";

/** The IDL from the SDK, pointed at this app's configured PROGRAM_ID. */
export const VAULT_IDL: CasinoVault = loadVaultIdl(PROGRAM_ID);

const confirmOptions: ConfirmOptions = {
  commitment: "confirmed",
  preflightCommitment: "confirmed",
};

export function getConnection(): Connection {
  return new Connection(SOLANA_RPC, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60_000,
  });
}

export function getProvider(
  wallet: AnchorWallet,
  connection: Connection = getConnection(),
): AnchorProvider {
  return new AnchorProvider(connection, wallet, confirmOptions);
}

export function getProgram(
  wallet: AnchorWallet,
  connection?: Connection,
): Program<CasinoVault> {
  const provider = getProvider(wallet, connection ?? getConnection());
  return new Program<CasinoVault>(VAULT_IDL, provider);
}

/** Read-only program (no wallet) for fetching accounts. */
export function getReadonlyProgram(
  connection: Connection = getConnection(),
): Program<CasinoVault> {
  const dummyWallet = {
    publicKey: PublicKey.default,
    signTransaction: async <T>(tx: T) => tx,
    signAllTransactions: async <T>(txs: T[]) => txs,
  } as AnchorWallet;

  const provider = new AnchorProvider(connection, dummyWallet, confirmOptions);
  return new Program<CasinoVault>(VAULT_IDL, provider);
}

export { PROGRAM_ID };
