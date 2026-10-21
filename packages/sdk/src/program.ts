import { AnchorProvider, Program } from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  type ConfirmOptions,
  type Commitment,
} from "@solana/web3.js";
import type { CasinoVault } from "./idl/casino_vault";
import { DEFAULT_PROGRAM_ID } from "./constants";
import { loadVaultIdl } from "./idl";

/**
 * The minimal wallet shape Anchor needs. Both the browser wallet-adapter's
 * `AnchorWallet` and a backend `NodeWallet` satisfy it, so the SDK stays free
 * of any framework dependency.
 */
export interface SdkWallet {
  publicKey: PublicKey;
  signTransaction<T>(tx: T): Promise<T>;
  signAllTransactions<T>(txs: T[]): Promise<T[]>;
}

const DEFAULT_COMMITMENT: Commitment = "confirmed";

const confirmOptions: ConfirmOptions = {
  commitment: DEFAULT_COMMITMENT,
  preflightCommitment: DEFAULT_COMMITMENT,
};

/** Builds a `Connection` with the SDK's default commitment settings. */
export function createConnection(
  rpcUrl: string,
  commitment: Commitment = DEFAULT_COMMITMENT,
): Connection {
  return new Connection(rpcUrl, {
    commitment,
    confirmTransactionInitialTimeout: 60_000,
  });
}

/** Builds an `AnchorProvider` from a connection and a wallet. */
export function getProvider(
  connection: Connection,
  wallet: SdkWallet,
): AnchorProvider {
  return new AnchorProvider(connection, wallet, confirmOptions);
}

/**
 * Builds a typed `Program<CasinoVault>` for sending transactions. Pass a
 * `programId` to target a non-default deployment.
 */
export function getProgram(
  connection: Connection,
  wallet: SdkWallet,
  programId: PublicKey = DEFAULT_PROGRAM_ID,
): Program<CasinoVault> {
  const provider = getProvider(connection, wallet);
  return new Program<CasinoVault>(loadVaultIdl(programId), provider);
}

/**
 * Builds a read-only `Program<CasinoVault>` with a dummy wallet, for fetching
 * accounts and decoding events. It cannot sign, and never needs to.
 */
export function getReadonlyProgram(
  connection: Connection,
  programId: PublicKey = DEFAULT_PROGRAM_ID,
): Program<CasinoVault> {
  const dummyWallet: SdkWallet = {
    publicKey: PublicKey.default,
    signTransaction: async <T>(tx: T) => tx,
    signAllTransactions: async <T>(txs: T[]) => txs,
  };
  const provider = new AnchorProvider(connection, dummyWallet, confirmOptions);
  return new Program<CasinoVault>(loadVaultIdl(programId), provider);
}
