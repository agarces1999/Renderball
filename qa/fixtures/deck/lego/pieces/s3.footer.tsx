
        {/* Divider */}
        <div
          style={{
            position: "absolute",
            left: 80,
            right: 80,
            top: 760,
            height: 1,
            background: PALETTE.mist,
          }}
        />

        {/* Consistency chips */}
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: 796,
            transform: "translateX(-50%)",
            display: "flex",
            gap: 18,
          }}
        >
          {chips.map((chip, i) => (
            <div
              key={i}
              style={{
                border: `1px solid ${PALETTE.cyan}`,
                borderRadius: 999,
                padding: "9px 22px",
                fontFamily: FONT_BODY,
                fontSize: 16,
                fontWeight: 500,
                color: PALETTE.ink,
                background: `${PALETTE.cyan}0a`,
                animation: `s3ChipGlow 4.5s ease-in-out ${i * 0.6}s infinite`,
              }}
            >
              {chip}
            </div>
          ))}
        </div>

        {/* Caption */}
        {c.caption && (
          <div
            data-content-path="caption"
            style={{
              position: "absolute",
              left: "50%",
              top: 868,
              transform: "translateX(-50%)",
              fontFamily: FONT_MONO,
              fontSize: 14,
              color: PALETTE.steel,
              textAlign: "center",
              letterSpacing: "0.06em",
              maxWidth: 800,
            }}
          >
            {c.caption}
          </div>
        )}

        {/* Left meta footer */}
        <div
          style={{
            position: "absolute",
            left: 80,
            bottom: 72,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <div
            style={{
              fontFamily: FONT_MONO,
              fontSize: 12,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: PALETTE.steel,
            }}
          >
            Identidad aplicada
          </div>
          <div
            style={{
              fontFamily: FONT_DISPLAY,
              fontSize: 22,
              fontWeight: 700,
              color: PALETTE.ink,
            }}
          >
            Tipografía · Paleta · Tono
          </div>
        </div>

        {/* Right meta footer */}
        <div
          style={{
            position: "absolute",
            right: 80,
            bottom: 72,
            display: "flex",
            flexDirection: "column",
            gap: 6,
            textAlign: "right",
          }}
        >
          <div
            style={{
              fontFamily: FONT_MONO,
              fontSize: 12,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: PALETTE.steel,
            }}
          >
            Cierre con CTA
          </div>
          <div
            style={{
              fontFamily: FONT_DISPLAY,
              fontSize: 22,
              fontWeight: 700,
              color: PALETTE.ink,
            }}
          >
            Portada → Cierre
          </div>
        </div>
      