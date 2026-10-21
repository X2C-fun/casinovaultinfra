/**
 * @x2c-fun/casinovault-sdk
 *
 * TypeScript SDK for the Casino Vault program: typed IDL, PDA derivation,
 * instruction builders, a safe withdraw-transaction builder + client-side
 * assertion, account reads, event decoding, and pool reconciliation.
 *
 * The SDK never reads `process.env` and depends on no UI framework, so it runs
 * unchanged in a browser bundle or a Node backend.
 */

export * from "./constants";
export * from "./pdas";
export * from "./format";
export * from "./idl";
export * from "./program";
export * from "./instructions";
export * from "./withdrawTx";
export * from "./reads";
export * from "./events";
export * from "./reconcile";
