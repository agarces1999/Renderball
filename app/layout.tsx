import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import localFont from "next/font/local";
import "./globals.css";

/* Cabinet Grotesk (display, story surfaces — DESIGN.md) self-hosted from
   app/fonts (Fontshare's ITF Free Font License permits it). Self-hosting all
   three families removes two render-blocking third-party stylesheets and the
   Google-Fonts GDPR wrinkle (perf pass, 2026-08-31). */
const cabinet = localFont({
  src: [
    { path: "./fonts/cabinet-grotesk-500.woff2", weight: "500" },
    { path: "./fonts/cabinet-grotesk-700.woff2", weight: "700" },
    { path: "./fonts/cabinet-grotesk-800.woff2", weight: "800" },
  ],
  variable: "--font-cabinet",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || "https://renderball.com"),
  // "AI decks you can edit" is the go-to line (founder, 2026-07-30) — see
  // DESIGN.md. It goes in every DESCRIPTOR slot: what you say when someone asks
  // what this is. The manifesto tagline stays where it belongs, on the hero.
  title: "Renderball — AI decks you can edit",
  description:
    "AI decks you can edit. Draw a box, say what goes there, and a real element appears — on your brand, in minutes. Editing is free; generation is metered.",
  openGraph: {
    title: "Renderball — AI decks you can edit",
    description:
      "Draw a box, say what goes there, and a real element appears. On your brand, in minutes. Editing free; generation metered.",
    siteName: "Renderball",
    type: "website",
    // The image itself comes from app/opengraph-image.tsx, which Next attaches
    // to every route that does not declare its own. /s/<token> declares its
    // own — a shared deck should unfurl as that deck, not as our marketing.
  },
  twitter: {
    card: "summary_large_image",
    title: "Renderball — AI decks you can edit",
    description:
      "Draw a box, say what goes there, and a real element appears. On your brand, in minutes.",
  },
  // Relative canonical: resolves per-route against metadataBase, so every
  // page names its own URL (SEO pass, 2026-08-31).
  alternates: { canonical: "./" },
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
      <html
        lang="en"
        suppressHydrationWarning
        className={`${GeistSans.variable} ${GeistMono.variable} ${cabinet.variable}`}
      >
        <head>
          {/* The chrome follows the OS (dark-mode decision, 2026-08-31): the
              [data-theme=dark] token palette existed unused since the design
              system landed — this wires it to prefers-color-scheme before
              first paint (no flash) and tracks live OS changes. Deck CANVASES
              are unaffected: compositions render in iframes with their own
              authored backgrounds — paper stays paper, the chrome dims. */}
          <script
            dangerouslySetInnerHTML={{
              __html:
                'try{var m=matchMedia("(prefers-color-scheme: dark)"),s=function(){document.documentElement.dataset.theme=m.matches?"dark":"light"};s();m.addEventListener("change",s)}catch(e){}',
            }}
          />
        </head>
        <body>
          <div className="min-h-screen">{children}</div>
        </body>
      </html>
    </ClerkProvider>
  );
}
