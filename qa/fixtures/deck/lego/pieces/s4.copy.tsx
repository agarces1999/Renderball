
        <div style={{ position: "absolute", top: 130, left: "50%", transform: "translateX(-50%)", display: "flex", flexDirection: "column", alignItems: "center", gap: 26, width: 1000 }}>
          {/* Eyebrow */}
          <div style={{ fontFamily: FONT_BODY, fontSize: 14, fontWeight: 600, letterSpacing: "0.18em", textTransform: "uppercase", color: PALETTE.signature, display: "inline-flex", alignItems: "center", gap: 12 }}>
            <span style={{ width: 32, height: 2, background: PALETTE.signature, opacity: 0.55, borderRadius: 1 }} />
            <span data-content-path="eyebrow">{c.eyebrow}</span>
          </div>

          {/* Headline */}
          <h1 data-content-path="headline" style={{ fontFamily: FONT_DISPLAY, fontWeight: 800, fontSize: 92, lineHeight: 1.0, letterSpacing: "-0.035em", color: PALETTE.ink, margin: 0, textAlign: "center" }}>
            {c.headline}
          </h1>

          {/* Accent bar — ~40% canvas width */}
          <div style={{ width: 768, height: 5, background: PALETTE.signature, borderRadius: 3, transformOrigin: "center", animation: "s4BarGrow 0.7s cubic-bezier(.2,.8,.2,1) 0.2s both" }} />

          {/* Lede */}
          <p data-content-path="lede" style={{ fontFamily: FONT_BODY, fontSize: 26, lineHeight: 1.5, color: PALETTE.ink, opacity: 0.82, margin: 0, textAlign: "center", maxWidth: 780 }}>
            {c.lede}
          </p>
        </div>
      