# Releasing the SDK

How to publish the TypeScript SDK (`@x2c-fun/casinovault-sdk`, in
`packages/sdk`) to npm. Program releases are covered in
[Deployment](deployment.md); the settlement backend (`packages/backend`) is a
private reference and is never published.

Everything here targets devnet. The SDK is not audited.

## Prerequisites (once)

- Node.js 22 (as CI; 20.17 or later works) and npm 11 (CI pins 11.21.1);
  check with `node -v` and `npm -v`.
- An npm account that belongs to the `@x2c-fun` npm organization, with 2FA
  turned on. If you publish under another scope, see
  [Publishing under another scope](#publishing-under-another-scope).
- Logged in: `npm login`, then `npm whoami` prints your username.

## Publish

Publish from an up-to-date `main` whose CI is green:

```bash
git checkout main && git pull
cd packages/sdk
npm ci                  # exact versions from package-lock.json
npm run typecheck
npm run build           # dist/: ESM + CJS + type declarations
npm test
npm run smoke           # the built package loads with both import and require

npm publish --dry-run   # lists exactly what will be uploaded
npm publish             # prepublishOnly rebuilds dist; enter your OTP
```

The dry run must list only `package.json`, `README.md`, `LICENSE` and
`dist/*` (CI checks the same list).
`publishConfig.access` is `public`, so the first publish of the scoped package
needs no extra flag.

Then tag the release so it can be traced to a commit. SDK tags are prefixed so
they don't clash with the program's `vX.Y.Z` tags:

```bash
git tag -a sdk-v0.1.0 -m "casinovault-sdk v0.1.0"
git push origin sdk-v0.1.0
```

### Provenance (optional)

`npm publish --provenance` attaches a signed statement that links the tarball
to the commit and workflow that built it, shown on the package's npm page. It
only works when publishing from a supported CI provider such as GitHub
Actions, from a workflow job with `permissions: id-token: write` (and an npm
token, or npm trusted publishing, for the upload). A manual publish from a
laptop, as above, cannot add provenance. This repository has no publish
workflow yet.

## Verify

```bash
npm view @x2c-fun/casinovault-sdk version

# A clean install in a scratch folder loads in both module systems
mkdir sdk-check && cd sdk-check && npm init -y
npm install @x2c-fun/casinovault-sdk @coral-xyz/anchor@0.32.1 @solana/web3.js
node -e "import('@x2c-fun/casinovault-sdk').then(s => console.log(s.DEFAULT_PROGRAM_ID.toBase58()))"
node -e "console.log(require('@x2c-fun/casinovault-sdk').DEFAULT_PROGRAM_ID.toBase58())"
# Both print EXTH5XRAqc45efhoL5UjwhhLFV4smgaB4m6QVG74Vqa7
```

## Later releases

1. Land the changes on `main` with an entry in [CHANGELOG](../CHANGELOG.md).
2. Bump the version without creating a git tag, and commit it in a PR:
   `npm version patch --no-git-tag-version` (or `minor`). The SDK follows
   semver; while it is `0.x`, a minor bump may be breaking.
3. After merging, publish and tag as above.

An SDK built for one program interface must not be published for another. If
the program's instructions, accounts or events change, regenerate
`packages/sdk/src/idl/` from `anchor build` (CI checks it matches) and bump the
SDK's minor version.

## Publishing under another scope

Change `"name"` in `packages/sdk/package.json` (for example
`@yourorg/casinovault-sdk`), then follow the steps above. The backend depends
on the SDK by path (`file:../sdk`), so it needs no change.
