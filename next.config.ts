import type { NextConfig } from "next";

type CspEnv = {
  nodeEnv?: string;
  vercelEnv?: string;
};

// Content-Security-Policy without nonces (node_modules/next/dist/docs/01-app/
// 02-guides/content-security-policy.md, "Without Nonces"). The home and
// privacy pages are statically prerendered, so a per-request nonce is not an
// option without forcing every page dynamic; Next's inline bootstrap scripts
// therefore need 'unsafe-inline'. Everything else is locked to this origin:
// - Vercel Web Analytics v2 loads /_vercel/insights/script.js (or a
//   first-party base path) and posts to the same origin, so 'self' covers it.
//   Only `next dev` loads the debug script from va.vercel-scripts.com.
// - PDF export (jsPDF) builds a blob: URL for the download and may use data:
//   URIs; the optional Unicode font is fetched from /fonts on this origin.
// - next/font self-hosts the Geist fonts under /_next/static.
// - Vercel's preview toolbar (vercel.live) is allowed on Preview builds only.
export function buildContentSecurityPolicy(env: CspEnv = {}): string {
  const isDev = env.nodeEnv === "development";
  const isPreview = env.vercelEnv === "preview";
  const toolbar = isPreview ? ["https://vercel.live"] : [];

  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": [
      "'self'",
      "'unsafe-inline'",
      ...(isDev ? ["'unsafe-eval'", "https://va.vercel-scripts.com"] : []),
      ...toolbar,
    ],
    "style-src": ["'self'", "'unsafe-inline'", ...toolbar],
    "img-src": [
      "'self'",
      "blob:",
      "data:",
      ...(isPreview ? ["https://vercel.live", "https://vercel.com"] : []),
    ],
    "font-src": [
      "'self'",
      "data:",
      ...(isPreview ? ["https://vercel.live", "https://assets.vercel.com"] : []),
    ],
    "connect-src": [
      "'self'",
      ...(isDev ? ["ws:", "https://va.vercel-scripts.com"] : []),
      ...(isPreview ? ["https://vercel.live", "wss://ws-us3.pusher.com"] : []),
    ],
    "worker-src": ["'self'", "blob:"],
    "frame-src": isPreview ? ["https://vercel.live"] : ["'none'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
  };

  const policy = Object.entries(directives).map(
    ([name, sources]) => `${name} ${sources.join(" ")}`
  );
  // Local `next dev` is plain http; upgrading would break it.
  if (!isDev) policy.push("upgrade-insecure-requests");
  return policy.join("; ");
}

export function buildSecurityHeaders(
  env: CspEnv = {}
): { key: string; value: string }[] {
  return [
    {
      key: "Content-Security-Policy",
      value: buildContentSecurityPolicy(env),
    },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    // Legacy twin of frame-ancestors 'none' for older browsers.
    { key: "X-Frame-Options", value: "DENY" },
    {
      key: "Permissions-Policy",
      value:
        "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
    },
  ];
}

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: buildSecurityHeaders({
          nodeEnv: process.env.NODE_ENV,
          vercelEnv: process.env.VERCEL_ENV,
        }),
      },
    ];
  },
};

export default nextConfig;
