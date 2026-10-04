import { NextRequest, NextResponse } from "next/server";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  type Transaction as SolanaTx,
  type VersionedTransaction,
} from "@solana/web3.js";
import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import bs58 from "bs58";

import idl from "@/idl/casino_vault.json";
import type { CasinoVault } from "@/idl/casino_vault";
import { PROGRAM_ID, SOLANA_RPC } from "@/lib/constants";
import { derivePoolVaultPda, deriveVaultStatePda } from "@/lib/pdas";

export const runtime = "nodejs";

function loadAdminKeypair(): Keypair {
  const raw = process.env.ADMIN_SECRET_KEY;
  if (!raw) {
    throw new Error(
      "ADMIN_SECRET_KEY is not set. Add the admin keypair JSON array or base58 secret to .env.local",
    );
  }

  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    const arr = JSON.parse(trimmed) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  return Keypair.fromSecretKey(bs58.decode(trimmed));
}

function asAnchorWallet(payer: Keypair): AnchorWallet {
  return {
    publicKey: payer.publicKey,
    signTransaction: async <T extends SolanaTx | VersionedTransaction>(
      tx: T,
    ): Promise<T> => {
      if ("partialSign" in tx && typeof tx.partialSign === "function") {
        (tx as SolanaTx).partialSign(payer);
      }
      return tx;
    },
    signAllTransactions: async <T extends SolanaTx | VersionedTransaction>(
      txs: T[],
    ): Promise<T[]> => {
      for (const tx of txs) {
        if ("partialSign" in tx && typeof tx.partialSign === "function") {
          (tx as SolanaTx).partialSign(payer);
        }
      }
      return txs;
    },
  };
}

/**
 * POST { user: base58, amountSol: string }
 *
 * Builds a withdraw instruction, signs it with the server-side admin key, and
 * returns a partially signed transaction for the user wallet to finish.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      user?: string;
      amountSol?: string;
    };

    if (!body.user || !body.amountSol) {
      return NextResponse.json(
        { error: "user and amountSol are required" },
        { status: 400 },
      );
    }

    const user = new PublicKey(body.user);
    const amountFloat = Number(body.amountSol);
    if (!Number.isFinite(amountFloat) || amountFloat <= 0) {
      return NextResponse.json(
        { error: "amountSol must be a positive number" },
        { status: 400 },
      );
    }

    const lamports = Math.round(amountFloat * 1e9);
    const admin = loadAdminKeypair();
    const connection = new Connection(SOLANA_RPC, "confirmed");
    const [vaultState] = deriveVaultStatePda(PROGRAM_ID);
    const [poolVault] = derivePoolVaultPda(PROGRAM_ID);

    const stateInfo = await connection.getAccountInfo(vaultState);
    if (!stateInfo) {
      return NextResponse.json(
        { error: "Vault is not initialized on this cluster" },
        { status: 400 },
      );
    }

    const provider = new AnchorProvider(connection, asAnchorWallet(admin), {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    });
    const program = new Program<CasinoVault>(idl as CasinoVault, provider);

    const state = await program.account.vaultState.fetch(vaultState);
    if (!state.admin.equals(admin.publicKey)) {
      return NextResponse.json(
        {
          error: `ADMIN_SECRET_KEY does not match on-chain admin ${state.admin.toBase58()}`,
        },
        { status: 403 },
      );
    }
    if (state.paused) {
      return NextResponse.json({ error: "Vault is paused" }, { status: 403 });
    }

    const rentReserve = await connection.getMinimumBalanceForRentExemption(0);
    const poolLamports = await connection.getBalance(poolVault);
    const available = Math.max(0, poolLamports - rentReserve);
    if (lamports > available) {
      return NextResponse.json(
        {
          error: `Insufficient pool funds. Withdrawable: ${(available / 1e9).toFixed(9)} SOL`,
        },
        { status: 400 },
      );
    }

    // NOTE: In production, verify the caller's off-chain DB balance / session
    // here before signing. This route only proves admin co-sign wiring.

    const ix = await program.methods
      .withdraw(new BN(lamports))
      .accountsPartial({
        user,
        admin: admin.publicKey,
        vaultState,
        poolVault,
        systemProgram: new PublicKey("11111111111111111111111111111111"),
      })
      .instruction();

    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash("confirmed");

    const tx = new Transaction({
      feePayer: user,
      blockhash,
      lastValidBlockHeight,
    }).add(ix);

    tx.partialSign(admin);

    return NextResponse.json({
      transaction: tx
        .serialize({
          requireAllSignatures: false,
          verifySignatures: false,
        })
        .toString("base64"),
      admin: admin.publicKey.toBase58(),
      amountLamports: lamports,
      lastValidBlockHeight,
    });
  } catch (err) {
    console.error("withdraw approve failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
