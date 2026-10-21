import { Connection, Keypair } from "@solana/web3.js";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import {
  getProgram,
  loadVaultIdl,
  type CasinoVault,
} from "@x2c-fun/casinovault-sdk";
import type { Config } from "./config";
import type { Ledger } from "./ledger/types";

/** Everything a service needs: chain client, admin signer, ledger, config. */
export interface ServiceContext {
  config: Config;
  connection: Connection;
  admin: Keypair;
  program: Program<CasinoVault>;
  ledger: Ledger;
}

/** A NodeWallet-shaped wrapper around the admin keypair for Anchor. */
function adminWallet(admin: Keypair) {
  return {
    publicKey: admin.publicKey,
    async signTransaction<T>(tx: T): Promise<T> {
      // @ts-expect-error web3 Transaction/VersionedTransaction both expose sign
      tx.partialSign(admin);
      return tx;
    },
    async signAllTransactions<T>(txs: T[]): Promise<T[]> {
      for (const tx of txs) {
        // @ts-expect-error see above
        tx.partialSign(admin);
      }
      return txs;
    },
  };
}

export function buildContext(
  config: Config,
  admin: Keypair,
  ledger: Ledger,
): ServiceContext {
  const connection = new Connection(config.rpcUrl, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60_000,
  });
  const program = getProgram(connection, adminWallet(admin), config.programId);
  return { config, connection, admin, program, ledger };
}

/** A read-only program at `finalized` commitment, for the settlement listener. */
export function finalizedProgram(ctx: ServiceContext): Program<CasinoVault> {
  const connection = new Connection(ctx.config.rpcUrl, { commitment: "finalized" });
  const dummy = {
    publicKey: ctx.admin.publicKey,
    signTransaction: async <T>(tx: T) => tx,
    signAllTransactions: async <T>(txs: T[]) => txs,
  };
  const provider = new AnchorProvider(connection, dummy, {
    commitment: "finalized",
  });
  return new Program<CasinoVault>(loadVaultIdl(ctx.config.programId), provider);
}
