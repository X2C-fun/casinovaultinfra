/**
 * Interop shim for `@coral-xyz/anchor` (internal; not re-exported).
 *
 * Anchor 0.32.1 ships no `exports` map, so Node's ESM loader loads its
 * CommonJS build, and named imports like `import { BN } from "@coral-xyz/anchor"`
 * crash at link time (`Named export 'BN' not found`). Bundlers, by contrast,
 * pick its ESM build, where the names are real exports and there is no
 * `default`. A namespace import works in both: use the namespace when it
 * already carries the runtime values, otherwise its CommonJS `default`.
 *
 * Every other SDK file imports Anchor values from here and Anchor types with
 * `import type`, so neither the ESM nor the CJS build depends on how the
 * consumer's runtime resolves the package.
 */
import * as anchorNs from "@coral-xyz/anchor";

type AnchorModule = typeof anchorNs;

const ns = anchorNs as AnchorModule & { default?: AnchorModule };
const anchor: AnchorModule =
  typeof ns.BN === "function" ? ns : (ns.default as AnchorModule);

if (!anchor || typeof anchor.BN !== "function") {
  throw new Error("@x2c-fun/casinovault-sdk: could not load @coral-xyz/anchor");
}

export const BN = anchor.BN;
export type BN = anchorNs.BN;

export const AnchorProvider = anchor.AnchorProvider;
export type AnchorProvider = anchorNs.AnchorProvider;

export const Program = anchor.Program;
export type Program<T extends anchorNs.Idl = anchorNs.Idl> = anchorNs.Program<T>;

export const BorshCoder = anchor.BorshCoder;
export type BorshCoder = anchorNs.BorshCoder;

export const EventParser = anchor.EventParser;

export const bs58 = anchor.utils.bytes.bs58;
