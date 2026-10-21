import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  // The consumer provides these; keep them external so there is one copy.
  external: ["@coral-xyz/anchor", "@solana/web3.js"],
});
