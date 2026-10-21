/**
 * The vault IDL type now lives in the SDK (single source of truth). This file
 * is kept as a re-export so any lingering `@/idl/casino_vault` import keeps
 * working; prefer importing `CasinoVault` from `@x2c-fun/casinovault-sdk`.
 */
export type { CasinoVault } from "@x2c-fun/casinovault-sdk";
