import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || "https://renderball.com"),
  title: "Renderball — render your business story",
  description:
    "AI-native video generation. A brief becomes a story-driven, on-brand animated video. Render your business story.",
  openGraph: {
    title: "Renderball — render your business story",
    description:
      "AI-native video generation. A brief becomes a story-driven, on-brand animated video.",
    siteName: "Renderball",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ClerkProvider
      appearance={{
        variables: {
          colorPrimary: "#00c28a",
          colorText: "#10141c",
          colorTextSecondary: "#69707e",
          colorBackground: "#ffffff",
          colorInputBackground: "#f5f7f9",
          colorInputText: "#10141c",
          borderRadius: "12px",
          fontFamily: '"Geist", system-ui, sans-serif',
        },
        elements: {
          formButtonPrimary:
            "bg-accent text-accent-ink font-semibold normal-case hover:brightness-110",
          card: "shadow-none border border-hairline",
          headerTitle: "font-display tracking-tight",
          logoImage: "h-8 w-8",
        },
        layout: {
          logoImageUrl: "/orb.svg",
          logoPlacement: "inside",
          socialButtonsPlacement: "top",
        },
      }}
    >
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
