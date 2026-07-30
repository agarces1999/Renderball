import { ImageResponse } from "next/og";

/**
 * The card renderball.com shows when someone links it.
 *
 * Generated rather than a checked-in PNG so it never falls out of step with the
 * product's own language — and because a binary asset in the repo is one more
 * thing nobody remembers to update when the tagline changes.
 *
 * The orb is the crystal-ball motif from DESIGN.md, rebuilt with the CSS that
 * Satori actually supports: layered radial gradients, no conic-gradient, no
 * mask. It reads as the same object at unfurl size, which is all a 1200×630
 * card has to do. No custom fonts — Satori needs the font FILE, and shipping
 * Cabinet Grotesk here would cost a fetch on every render for type nobody
 * examines at this size.
 */
// Node runtime, deliberately. Everything else in this app is Node, and the
// edge sandbox behaves differently under a self-hosted standalone server than
// it does on Vercel — not a difference worth discovering from a broken card.
export const alt = "Renderball — the AI-native design editor";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#ffffff",
          backgroundImage:
            "radial-gradient(circle at 88% 12%, rgba(0,194,138,0.10) 0%, transparent 46%)," +
            "radial-gradient(circle at 8% 96%, rgba(120,180,255,0.10) 0%, transparent 42%)",
          padding: "72px 80px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 28,
              backgroundImage:
                "radial-gradient(circle at 68% 74%, rgba(150,200,255,0.30) 0%, transparent 58%)," +
                "radial-gradient(circle at 50% 50%, rgba(190,205,235,0.10) 0%, rgba(22,28,44,0.55) 68%, rgba(8,10,18,0.92) 100%)",
            }}
          />
          <div style={{ fontSize: 30, fontWeight: 600, color: "#10141c", letterSpacing: -0.4 }}>
            Renderball
          </div>
        </div>

        <div
          style={{
            display: "flex",
            flex: 1,
            flexDirection: "column",
            justifyContent: "center",
            gap: 28,
          }}
        >
          <div
            style={{
              fontSize: 66,
              fontWeight: 600,
              color: "#10141c",
              letterSpacing: -2,
              lineHeight: 1.08,
              maxWidth: 1010,
            }}
          >
            Design should not be prompted. It should be drawn.
          </div>
          <div style={{ fontSize: 29, color: "#69707e", lineHeight: 1.4, maxWidth: 840 }}>
            Draw a box, say what goes there, and a real element appears — on-brand,
            editable decks in minutes.
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 9, height: 9, borderRadius: 5, background: "#00c28a" }} />
          <div style={{ fontSize: 22, color: "#69707e", letterSpacing: 0.6 }}>renderball.com</div>
        </div>
      </div>
    ),
    size,
  );
}
