import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";

export const metadata: Metadata = {
  title: "Renderball — render your business story",
  description:
    "AI-native video generation. A brief becomes a story-driven, on-brand animated video. Render your business story.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ClerkProvider>
      <html lang="en">
        <head>
          {/* Per DESIGN.md: Cabinet Grotesk (display, story surfaces),
              Geist (UI/body), Geist Mono (timings/technical). Loaded via CDN
              for v1; self-host before GA. */}
          <link rel="preconnect" href="https://fonts.googleapis.com" />
          <link
            rel="preconnect"
            href="https://fonts.gstatic.com"
            crossOrigin="anonymous"
          />
          <link
            href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap"
            rel="stylesheet"
          />
          <link
            href="https://api.fontshare.com/v2/css?f[]=cabinet-grotesk@500,700,800&display=swap"
            rel="stylesheet"
          />
        </head>
        <body>
          <div className="min-h-screen">{children}</div>
        </body>
      </html>
    </ClerkProvider>
  );
}
