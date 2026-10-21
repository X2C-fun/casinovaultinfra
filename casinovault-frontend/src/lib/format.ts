export const LAMPORTS_PER_SOL_BIGINT = 1_000_000_000n;
const U64_MAX = 18_446_744_073_709_551_615n;
const SOL_DECIMALS = 9;
// Plain decimal only: no exponent ("1e-7"), sign, hex, or thousands separators.
const DECIMAL_SOL = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

export function lamportsToSol(lamports: number | bigint): string {
  const n = Number(lamports) / 1e9;
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 9,
  });
}

/**
 * Parses a user-entered SOL amount into lamports exactly (no float rounding).
 * Rejects exponent notation, more than 9 decimals, zero, and values above u64.
 */
export function solToLamports(sol: string): bigint {
  const trimmed = String(sol ?? "").trim();
  if (!DECIMAL_SOL.test(trimmed)) {
    throw new Error("Enter a plain decimal SOL amount, e.g. 0.25");
  }
  const [whole = "", frac = ""] = trimmed.split(".");
  if (frac.length > SOL_DECIMALS) {
    throw new Error("SOL supports at most 9 decimal places");
  }
  const lamports =
    BigInt(whole || "0") * LAMPORTS_PER_SOL_BIGINT +
    BigInt(frac.padEnd(SOL_DECIMALS, "0"));
  if (lamports < 1n) {
    throw new Error("Amount must be at least 1 lamport (0.000000001 SOL)");
  }
  if (lamports > U64_MAX) {
    throw new Error("Amount is too large");
  }
  return lamports;
}

export function shortAddress(address: string, chars = 4): string {
  if (address.length <= chars * 2 + 3) return address;
  return `${address.slice(0, chars)}…${address.slice(-chars)}`;
}
