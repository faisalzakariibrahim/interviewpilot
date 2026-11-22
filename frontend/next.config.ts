import type { NextConfig } from "next";

// The browser only ever talks to this app. Calls to /api/backend/* are
// forwarded by this server to the backend: the FastAPI process on this
// machine locally, or the backend deployment in the cloud.
const BACKEND_URL = (process.env.BACKEND_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
  // Camera and microphone for this site only; nothing else.
  { key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=(), payment=(), usb=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Content-Security-Policy", value: contentSecurityPolicy() },
];

/**
 * Scripts and styles come only from this site; nothing may frame it; forms post only here.
 * Network calls stay open to https/wss because the video and voice providers connect to
 * servers chosen at call time.
 */
function contentSecurityPolicy(): string {
  const dev = process.env.NODE_ENV !== "production";
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: mediastream: https:",
    `connect-src 'self' https: wss:${dev ? " http://localhost:* ws://localhost:*" : ""}`,
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    ...(dev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  devIndicators: false,
  async rewrites() {
    return [{ source: "/api/backend/:path*", destination: `${BACKEND_URL}/api/:path*` }];
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // Nothing personal is ever cached by a browser or a CDN.
      { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
    ];
  },
};

export default nextConfig;
