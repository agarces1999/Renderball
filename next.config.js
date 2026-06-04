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
      "@remotion/cli",
      // esbuild has dynamic requires + ships a .d.ts that webpack tries
      // to parse as JS. Mark external so it's resolved at runtime by
      // the iframe-preview route.
      "esbuild",
    ],
  },
};

module.exports = nextConfig;
