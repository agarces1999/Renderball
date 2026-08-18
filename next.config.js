/** @type {import('next').NextConfig} */
const nextConfig = {
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
    ];
  },
  async headers() {
    return [
      {
        // Global security baseline (launch audit): HSTS, no referrer leakage,
        // clickjacking protection, no MIME sniffing — app-wide.
        // frame-ancestors 'self' still allows the preview/editor's same-origin
        // scene iframes. A full CSP is deferred deliberately: the generated
        // compositions inline styles/fonts/images by design, so a strict
        // policy needs its own allowlist pass.
        source: "/:path*",
        headers: [
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
        ],
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
