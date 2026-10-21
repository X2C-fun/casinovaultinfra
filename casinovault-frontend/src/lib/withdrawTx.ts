import { PublicKey, Transaction } from "@solana/web3.js";
import {
  assertSafeWithdrawTx as sdkAssertSafeWithdrawTx,
  MAX_PRIORITY_FEE_LAMPORTS,
  UnsafeWithdrawTxError,
} from "@x2c-fun/casinovault-sdk";
import { PROGRAM_ID } from "./constants";

export { MAX_PRIORITY_FEE_LAMPORTS, UnsafeWithdrawTxError };

/**
 * Asserts a server-built withdraw transaction is exactly the withdraw this app
 * expects, before the wallet signs it. Thin wrapper over the SDK that injects
 * this app's configured PROGRAM_ID.
 */
export function assertSafeWithdrawTx(
  tx: Transaction,
  opts: {
    user: PublicKey;
    expectedLamports: bigint;
    expectedRequestId: bigint;
    expectedAdmin: PublicKey | null;
  },
): void {
  sdkAssertSafeWithdrawTx(tx, { ...opts, programId: PROGRAM_ID });
}
