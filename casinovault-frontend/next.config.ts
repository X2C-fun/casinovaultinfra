import type { NextConfig } from "next";
import path from "path";

const securityHeaders = [
  // Nobody may frame the app (clickjacking a wallet prompt).
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // Signed approvals must never be cached by a proxy or the browser.
      {
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
    ];
  },
  // Keep this app's lockfile as the workspace root (parent monorepo has another).
  turbopack: {
    root: path.join(__dirname),
  },
  transpilePackages: [
    "@solana/wallet-adapter-base",
    "@solana/wallet-adapter-react",
    "@solana/wallet-adapter-react-ui",
    "@solana/wallet-adapter-phantom",
    "@solana/wallet-adapter-solflare",
    "@coral-xyz/anchor",
  ],
  webpack: (config) => {
    config.resolve.fallback = {
      ...(config.resolve.fallback ?? {}),
      fs: false,
      path: false,
      os: false,
      crypto: false,
    };
    config.externals = [
      ...(config.externals || []),
      "pino-pretty",
      "lokijs",
      "encoding",
    ];
    return config;
  },
};

export default nextConfig;
