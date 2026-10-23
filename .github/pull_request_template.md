## What and why

<!-- One or two sentences. Link the issue if there is one. -->

## Checklist

- [ ] `anchor test` passes locally
- [ ] `npm run lint` and `cargo fmt --all -- --check` pass
- [ ] If the program interface changed: IDL and types copied into `packages/sdk/src/idl/` (the only copy; the frontend picks it up after an SDK release)
- [ ] If account layout, PDA seeds, or error codes changed: migration noted in `CHANGELOG.md`
- [ ] No keys, `.env` files, or RPC URLs with API keys are included
