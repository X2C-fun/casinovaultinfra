# Casino Vault Frontend

Next.js **16** reference UI for the Solana casino vault program, using the
official **Solana Wallet Adapter** (Phantom / Solflare).

Users can:

- Connect a wallet
- Read pool status (balance, admin, paused)
- **Deposit** SOL into the shared pool
- **Withdraw** SOL (user signs + server admin co-signs via `/api/withdraw`)

> ## ⚠️ The withdraw API is a demo — do not deploy it with real funds
>
> `src/app/api/withdraw/route.ts` has **no user accounts, sessions, or balance
> ledger**. With a real admin key it would co-sign a withdrawal for anyone who
> calls it. It therefore:
>
> - returns **HTTP 501** unless `VAULT_DEMO_UNSAFE_WITHDRAW=true`;
> - when enabled, caps each request at `VAULT_DEMO_MAX_WITHDRAW_SOL`
>   (default `0.1`) and rate-limits each wallet to 5 requests per minute, plus
>   each client IP (5/min) when `VAULT_DEMO_TRUSTED_PROXY_HOPS` names your
>   proxies, or all callers together (20/min) when it does not.
>
> A production backend must authenticate the user and **hold the balance at
> approval time** — see "Backend withdraw flow" in the repository README.

## Quick start (devnet demo)

```bash
cd casinovault-frontend
cp .env.example .env.local
# Edit .env.local:
#   ADMIN_SECRET_KEY            = contents of ../keys/admin.json (must match on-chain admin)
#   VAULT_DEMO_UNSAFE_WITHDRAW  = true   (devnet only)

npm install
npm run dev
```

Open http://localhost:3000

## Environment

| Variable | Where | Purpose |
| -------- | ----- | ------- |
| `NEXT_PUBLIC_SOLANA_RPC_URL` | browser | RPC endpoint (default Solana public devnet) |
| `NEXT_PUBLIC_SOLANA_CLUSTER` | browser | `devnet` / `mainnet-beta` for explorer links |
| `NEXT_PUBLIC_VAULT_PROGRAM_ID` | browser | Program ID of your deployment (defaults to the devnet demo) |
| `ADMIN_SECRET_KEY` | **server only** | Admin keypair JSON array or base58 — co-signs withdrawals |
| `VAULT_DEMO_UNSAFE_WITHDRAW` | **server only** | Must be exactly `true` to enable the demo withdraw route |
| `SOLANA_RPC_URL` | **server only** | RPC for `/api/withdraw`; may carry an API key (falls back to the public one) |
| `VAULT_DEMO_MAX_WITHDRAW_SOL` | **server only** | Per-request cap for the demo route (default `0.1`) |
| `VAULT_DEMO_TRUSTED_PROXY_HOPS` | **server only** | Reverse proxies that append to `X-Forwarded-For` (Vercel `1`, nginx `1`, Cloudflare + nginx `2`). `0` (default) trusts none and uses one shared bucket. |

Never put `ADMIN_SECRET_KEY` in a `NEXT_PUBLIC_*` variable.

## Withdraw flow in this UI

1. User enters an amount; the UI parses it to exact lamports (plain decimals,
   at most 9 places, at least 1 lamport).
2. Browser calls `POST /api/withdraw` with `{ user, amountLamports }`.
3. The API (if enabled) checks the cap, pool funds, pause state, and that
   `ADMIN_SECRET_KEY` matches `VaultState.admin`, then builds `withdraw`,
   **partially signs** as admin, and returns the base64 transaction plus its
   `blockhash` and `lastValidBlockHeight`.
4. **Before the wallet is prompted**, the UI decodes the transaction and
   refuses to sign unless it is exactly one `withdraw` instruction to this
   program, for the requested amount, paying the connected wallet, with the
   connected wallet as fee payer and only the user and admin as signers
   (`src/lib/withdrawTx.ts`).
5. The wallet signs; the UI submits and confirms with
   `{ signature, blockhash, lastValidBlockHeight }`, so an expired transaction
   fails instead of hanging.

## Sync IDL after program changes

```bash
cp ../target/idl/casino_vault.json src/idl/casino_vault.json
cp ../target/types/casino_vault.ts src/idl/casino_vault.ts
```

## Fonts

Fonts are self-hosted from `@fontsource` packages, so `next build` does not
need network access.

## Stack

- Next.js 16 (App Router) + React 19 + Tailwind 4
- `@solana/wallet-adapter-react` + `react-ui` + `wallets`
- `@coral-xyz/anchor` 0.32 + `@solana/web3.js`
- Default program ID: `EXTH5XRAqc45efhoL5UjwhhLFV4smgaB4m6QVG74Vqa7` (this repository's devnet deployment)
