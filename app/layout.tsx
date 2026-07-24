import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || "https://renderball.com"),
  title: "Renderball — the AI-native design editor",
  // The founder's original tagline lives here by design (DESIGN.md Landing):
  // the H1 sharpened to "drawn", the meta keeps "visualized".
  description:
    "Design should not be prompted, it should be visualized. Draw a box, say what goes there, and a real element appears — decks generated on your brand in minutes. Editing is free; generation is metered.",
  openGraph: {
    title: "Renderball — the AI-native design editor",
    description:
      "Draw a box, say what goes there, and a real element appears. On-brand, editable decks in minutes. Editing free; generation metered.",
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
