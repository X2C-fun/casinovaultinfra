# `mia.md` — Publish & release runbook

Hand this to whoever runs the release. It publishes the **TypeScript SDK**
(`@x2c-fun/casinovault-sdk`) to npm and wires up the rest. Copy-paste, top to
bottom. Everything here is **devnet** tooling — no mainnet, no real funds.

Branch with the work: **`feat/sdk-backend-vrf`** (PR
[#27](https://github.com/X2C-fun/casinovaultinfra/pull/27)).

---

## 0. Prerequisites (once)

- **Node.js 20+** and **npm 10+** (`node -v`, `npm -v`).
- An **npm account** that is a member of the **`@x2c-fun`** npm organization
  (the package is scoped `@x2c-fun/...`). If the org does not exist yet, create
  it once at <https://www.npmjs.com/org/create> (free for public packages), or
  publish under your own scope — see "Changing the scope" at the bottom.
- Be logged in:

  ```bash
  npm login          # opens the browser; use an account in the @x2c-fun org
  npm whoami         # should print your npm username
  ```

- If your npm account has 2FA on (it should), keep your authenticator handy —
  `npm publish` will ask for a one-time code (OTP).

---

## 1. Get the branch

```bash
git clone https://github.com/X2C-fun/casinovaultinfra.git   # or: cd into your existing clone
cd casinovaultinfra
git fetch origin
git checkout feat/sdk-backend-vrf
git pull
```

> After the PR is merged you can publish from `main` instead — the commands are
> identical, just `git checkout main && git pull`.

---

## 2. Build, test, and publish the SDK

```bash
cd packages/sdk

npm install            # installs tsup/typescript/vitest for the build
npm run build          # produces dist/ (ESM + CJS + .d.ts)
npm test               # 11 unit tests — all must pass

# Dry run first: see EXACTLY what will be uploaded (should be package.json,
# README.md, and dist/*). No files outside dist/ and no source.
npm publish --dry-run

# Real publish. `prepublishOnly` rebuilds dist automatically.
npm publish --access public      # enter your OTP if prompted
```

`--access public` is required the first time a scoped package is published
(scoped packages default to private). It is also set in `package.json`
(`publishConfig.access = "public"`), so plain `npm publish` works too.

---

## 3. Verify the publish

```bash
# Confirm it is live and public
npm view @x2c-fun/casinovault-sdk version
npm view @x2c-fun/casinovault-sdk

# Prove a clean install works from a throwaway folder
cd /tmp && mkdir sdk-smoke && cd sdk-smoke && npm init -y
npm install @x2c-fun/casinovault-sdk @coral-xyz/anchor @solana/web3.js
node -e "const s=require('@x2c-fun/casinovault-sdk'); console.log('ok:', s.solToLamports('0.1'), s.DEFAULT_PROGRAM_ID.toBase58())"
# → ok: 100000000n EXTH5XRAqc45efhoL5UjwhhLFV4smgaB4m6QVG74Vqa7
```

---

## 4. Install the backend against the published SDK (optional)

The backend declares `@x2c-fun/casinovault-sdk: ^0.1.0`. Once the SDK is on npm:

```bash
cd packages/backend
npm install          # resolves the SDK from npm
npm test             # 8 tests
```

(Before the SDK is published, link it locally instead: `npm install && npm install ../sdk`.)

---

## 5. Merge the PR

Once the SDK is published and the backend installs cleanly, merge
[PR #27](https://github.com/X2C-fun/casinovaultinfra/pull/27) into `main`.

---

## 6. Later (post-publish): point the demo frontend at the SDK

The `casinovault-frontend` demo still uses its own copies of the client helpers
(`src/lib/*`). Wiring it to the published SDK is a small, **separate** follow-up
— it is intentionally **not** in this PR because:

1. The frontend cannot depend on `@x2c-fun/casinovault-sdk` until it is on npm
   (CI runs `npm ci`, which would 404 on an unpublished package).
2. The CI "Committed IDL matches build output" check diffs the frontend's own
   `src/idl/casino_vault.ts` against the build. Routing the frontend's IDL
   through the SDK means that CI check must be updated to diff the **SDK's** IDL
   instead.

Do it as its own PR after the SDK is published: add the SDK dependency, turn
`src/lib/*` into thin re-exports of the SDK, and update the CI IDL-diff step.
Everything works today without this — it is pure de-duplication.

---

## Future releases (version bump)

```bash
cd packages/sdk
npm version patch          # 0.1.0 -> 0.1.1 (or `minor` / `major`)
npm publish --access public
git push && git push --tags
```

Keep [`CHANGELOG.md`](CHANGELOG.md) updated with each release.

---

## Not in this runbook (deliberately)

- **`programs/casino_fair`** (the VRF coin-flip) is **not** published or
  deployed here. It is written and its unit tests pass, but it cannot be built
  for Solana on the pinned toolchain (a dependency needs Rust `edition2024`).
  Deploying it needs newer Solana platform-tools — see
  [`docs/fairness.md`](docs/fairness.md). It does **not** block the SDK publish
  or anything above.
- **No mainnet.** Everything here targets devnet.

## Changing the scope (if you are NOT using `@x2c-fun`)

Edit `packages/sdk/package.json` `"name"` to your scope (e.g.
`@yourorg/casinovault-sdk`), update the `@x2c-fun/casinovault-sdk` dependency in
`casinovault-frontend/package.json` and `packages/backend/package.json` to
match, then follow the steps above.
