"use client";

import dynamic from "next/dynamic";

const SolanaWalletProvider = dynamic(
  () =>
    import("@/components/SolanaWalletProvider").then(
      (m) => m.SolanaWalletProvider,
    ),
  { ssr: false },
);

export function AppProviders({ children }: { children: React.ReactNode }) {
  return <SolanaWalletProvider>{children}</SolanaWalletProvider>;
}
