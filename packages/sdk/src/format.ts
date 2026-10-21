/**
 * Exact lamport <-> SOL conversion with no floating-point rounding, plus small
 * display helpers. Amounts on Solana are integer lamports; parsing user input
 * through `Number` would silently corrupt values like `0.1`, so the parser
 * works entirely in `BigInt`.
 */

export const LAMPORTS_PER_SOL_BIGINT = 1_000_000_000n;
const U64_MAX = 18_446_744_073_709_551_615n;
const SOL_DECIMALS = 9;
// Plain decimal only: no exponent ("1e-7"), sign, hex, or thousands separators.
const DECIMAL_SOL = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

/**
 * Formats lamports as a SOL string with 2–9 decimals, e.g. `1.00`, `0.25`,
 * `0.000000001`. Exact (pure `BigInt`, no float rounding) and
 * locale-independent: `.` decimal point, no grouping separators. A `number`
 * must be a safe integer.
 */
export function lamportsToSol(lamports: number | bigint): string {
  if (typeof lamports === "number" && !Number.isSafeInteger(lamports)) {
    throw new RangeError("lamports must be an integer (use bigint above 2^53)");
  }
  let n = BigInt(lamports);
  const negative = n < 0n;
  if (negative) n = -n;
  const whole = n / LAMPORTS_PER_SOL_BIGINT;
  let frac = (n % LAMPORTS_PER_SOL_BIGINT)
    .toString()
    .padStart(SOL_DECIMALS, "0")
    .replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/**
 * Parses a user-entered SOL amount into exact lamports.
 *
 * Rejects exponent notation, signs, separators, more than 9 decimal places,
 * zero, and values above `u64::MAX`. Anything that signs with real funds must
 * fail on a bad amount rather than move a different one.
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
    throw new Error("Amount is too large (exceeds u64)");
  }
  return lamports;
}

/** Shortens an address to `abcdâ€¦wxyz` for display. */
export function shortAddress(address: string, chars = 4): string {
  if (address.length <= chars * 2 + 3) return address;
  return `${address.slice(0, chars)}â€¦${address.slice(-chars)}`;
}
