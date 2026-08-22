
        <div
          data-throughline={THROUGHLINE_SLUG}
          style={{
            ...THROUGHLINE_ANCHOR,
            width: 820,
            height: 200,
            boxSizing: "border-box",
          }}
        >
          {/* "4 diapositivas" indicator */}
          <div
            style={{
              position: "absolute",
              top: -30,
              right: 0,
              fontFamily: FONT_MONO,
              fontSize: 14,
              color: PALETTE.steel,
              letterSpacing: "0.04em",
            }}
          >
            4 diapositivas
          </div>

          {/* Thumbnail row */}
          <div
            style={{
              display: "flex",
              gap: 16,
              justifyContent: "center",
              alignItems: "flex-start",
            }}
          >
            {/* Thumbnail 1 — Title slide */}
            <div
              style={{
                width: 191,
                height: 130,
                border: `1px solid ${PALETTE.slate}`,
                borderRadius: 10,
                background: PALETTE.white,
                padding: 16,
                boxSizing: "border-box",
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                alignItems: "center",
                gap: 12,
                animation: "s3ThumbFloat 5s ease-in-out 0s infinite",
                boxShadow: "0 8px 24px rgba(26,35,50,0.06)",
              }}
            >
              <div
                style={{
                  fontFamily: FONT_DISPLAY,
                  fontWeight: 700,
                  fontSize: 16,
                  color: PALETTE.ink,
                  textAlign: "center",
                }}
              >
                Tu Empresa
              </div>
              <div
                style={{
                  width: 48,
                  height: 4,
                  background: PALETTE.signature,
                  borderRadius: 2,
                  transformOrigin: "center",
                  animation: "s3AccentBarGrow 1.2s ease-out 0.3s both",
                }}
              />
            </div>

            {/* Thumbnail 2 — Three-bullet slide */}
            <div
              style={{
                width: 191,
                height: 130,
                border: `1px solid ${PALETTE.slate}`,
                borderRadius: 10,
                background: PALETTE.white,
                padding: 16,
                boxSizing: "border-box",
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                gap: 9,
                animation: "s3ThumbFloat 5s ease-in-out 0.8s infinite",
                boxShadow: "0 8px 24px rgba(26,35,50,0.06)",
              }}
            >
              {bulletLines.map((line, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span
                    style={{
                      width: 5,
                      height: 5,
                      borderRadius: "50%",
                      background: PALETTE.sky,
                      flexShrink: 0,
                    }}
                  />
                  <span
                    style={{
                      fontFamily: FONT_BODY,
                      fontSize: 10,
                      color: PALETTE.slate,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {line}
                  </span>
                </div>
              ))}
            </div>

            {/* Thumbnail 3 — Stat / growth slide */}
            <div
              style={{
                width: 191,
                height: 130,
                border: `1px solid ${PALETTE.slate}`,
                borderRadius: 10,
                background: PALETTE.white,
                padding: 16,
                boxSizing: "border-box",
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                alignItems: "center",
                gap: 10,
                animation: "s3ThumbFloat 5s ease-in-out 1.6s infinite",
                boxShadow: "0 8px 24px rgba(26,35,50,0.06)",
              }}
            >
              <svg viewBox="0 0 88 34" width={100} height={38}>
                <polyline
                  points="4,28 18,24 30,26 42,16 54,13 66,8 84,4"
                  fill="none"
                  stroke={PALETTE.signature}
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeDasharray={200}
                  style={{ animation: "s3SparkDraw 2s ease-out 0.5s both" }}
                />
                <circle cx="84" cy="4" r="3.5" fill={PALETTE.signature} />
              </svg>
              <div
                style={{
                  fontFamily: FONT_BODY,
                  fontSize: 10,
                  color: PALETTE.slate,
                  textAlign: "center",
                  letterSpacing: "0.01em",
                }}
              >
                crecimiento interanual
              </div>
            </div>

            {/* Thumbnail 4 — Closing slide with CTA pill */}
            <div
              style={{
                width: 191,
                height: 130,
                border: `1px solid ${PALETTE.slate}`,
                borderRadius: 10,
                background: PALETTE.white,
                padding: 16,
                boxSizing: "border-box",
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                alignItems: "center",
                gap: 9,
                animation: "s3ThumbFloat 5s ease-in-out 2.4s infinite",
                boxShadow: "0 8px 24px rgba(26,35,50,0.06)",
              }}
            >
              <div style={{ width: 110, height: 5, background: PALETTE.mist, borderRadius: 2 }} />
              <div style={{ width: 86, height: 5, background: PALETTE.mist, borderRadius: 2 }} />
              <div
                style={{
                  background: PALETTE.signature,
                  color: PALETTE.white,
                  fontFamily: FONT_BODY,
                  fontSize: 12,
                  fontWeight: 600,
                  padding: "6px 18px",
                  borderRadius: 999,
                  marginTop: 4,
                  animation: "s3PillPulse 3s ease-in-out 1.5s infinite",
                }}
              >
                Contáctanos
              </div>
            </div>
          </div>

          {/* Tiny connector dots between thumbnails */}
          <div
            style={{
              position: "absolute",
              bottom: -16,
              left: "50%",
              transform: "translateX(-50%)",
              display: "flex",
              gap: 6,
            }}
          >
            {[0, 1, 2, 3].map((i) => (
              <span
                key={i}
                style={{
                  width: 4,
                  height: 4,
                  borderRadius: "50%",
                  background: i === 0 ? PALETTE.signature : PALETTE.mist,
                }}
              />
            ))}
          </div>
        </div>
      