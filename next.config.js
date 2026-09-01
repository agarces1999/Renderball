/** @type {import('next').NextConfig} */
const nextConfig = {
  // Gate/CI builds write to their own dir (RB_BUILD_DIR=.next-gate) so a
  // production build can never corrupt the .next a running dev server is
  // serving from — that exact clash broke the dev server twice on
  // 2026-08-19 (pages rendered without their iframe until restart).
  distDir: process.env.RB_BUILD_DIR || ".next",
  reactStrictMode: true,
  experimental: {
    // Boot hook (instrumentation.ts): warms the sandbox pool + SIGTERM drain.
    instrumentationHook: true,
    // Remotion's deps (puppeteer, ffmpeg binaries) are server-only and
    // must not get pulled into client bundles. In Next.js 14 the key is
    // `experimental.serverComponentsExternalPackages`; flat
    // `serverExternalPackages` arrives in Next.js 15.
    serverComponentsExternalPackages: [
      "@remotion/bundler",
      "@remotion/renderer",
      // esbuild has dynamic requires + ships a .d.ts that webpack tries
      // to parse as JS. Mark external so it's resolved at runtime by
      // the iframe-preview route.
      "esbuild",
      // pdfjs is 35MB and server-only (attachment text extraction). Bundling
      // it would ship a PDF engine to every browser that loads the editor.
      "pdfjs-dist",
    ],
  },
  async redirects() {
    return [
      {
        // /videos → /documents (canvas pivot). This lives here, NOT as a
        // page-level permanentRedirect(): a prerendered redirect page served
        // a 308 with NO Location header in production (verified against both
        // Cloudflare and Railway directly), so old bookmarks dead-ended.
        // A config redirect is emitted by the server router and always
        // carries Location.
        source: "/videos",
        destination: "/documents",
        permanent: true,
      },
      {
        source: "/videos/:path*",
        destination: "/documents",
        permanent: true,
      },
      {
        // People type /pricing; the pricing lives on the landing as a
        // section. A typed URL must not 404 (SEO pass, 2026-08-31).
        source: "/pricing",
        destination: "/#pricing",
        permanent: false,
      },
    ];
  },
  async headers() {
    const isDev = process.env.NODE_ENV !== "production";
    // The app-document CSP (security pass, 2026-08-31). Scoped to PAGE routes
    // only — /api/** is excluded on purpose, so the generated compositions
    // (served as same-origin iframes under /api/preview and /api/dev) keep
    // their by-design freedom to inline styles/fonts and load brand assets.
    // 'unsafe-inline' for scripts is the deliberate v1 compromise: Next 14
    // hydration + the pre-paint theme script are inline; the nonce pipeline
    // is a follow-up. Everything else is tight: no eval (prod), no objects,
    // no foreign frames beyond Clerk's Turnstile, connect locked to self +
    // Clerk. img-src stays broad (https:) because crawled brand logos render
    // in the ceremony and Brand panel from their own hosts.
    const csp = [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""} https://clerk.renderball.com https://*.clerk.accounts.dev`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "connect-src 'self' https://clerk.renderball.com https://*.clerk.accounts.dev https://clerk-telemetry.com",
      "frame-src 'self' https://challenges.cloudflare.com",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'self'",
    ].join("; ");
    return [
      {
        // Global security baseline (launch audit): HSTS, no referrer leakage,
        // clickjacking protection, no MIME sniffing — app-wide.
        // frame-ancestors 'self' still allows the preview/editor's same-origin
        // scene iframes.
        source: "/:path*",
        headers: [
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
        ],
      },
      {
        // Full CSP for app DOCUMENTS (everything except /api/**).
        source: "/((?!api/).*)",
        headers: [{ key: "Content-Security-Policy", value: csp }],
      },
      {
        // User-uploaded brand assets are served straight from public/uploads.
        // Stop the browser from MIME-sniffing them into an executable type
        // (pairs with the magic-byte whitelist in lib/uploads.ts), and sandbox
        // them — an uploaded SVG can carry inline script; on the app origin
        // that is stored XSS without this.
        source: "/uploads/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Content-Security-Policy", value: "default-src 'none'; style-src 'unsafe-inline'; sandbox" },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
