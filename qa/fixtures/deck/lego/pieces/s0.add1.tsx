<div style={{ position: "absolute", left: 198, top: 846, width: 795, height: 234, overflow: "hidden", zIndex: 1 }}><div
  style={{
    display: "flex",
    alignItems: "center",
    gap: 16,
    padding: "18px 26px",
    background: PALETTE.white,
    borderRadius: 12,
    border: `1px solid ${PALETTE.mist}`,
    boxShadow: "0 6px 28px rgba(26,35,50,0.10), 0 1px 3px rgba(26,35,50,0.06)",
    fontFamily: FONT_BODY,
    color: PALETTE.ink,
    overflow: "hidden",
  }}
>
  {/* accent bar */}
  <div
    style={{
      width: 4,
      height: "100%",
      borderRadius: 2,
      background: `linear-gradient(180deg, ${PALETTE.signature}, ${PALETTE.cyan})`,
      flexShrink: 0,
    }}
  />

  {/* big stat */}
  <div
    style={{
      display: "flex",
      alignItems: "baseline",
      gap: 4,
      flexShrink: 0,
    }}
  >
    <span
      style={{
        fontFamily: FONT_DISPLAY,
        fontSize: 42,
        fontWeight: 800,
        lineHeight: 1,
        color: PALETTE.signature,
        letterSpacing: "-0.02em",
      }}
    >
      10×
    </span>
    <span
      style={{
        fontFamily: FONT_BODY,
        fontSize: 15,
        fontWeight: 600,
        color: PALETTE.ink,
        whiteSpace: "nowrap",
      }}
    >
      más rápido
    </span>
  </div>

  {/* divider */}
  <div
    style={{
      width: 1,
      height: 40,
      background: PALETTE.mist,
      flexShrink: 0,
    }}
  />

  {/* caption */}
  <div
    style={{
      display: "flex",
      flexDirection: "column",
      gap: 3,
      minWidth: 0,
      animation: "fadeRise 0.8s ease-out both",
    }}
  >
    <div
      style={{
        fontFamily: FONT_MONO,
        fontSize: 9,
        fontWeight: 500,
        letterSpacing: "0.18em",
        textTransform: "uppercase",
        color: PALETTE.steel,
      }}
    >
      Tiempo real
    </div>
    <div
      style={{
        fontFamily: FONT_BODY,
        fontSize: 13,
        fontWeight: 500,
        color: PALETTE.slate,
        lineHeight: 1.35,
        whiteSpace: "nowrap",
      }}
    >
      de brief a deck en minutos
    </div>
  </div>

  {/* pulse dot */}
  <div
    style={{
      marginLeft: "auto",
      width: 8,
      height: 8,
      borderRadius: "50%",
      background: PALETTE.signature,
      boxShadow: `0 0 14px ${PALETTE.signature}99`,
      flexShrink: 0,
      animation: "dotPulse 2.4s ease-in-out infinite",
    }}
  />

  {/* sweep sheen */}
  <div
    style={{
      position: "absolute",
      inset: 0,
      overflow: "hidden",
      borderRadius: 12,
      pointerEvents: "none",
    }}
  >
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "40%",
        height: "100%",
        background: `linear-gradient(90deg, transparent, ${PALETTE.cyan}22, transparent)`,
        animation: "sweep 6s ease-in-out infinite",
        animationDelay: "2.5s",
      }}
    />
  </div>
</div></div>