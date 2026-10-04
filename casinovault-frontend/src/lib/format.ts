export function lamportsToSol(lamports: number | bigint): string {
  const n = Number(lamports) / 1e9;
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 9,
  });
}

export function solToLamports(sol: string): bigint {
  const trimmed = sol.trim();
  if (!trimmed || Number.isNaN(Number(trimmed)) || Number(trimmed) <= 0) {
    throw new Error("Enter a positive SOL amount");
  }
  const [whole, frac = ""] = trimmed.split(".");
  const fracPadded = (frac + "000000000").slice(0, 9);
  return BigInt(whole || "0") * 1_000_000_000n + BigInt(fracPadded);
}

export function shortAddress(address: string, chars = 4): string {
  if (address.length <= chars * 2 + 3) return address;
  return `${address.slice(0, chars)}…${address.slice(-chars)}`;
}
