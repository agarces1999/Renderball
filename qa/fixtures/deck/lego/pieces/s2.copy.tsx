
        <div style={{
          position: "absolute", left: 280, top: 730, width: 600,
          display: "flex", flexDirection: "column", gap: 18, zIndex: 7,
        }}>
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 10,
            fontFamily: FONT_BODY, fontSize: 13, fontWeight: 700,
            letterSpacing: "0.2em", textTransform: "uppercase", color: PALETTE.signature,
          }}>
            <span style={{ width: 26, height: 2, background: PALETTE.signature, opacity: 0.5 }} />
            <span data-content-path="eyebrow">{c.eyebrow}</span>
          </div>
          <h1 data-content-path="headline" style={{
            fontFamily: FONT_DISPLAY, fontSize: 80, fontWeight: 800,
            lineHeight: 1.02, letterSpacing: "-0.03em", color: PALETTE.signature,
            margin: 0, maxWidth: 580,
          }}>
            {c.headline}
          </h1>
          <p data-content-path="lede" style={{
            fontFamily: FONT_BODY, fontSize: 24, fontWeight: 400, lineHeight: 1.45,
            color: PALETTE.slate, margin: 0, maxWidth: 560, opacity: 0.9,
          }}>{c.lede}</p>
        </div>

        {/* Caption — workflow annotation near prompt */}
        <div style={{
          position: "absolute", left: 920, top: 822, width: 560, zIndex: 6,
          display: "flex", alignItems: "center", gap: 8,
        }}>
          <span style={{
            fontFamily: FONT_MONO, fontSize: 12, fontWeight: 500, letterSpacing: "0.1em",
            textTransform: "uppercase", color: PALETTE.steel,
          }} data-content-path="caption">
            {c.caption}
          </span>
        </div>
      