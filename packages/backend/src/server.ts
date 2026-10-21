import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fetchVaultState } from "@x2c-fun/casinovault-sdk";
import type { ServiceContext } from "./context";
import { approveWithdrawal } from "./services/withdraw";

function json(res: ServerResponse, status: number, body: unknown): void {
  // bigint-safe serialization.
  const payload = JSON.stringify(body, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

/**
 * A minimal reference HTTP API. It demonstrates the withdraw-approval flow and
 * balance reads; it has NO authentication — add your own (session, JWT, wallet
 * signature) before exposing it. Deposits are credited by the listener from
 * chain, so there is no deposit-credit endpoint here by design.
 */
export function createApi(ctx: ServiceContext) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "GET" && url.pathname === "/health") {
        return json(res, 200, { ok: true });
      }

      if (req.method === "GET" && url.pathname === "/vault") {
        const state = await fetchVaultState(ctx.program, ctx.config.programId);
        return json(res, 200, { programId: ctx.config.programId.toBase58(), state });
      }

      if (req.method === "GET" && url.pathname === "/balance") {
        const owner = url.searchParams.get("owner");
        if (!owner) return json(res, 400, { error: "owner query param required" });
        return json(res, 200, ctx.ledger.getBalance(owner));
      }

      if (req.method === "POST" && url.pathname === "/withdraw") {
        // NOTE: authenticate the caller here and bind `owner` to their session.
        const body = (await readBody(req)) as {
          owner?: string;
          destination?: string;
          amountLamports?: string;
          house?: boolean;
        };
        if (!body.owner || !body.destination || !body.amountLamports) {
          return json(res, 400, {
            error: "owner, destination and amountLamports are required",
          });
        }
        const approval = await approveWithdrawal(ctx, {
          ownerKey: body.owner,
          destination: body.destination,
          amountLamports: BigInt(body.amountLamports),
          house: body.house === true,
        });
        return json(res, 200, approval);
      }

      json(res, 404, { error: "not found" });
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}
