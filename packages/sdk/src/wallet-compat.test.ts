import { describe, expect, it } from "vitest";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import { getProgram, type SdkWallet } from "./index";

// The browser wallet-adapter's AnchorWallet shape (@solana/wallet-adapter-react),
// declared inline so the SDK needs no dependency on it.
interface AnchorWalletShape {
  publicKey: PublicKey;
  signTransaction<T extends Transaction | VersionedTransaction>(
    transaction: T,
  ): Promise<T>;
  signAllTransactions<T extends Transaction | VersionedTransaction>(
    transactions: T[],
  ): Promise<T[]>;
}

describe("SdkWallet", () => {
  it("accepts a wallet-adapter AnchorWallet without a cast", () => {
    const anchorWallet: AnchorWalletShape = {
      publicKey: Keypair.generate().publicKey,
      signTransaction: async (tx) => tx,
      signAllTransactions: async (txs) => txs,
    };
    const wallet: SdkWallet = anchorWallet; // compile-time check
    const program = getProgram(new Connection("http://127.0.0.1:8899"), wallet);
    expect(program.provider.publicKey?.equals(anchorWallet.publicKey)).toBe(
      true,
    );
  });
});
