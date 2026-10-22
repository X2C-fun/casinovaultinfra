import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { fetchVaultState } from "@x2c-fun/casinovault-sdk";
import type { ServiceContext } from "./context";
import type { ApiAuthConfig } from "./config";
import { approveWithdrawal, ApprovalError } from "./services/withdraw";
import { U64_MAX } from "./ledger/types";
import { safeErrorMessage } from "./admin";

/** Largest request body accepted, in bytes. */
export const MAX_BODY_BYTES = 16 * 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  // bigint-safe serialization.
  const payload = JSON.stringify(body, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(payload);
}

async function readBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const declared = Number(req.headers["content-length"] ?? "0");
  if (declared > limit) throw new HttpError(413, "request body too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "request body too large");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) throw new HttpError(400, "invalid request body");
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "invalid request body");
  }
}

/**
 * Strict lamport amount: a JSON STRING of decimal digits, no sign, no leading
 * zeros, no hex/exponent/whitespace, 1..u64::MAX. JSON numbers are rejected
 * (they lose precision above 2^53).
 */
export function parseLamports(value: unknown): bigint {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/.test(value)) {
    throw new HttpError(400, "amountLamports must be a positive decimal string");
  }
  const n = BigInt(value);
  if (n > U64_MAX) throw new HttpError(400, "amountLamports must be a positive decimal string");
  return n;
}

const WITHDRAW_FIELDS = new Set(["owner", "destination", "amountLamports"]);

function digest(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

function isAuthorized(req: IncomingMessage, auth: ApiAuthConfig): boolean {
  if (!auth.apiToken) return auth.allowUnauthenticated;
  const header = req.headers.authorization ?? "";
  const m = /^Bearer (.+)$/.exec(header);
  if (!m) return false;
  // Compare fixed-length digests in constant time.
  return timingSafeEqual(digest(m[1]), digest(auth.apiToken));
}

/**
 * The reference HTTP API.
 *
 * Auth: every route except `/health` requires `Authorization: Bearer
 * <API_TOKEN>` (unless ALLOW_UNAUTHENTICATED=true for local development). That
 * shared token only keeps strangers off a backend-to-backend API. A real
 * deployment MUST authenticate the PLAYER (session / JWT / wallet signature)
 * and derive `owner` from that session — never trust `owner` from the body.
 *
 * There is no house-withdrawal route (operator CLI only) and no deposit-credit
 * route (deposits are credited by the listener from chain).
 */
export function createApi(
  ctx: ServiceContext,
  auth: ApiAuthConfig,
  opts: { maxBodyBytes?: number } = {},
) {
  const maxBody = opts.maxBodyBytes ?? MAX_BODY_BYTES;
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "GET" && url.pathname === "/health") {
        return json(res, 200, { ok: true });
      }

      if (!isAuthorized(req, auth)) {
        return json(res, 401, { error: "unauthorized" });
      }

      if (req.method === "GET" && url.pathname === "/vault") {
        const state = await fetchVaultState(ctx.program, ctx.config.programId);
        return json(res, 200, { programId: ctx.config.programId.toBase58(), state });
      }

      if (req.method === "GET" && url.pathname === "/balance") {
        // REPLACE with the authenticated player's wallet in a real deployment.
        const owner = url.searchParams.get("owner");
        if (!owner) return json(res, 400, { error: "owner query param required" });
        return json(res, 200, ctx.ledger.getBalance(owner));
      }

      if (req.method === "POST" && url.pathname === "/withdraw") {
        const body = await readBody(req, maxBody);
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          throw new HttpError(400, "invalid request body");
        }
        const fields = body as Record<string, unknown>;
        for (const key of Object.keys(fields)) {
          if (!WITHDRAW_FIELDS.has(key)) throw new HttpError(400, `unknown field: ${key.slice(0, 32)}`);
        }
        // REPLACE with the authenticated player's wallet in a real deployment.
        const owner = fields.owner;
        if (typeof owner !== "string" || owner.length === 0 || owner.length > 64) {
          throw new HttpError(400, "owner is required");
        }
        const destination = fields.destination;
        if (destination !== undefined && typeof destination !== "string") {
          throw new HttpError(400, "invalid destination");
        }
        const approval = await approveWithdrawal(ctx, {
          ownerKey: owner,
          destination,
          amountLamports: parseLamports(fields.amountLamports),
        });
        return json(res, 200, approval);
      }

      json(res, 404, { error: "not found" });
    } catch (err) {
      if (err instanceof HttpError) return json(res, err.status, { error: err.message });
      if (err instanceof ApprovalError) {
        return json(res, err.status, { error: err.message, code: err.code });
      }
      // Internal detail stays in the server log only.
      console.error(`API ${req.method} ${req.url?.split("?")[0]} failed:`, safeErrorMessage(err));
      json(res, 500, { error: "internal error" });
    }
  });
}
