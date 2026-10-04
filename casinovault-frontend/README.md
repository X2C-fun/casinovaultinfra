# Casino Vault Frontend

Next.js **16** UI for the Solana casino vault program, using the official
**Solana Wallet Adapter** (Phantom / Solflare).

Users can:

- Connect a wallet
- Read pool status (balance, admin, paused)
- **Deposit** SOL into the shared pool
- **Withdraw** SOL (user signs + server admin co-signs via `/api/withdraw`)

## Quick start

```bash
cd casinovault-frontend
cp .env.example .env.local
# Edit .env.local:
#   ADMIN_SECRET_KEY = contents of ../keys/admin.json  (must match on-chain admin)

npm install
npm run dev
```

Open http://localhost:3000

## Environment

| Variable | Where | Purpose |
| -------- | ----- | ------- |
| `NEXT_PUBLIC_SOLANA_RPC_URL` | browser | RPC endpoint (default Solana public) |
| `NEXT_PUBLIC_SOLANA_CLUSTER` | browser | `devnet` / `mainnet-beta` for explorer links |
| `ADMIN_SECRET_KEY` | **server only** | Admin keypair JSON array or base58 — co-signs withdrawals |

Never put `ADMIN_SECRET_KEY` in `NEXT_PUBLIC_*`.

## Withdraw flow in this UI

1. User enters amount and clicks **Request withdrawal**
2. Browser calls `POST /api/withdraw` with `{ user, amountSol }`
3. API verifies pool funds + that `ADMIN_SECRET_KEY` matches `VaultState.admin`
4. API builds `withdraw`, **partially signs** as admin, returns base64 tx
5. User wallet signs; frontend submits the fully signed transaction

In production you must also verify the user's **off-chain balance** inside
`/api/withdraw` before signing.

## Sync IDL after program changes

```bash
cp ../target/idl/casino_vault.json src/idl/casino_vault.json
cp ../target/types/casino_vault.ts src/idl/casino_vault.ts
```

## Stack

- Next.js 16 (App Router) + React 19 + Tailwind 4
- `@solana/wallet-adapter-react` + `react-ui` + `wallets`
- `@coral-xyz/anchor` 0.32 + `@solana/web3.js`
- Program ID: `DdpfHbMEYWqZM9yzPvyT45qLPfiLP6yKaPNTgqx7navY`
