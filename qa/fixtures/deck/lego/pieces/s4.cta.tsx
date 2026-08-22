
        <ThroughlineRect
          width={380}
          height={76}
          animate="breathe"
          style={{
            borderRadius: 999,
            background: PALETTE.signature,
            border: "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 16px 48px rgba(0,120,168,0.32), 0 4px 12px rgba(0,120,168,0.18)",
          }}
        >
          <span data-content-path="cta.primary" style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 24, color: PALETTE.white, letterSpacing: "0.01em" }}>
            {c.cta?.primary}
          </span>
        </ThroughlineRect>
      