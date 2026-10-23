# Reference frontend

The Next.js app in `casinovault-frontend/`. It is a reference, not a
production backend; see its own README for details.

## Frontend (`casinovault-frontend/`)

Next.js reference UI: connect wallet, read pool status, deposit, and withdraw
with server-side admin co-signing via `/api/withdraw`.

> **The withdraw route is a demo.** It has no user accounts or balances, so it
> would co-sign a withdrawal for anyone. It returns **501** unless you set
> `VAULT_DEMO_UNSAFE_WITHDRAW=true`, and even then caps each request at
> `VAULT_DEMO_MAX_WITHDRAW_SOL` (default 0.1) and rate-limits per wallet and per
> client (see `VAULT_DEMO_TRUSTED_PROXY_HOPS`). Never
> enable it with a funded mainnet admin key. A real backend follows
> [Backend withdraw flow](backend-integration.md#backend-withdraw-flow).

```bash
cd casinovault-frontend
cp .env.example .env.local
# devnet demo only: set ADMIN_SECRET_KEY and VAULT_DEMO_UNSAFE_WITHDRAW=true
npm install
npm run dev        # http://localhost:3000
```

| Variable                       | Where       | Purpose                                              |
| ------------------------------ | ----------- | ---------------------------------------------------- |
| `NEXT_PUBLIC_SOLANA_RPC_URL`   | browser     | RPC endpoint; shipped to every browser, so no API keys |
| `SOLANA_RPC_URL`               | server only | RPC for `/api/withdraw` (may carry a key); falls back to the public one |
| `NEXT_PUBLIC_SOLANA_CLUSTER`   | browser     | `devnet` / `mainnet-beta` for explorer links         |
| `NEXT_PUBLIC_VAULT_PROGRAM_ID` | browser     | Your program ID (defaults to the devnet demo)        |
| `ADMIN_SECRET_KEY`             | server only | Admin keypair; co-signs withdrawals                  |
| `VAULT_DEMO_UNSAFE_WITHDRAW`   | server only | Must be `true` to enable the demo withdraw route     |
| `VAULT_DEMO_MAX_WITHDRAW_SOL`  | server only | Per-request cap for the demo route (default `0.1`)   |
| `VAULT_DEMO_TRUSTED_PROXY_HOPS` | server only | Proxies that append to `X-Forwarded-For` (Vercel `1`); `0` = one shared rate-limit bucket |

Before asking the wallet to sign, the UI decodes the server's transaction and
refuses anything other than a single `withdraw` (optionally preceded by
ComputeBudget instructions whose priority fee is at most 0.001 SOL) of the requested amount and
`request_id` to the connected wallet, with the connected wallet as fee payer
(the SDK's `assertSafeWithdrawTx`, called with the app's own `PROGRAM_ID`,
never one from the server). Integrators should keep that check.

The app uses `@x2c-fun/casinovault-sdk` from npm for the IDL, PDAs, program
construction, amount formatting, the withdraw-transaction builder and that
check. Only frontend configuration lives in `src/lib/constants.ts` (program ID,
RPC, cluster and explorer links from `NEXT_PUBLIC_*` env vars). Pass
`PROGRAM_ID` explicitly to every SDK helper: their default is the SDK's
`DEFAULT_PROGRAM_ID`, not the env override. The app keeps no IDL copy; a
program interface change reaches it through an SDK release (see
[releasing.md](releasing.md)).

See `casinovault-frontend/README.md` for details.
