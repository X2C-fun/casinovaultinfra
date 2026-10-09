/**
 * ============================================================================
 *  DEMO ONLY — DO NOT DEPLOY WITH REAL FUNDS
 * ============================================================================
 *  This route co-signs vault withdrawals with the admin key, but it has NO
 *  user accounts, NO sessions, and NO off-chain balance ledger. Anyone who can
 *  reach it can request a withdrawal to their own wallet. It is disabled
 *  (HTTP 501) unless the operator sets VAULT_DEMO_UNSAFE_WITHDRAW=true, and
 *  even then it caps each request (VAULT_DEMO_MAX_WITHDRAW_SOL, default 0.1).
 *
 *  A real backend must authenticate the user and place a hold on their
 *  off-chain balance BEFORE co-signing (see "Backend withdraw flow" in the
 *  repository README) — otherwise one balance can be withdrawn many times.
 * ============================================================================
 */

import { NextRequest, NextResponse } from "next/server";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { BN, Program } from "@coral-xyz/anchor";
import bs58 from "bs58";

import type { CasinoVault } from "@/idl/casino_vault";
import { PROGRAM_ID, SOLANA_RPC } from "@/lib/constants";
import { solToLamports } from "@/lib/format";
import { derivePoolVaultPda, deriveVaultStatePda } from "@/lib/pdas";
import { VAULT_IDL } from "@/lib/program";

export const runtime = "nodejs";

const U64_MAX = 18_446_744_073_709_551_615n;
const DEFAULT_MAX_WITHDRAW_SOL = "0.1";
const RATE_LIMIT_WINDOW_MS = 60_000;
/** Per client IP (when a trusted proxy reports it) and per wallet. */
const RATE_LIMIT_MAX_REQUESTS = 5;
/** Shared by every caller when no trusted proxy is configured. */
const RATE_LIMIT_MAX_GLOBAL = 20;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function demoEnabled(): boolean {
  return process.env.VAULT_DEMO_UNSAFE_WITHDRAW?.trim().toLowerCase() === "true";
}

function maxWithdrawLamports(): bigint {
  const raw = process.env.VAULT_DEMO_MAX_WITHDRAW_SOL?.trim() || DEFAULT_MAX_WITHDRAW_SOL;
  try {
    return solToLamports(raw);
  } catch {
    throw new Error(`VAULT_DEMO_MAX_WITHDRAW_SOL is not a valid SOL amount: ${raw}`);
  }
}

let cachedAdmin: Keypair | null = null;

function loadAdminKeypair(): Keypair {
  if (cachedAdmin) return cachedAdmin;
  const raw = process.env.ADMIN_SECRET_KEY?.trim();
  if (!raw) {
    throw new Error("ADMIN_SECRET_KEY is not set");
  }
  cachedAdmin = raw.startsWith("[")
    ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw) as number[]))
    : Keypair.fromSecretKey(bs58.decode(raw));
  return cachedAdmin;
}

// Per-instance, in-memory fixed windows. They bound RPC spend and admin
// signing; they are not a substitute for authentication.
const hits = new Map<string, { count: number; resetAt: number }>();

/**
 * Number of reverse proxies in front of this app that append the caller's
 * address to X-Forwarded-For (Vercel: 1; one nginx: 1; Cloudflare + nginx: 2).
 * 0 (the default) means none is trusted.
 */
function trustedProxyHops(): number {
  const n = Number(process.env.VAULT_DEMO_TRUSTED_PROXY_HOPS ?? "0");
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * Rate-limit key for the caller.
 *
 * X-Forwarded-For is a list the client can pre-fill: only the entries appended
 * by our own proxies are trustworthy, and those are the LAST ones. With N
 * trusted hops the caller's address is the N-th entry from the right. Without
 * a trusted proxy there is no address we can trust (Next.js route handlers do
 * not expose the socket address), so every caller shares one global bucket
 * rather than letting a spoofed header mint a fresh bucket per request.
 */
function clientKey(req: NextRequest): { key: string; limit: number } {
  const hops = trustedProxyHops();
  if (hops > 0) {
    const chain = (req.headers.get("x-forwarded-for") ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    const ip = chain[chain.length - hops];
    if (ip) return { key: `ip:${ip}`, limit: RATE_LIMIT_MAX_REQUESTS };
  }
  return { key: "global", limit: RATE_LIMIT_MAX_GLOBAL };
}

function rateLimit(key: string, limit: number): void {
  const now = Date.now();
  if (hits.size > 10_000) {
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }
  const entry = hits.get(key);
  if (!entry || entry.resetAt <= now) {
    hits.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return;
  }
  entry.count += 1;
  if (entry.count > limit) {
    throw new HttpError(429, "Too many withdrawal requests. Try again in a minute.");
  }
}

function parseUser(value: unknown): PublicKey {
  if (typeof value !== "string" || !value) {
    throw new HttpError(400, "user is required");
  }
  try {
    return new PublicKey(value);
  } catch {
    throw new HttpError(400, "user is not a valid public key");
  }
}

function parseLamports(value: unknown): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new HttpError(400, "amountLamports must be a positive integer string");
  }
  const lamports = BigInt(value);
  if (lamports < 1n || lamports > U64_MAX) {
    throw new HttpError(400, "amountLamports must be between 1 and u64::MAX");
  }
  return lamports;
}

let cachedRentReserve: number | null = null;

async function rentReserve(connection: Connection): Promise<number> {
  if (cachedRentReserve === null) {
    cachedRentReserve = await connection.getMinimumBalanceForRentExemption(0);
  }
  return cachedRentReserve;
}

/**
 * POST { user: base58, amountLamports: string }
 *
 * Builds a withdraw instruction, signs it with the server-side admin key, and
 * returns a partially signed transaction for the user wallet to finish.
 */
export async function POST(req: NextRequest) {
  if (!demoEnabled()) {
    return NextResponse.json(
      {
        error:
          "Withdrawals are disabled. This reference route has no user balances. " +
          "Implement authentication and an off-chain balance hold before co-signing " +
          "(see 'Backend withdraw flow' in the README), or set VAULT_DEMO_UNSAFE_WITHDRAW=true " +
          "for a devnet demo only.",
      },
      { status: 501 },
    );
  }

  try {
    const caller = clientKey(req);
    rateLimit(caller.key, caller.limit);

    const body = (await req.json().catch(() => null)) as {
      user?: unknown;
      amountLamports?: unknown;
    } | null;
    if (!body) throw new HttpError(400, "Request body must be JSON");

    const user = parseUser(body.user);
    // Also per wallet: a caller who rotates addresses still cannot request
    // more than a few approvals for the same recipient.
    rateLimit(`user:${user.toBase58()}`, RATE_LIMIT_MAX_REQUESTS);
    const lamports = parseLamports(body.amountLamports);
    const cap = maxWithdrawLamports();
    if (lamports > cap) {
      throw new HttpError(
        400,
        `Demo withdrawals are capped at ${(Number(cap) / 1e9).toFixed(9)} SOL per request`,
      );
    }

    const admin = loadAdminKeypair();
    const connection = new Connection(SOLANA_RPC, "confirmed");
    const program = new Program<CasinoVault>(VAULT_IDL, { connection });
    const [vaultState] = deriveVaultStatePda(PROGRAM_ID);
    const [poolVault] = derivePoolVaultPda(PROGRAM_ID);

    const [[stateInfo, poolInfo], reserve] = await Promise.all([
      connection.getMultipleAccountsInfo([vaultState, poolVault], "confirmed"),
      rentReserve(connection),
    ]);
    if (!stateInfo) {
      throw new HttpError(400, "Vault is not initialized on this cluster");
    }

    const state = program.coder.accounts.decode<{
      admin: PublicKey;
      paused: boolean;
    }>("vaultState", stateInfo.data);
    if (!state.admin.equals(admin.publicKey)) {
      console.error(
        `withdraw: ADMIN_SECRET_KEY (${admin.publicKey.toBase58()}) does not match on-chain admin ${state.admin.toBase58()}`,
      );
      throw new HttpError(503, "Withdrawals are temporarily unavailable");
    }
    if (state.paused) {
      throw new HttpError(403, "Vault is paused");
    }

    const available = BigInt(Math.max(0, (poolInfo?.lamports ?? 0) - reserve));
    if (lamports > available) {
      throw new HttpError(400, "Insufficient pool funds for this withdrawal");
    }

    const ix = await program.methods
      .withdraw(new BN(lamports.toString()))
      .accountsPartial({
        user,
        admin: admin.publicKey,
        vaultState,
        poolVault,
        systemProgram: SystemProgram.programId,
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
        .serialize({ requireAllSignatures: false, verifySignatures: false })
        .toString("base64"),
      admin: admin.publicKey.toBase58(),
      amountLamports: lamports.toString(),
      blockhash,
      lastValidBlockHeight,
    });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("withdraw approve failed:", err);
    return NextResponse.json(
      { error: "Withdrawal approval failed. Please try again later." },
      { status: 500 },
    );
  }
}
