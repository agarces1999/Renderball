/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
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
    ],
  },
  async headers() {
    return [
      {
        // User-uploaded brand assets are served straight from public/uploads.
        // Stop the browser from MIME-sniffing them into an executable type;
        // pairs with the magic-byte whitelist in lib/uploads.ts.
        source: "/uploads/:path*",
        headers: [{ key: "X-Content-Type-Options", value: "nosniff" }],
      },
    ];
  },
};

module.exports = nextConfig;
