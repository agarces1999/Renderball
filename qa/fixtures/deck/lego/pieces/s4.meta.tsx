
        <div style={{ position: "absolute", left: 1360, top: 620, transform: "translateX(-50%)", display: "flex", flexDirection: "column", alignItems: "center", gap: 22 }}>
          {/* URL */}
          <div data-content-path="cta.secondary" style={{ fontFamily: FONT_MONO, fontSize: 20, color: PALETTE.slate, letterSpacing: "0.02em" }}>
            {c.cta?.secondary}
          </div>

          {/* Info card — caption split into two labeled rows */}
          <div data-content-path="caption" style={{
            border: `1px solid ${PALETTE.mist}`,
            borderRadius: 14,
            padding: "18px 32px",
            display: "flex",
            gap: 28,
            alignItems: "center",
            background: PALETTE.white,
            boxShadow: "0 4px 20px rgba(15,23,42,0.04)",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: PALETTE.signature, flexShrink: 0 }} />
              <span style={{ fontFamily: FONT_BODY, fontSize: 16, color: PALETTE.ink, fontWeight: 600, letterSpacing: "0.01em" }}>Cupos limitados</span>
            </div>
            <div style={{ width: 1, height: 22, background: PALETTE.mist }} />
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: PALETTE.signature, flexShrink: 0 }} />
              <span style={{ fontFamily: FONT_BODY, fontSize: 16, color: PALETTE.ink, fontWeight: 600, letterSpacing: "0.01em" }}>Beta privada</span>
            </div>
          </div>
        </div>
      