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
refuses anything other than a single `withdraw` of the requested amount to the
connected wallet, with the connected wallet as fee payer
(`src/lib/withdrawTx.ts`). Integrators should keep that check.

See `casinovault-frontend/README.md` for details.
