import type { NextConfig } from "next";

const TECHNO_BASE =
  process.env.NEXT_PUBLIC_TECHNOCORE_BASE_URL ?? "https://technocore.chat";

const nextConfig: NextConfig = {
  // Production CSP: the browser only talks to the same-origin proxy (/api/tc)
  // and, in principle, the configured Technocore host. No analytics, no other
  // origins, no frame embedding. In development Next's HMR needs unsafe-eval,
  // so the header is emitted for production builds only.
  ...(process.env.NODE_ENV === "production"
    ? {
        async headers() {
          const csp = [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            "font-src 'self' data:",
            `connect-src 'self' ${TECHNO_BASE}`,
            "frame-ancestors 'none'",
            "base-uri 'self'",
            "form-action 'self'",
          ].join("; ");
          return [
            {
              source: "/:path*",
              headers: [{ key: "Content-Security-Policy", value: csp }],
            },
          ];
        },
      }
    : {}),
};

export default nextConfig;