
        <div
          style={{
            position: "absolute",
            left: 80,
            top: 660,
            width: 720,
            animation: "breathe 5s ease-in-out infinite",
          }}
        >
          {/* Browser chrome */}
          <div
            style={{
              background: "#f8fafc",
              borderRadius: "12px 12px 0 0",
              border: `1px solid ${PALETTE.mist}`,
              borderBottom: "none",
              overflow: "hidden",
            }}
          >
            {/* Tab bar */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "10px 14px 6px",
              }}
            >
              <div style={{ display: "flex", gap: 6 }}>
                <div
                  style={{ width: 12, height: 12, borderRadius: "50%", background: "#FF5F56" }}
                />
                <div
                  style={{ width: 12, height: 12, borderRadius: "50%", background: "#FFBD2E" }}
                />
                <div
                  style={{ width: 12, height: 12, borderRadius: "50%", background: "#27C93F" }}
                />
              </div>
              <div
                style={{
                  marginLeft: 14,
                  background: PALETTE.white,
                  borderRadius: "6px 6px 0 0",
                  padding: "6px 14px",
                  fontSize: 12,
                  color: PALETTE.ink,
                  fontFamily: FONT_MONO,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  border: `1px solid ${PALETTE.mist}`,
                  borderBottom: "1px solid transparent",
                  marginBottom: -1,
                }}
              >
                <Lock size={11} strokeWidth={2.5} color="#22c55e" />
                flarebit.ai/nuevo
              </div>
            </div>
            {/* URL / address bar */}
            <div
              style={{
                background: PALETTE.white,
                padding: "8px 14px",
                borderTop: `1px solid ${PALETTE.mist}`,
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <div
                style={{
                  flex: 1,
                  background: "#f1f5f9",
                  borderRadius: 6,
                  padding: "7px 12px",
                  fontSize: 13,
                  color: PALETTE.slate,
                  fontFamily: FONT_MONO,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <Lock size={12} strokeWidth={2.5} color="#22c55e" />
                https://flarebit.ai/nuevo
              </div>
            </div>
          </div>

          {/* Input panel — "Pega tu URL" */}
          <div
            style={{
              background: PALETTE.white,
              border: `1px solid ${PALETTE.mist}`,
              borderTop: "none",
              borderRadius: "0 0 12px 12px",
              padding: 24,
              boxShadow: "0 20px 60px rgba(0,0,0,0.06)",
              boxSizing: "border-box",
            }}
          >
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: PALETTE.ink,
                marginBottom: 12,
                fontFamily: FONT_BODY,
                letterSpacing: "0.01em",
              }}
            >
              Pega tu URL
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "stretch" }}>
              <div
                style={{
                  flex: 1,
                  background: "#f8fafc",
                  border: `1px solid ${PALETTE.mist}`,
                  borderRadius: 8,
                  padding: "12px 14px",
                  fontSize: 15,
                  color: PALETTE.ink,
                  fontFamily: FONT_MONO,
                  display: "flex",
                  alignItems: "center",
                  boxSizing: "border-box",
                }}
              >
                https://tuempresa.com
                <span
                  style={{
                    width: 2,
                    height: 18,
                    background: PALETTE.signature,
                    marginLeft: 2,
                    animation: "caretBlink 1s step-end infinite",
                    display: "inline-block",
                  }}
                />
              </div>
              <button
                style={{
                  background: PALETTE.signature,
                  color: PALETTE.white,
                  border: "none",
                  borderRadius: 8,
                  padding: "0 22px",
                  fontSize: 15,
                  fontWeight: 600,
                  fontFamily: FONT_BODY,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                Generar deck
                <ArrowRight size={16} strokeWidth={2.25} color={PALETTE.white} />
              </button>
            </div>
          </div>
        </div>
      