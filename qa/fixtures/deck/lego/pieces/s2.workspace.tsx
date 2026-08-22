
        {/* Toolbar */}
        <div style={{
          position: "absolute", left: 0, top: 0, width: "100%", height: 52,
          background: PALETTE.white, borderBottom: `1px solid ${PALETTE.mist}`,
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "0 24px", boxSizing: "border-box",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {toolbarIcons.map((ic, i) => (
              <div key={i} style={{
                width: 36, height: 36, borderRadius: 7, display: "flex",
                alignItems: "center", justifyContent: "center", color: PALETTE.slate,
                background: i === 1 ? "rgba(0,120,168,0.08)" : "transparent",
                cursor: "default",
              }}>
                <svg viewBox="0 0 20 20" width={18} height={18} dangerouslySetInnerHTML={{ __html: ic.svg }} />
              </div>
            ))}
          </div>
          <div style={{
            display: "flex", alignItems: "center", gap: 8, padding: "5px 14px",
            borderRadius: 20, background: "rgba(112,221,240,0.12)",
            border: `1px solid ${PALETTE.cyan}40`,
            fontFamily: FONT_BODY, fontSize: 13, fontWeight: 600, color: "#0891b2",
            letterSpacing: "0.04em",
          }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: PALETTE.cyan, animation: "s2EditPulse 1.6s ease-in-out infinite" }} />
            Editando
          </div>
        </div>

        {/* Left sidebar — layers */}
        <div style={{
          position: "absolute", left: 0, top: 52, width: 240, height: "calc(100% - 52px)",
          background: "#fafbfc", borderRight: `1px solid ${PALETTE.mist}`,
          padding: "20px 16px", boxSizing: "border-box", display: "flex", flexDirection: "column", gap: 16,
        }}>
          <div style={{
            fontFamily: FONT_BODY, fontSize: 11, fontWeight: 700, letterSpacing: "0.16em",
            textTransform: "uppercase", color: PALETTE.steel,
          }}>Capas</div>
          {layers.map((layer, i) => (
            <div key={i} style={{
              display: "flex", alignItems: "center", gap: 12, padding: "8px 10px",
              borderRadius: 8, background: i === 2 ? "rgba(0,120,168,0.06)" : "transparent",
              border: i === 2 ? `1px solid ${PALETTE.signature}25` : `1px solid transparent`,
            }}>
              <div style={{
                width: 40, height: 28, borderRadius: 4, background: layer.swatchBg,
                border: `1px solid ${PALETTE.mist}`, flexShrink: 0,
              }} />
              <span style={{
                fontFamily: FONT_BODY, fontSize: 14, fontWeight: 500,
                color: i === 2 ? PALETTE.signature : PALETTE.ink,
              }}>{layer.label}</span>
            </div>
          ))}
          <div style={{
            marginTop: 8, paddingTop: 16, borderTop: `1px solid ${PALETTE.mist}`,
            fontFamily: FONT_MONO, fontSize: 11, color: PALETTE.steel, lineHeight: 1.6,
          }}>
            <div>Artboard 1080p</div>
            <div>Zoom 75%</div>
          </div>
        </div>

        {/* Canvas artboard */}
        <div style={{
          position: "absolute", left: 280, top: 78, width: 1352, height: 620,
          borderRadius: 10, background: PALETTE.white,
          border: `1px solid ${PALETTE.mist}`,
          boxShadow: "0 2px 12px rgba(0,0,0,0.04)",
          boxSizing: "border-box",
        }}>
          {/* Slide content being designed */}
          <div style={{ position: "absolute", left: 36, top: 36 }}>
            <div style={{
              fontFamily: FONT_DISPLAY, fontSize: 34, fontWeight: 700,
              color: PALETTE.ink, letterSpacing: "-0.02em",
            }}>Crecimiento trimestral</div>
            <div style={{ width: 88, height: 5, background: PALETTE.signature, borderRadius: 3, marginTop: 14 }} />
            <div style={{ marginTop: 22, display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ fontFamily: FONT_BODY, fontSize: 18, color: PALETTE.slate }}>
                Texto descriptivo del período
              </div>
              <div style={{ fontFamily: FONT_BODY, fontSize: 18, color: PALETTE.slate }}>
                Información complementaria
              </div>
            </div>
          </div>
        </div>

        {/* Throughline — selection box with bar chart */}
        <Piece id="s2.throughline" kind="diegetic" throughline={THROUGHLINE_SLUG}>
          <ThroughlineRect width={440} height={340} animate="breathe" style={{ zIndex: 5 }}>
            {/* Dashed selection border */}
            <div style={{
              position: "absolute", inset: 0, borderRadius: 4,
              border: `2px dashed ${PALETTE.signature}`,
            }} />
            {/* Corner handles */}
            {[
              { left: -6, top: -6 }, { right: -6, top: -6 },
              { left: -6, bottom: -6 }, { right: -6, bottom: -6 },
            ].map((pos, i) => (
              <div key={i} style={{
                position: "absolute", width: 12, height: 12, borderRadius: 2,
                background: PALETTE.white, border: `2px solid ${PALETTE.signature}`,
                ...pos,
              }} />
            ))}
            {/* Bar chart inside selection */}
            <div style={{
              position: "absolute", left: 24, right: 24, top: 36, bottom: 48,
              display: "flex", alignItems: "flex-end", justifyContent: "center", gap: 28,
            }}>
              {bars.map((bar, i) => (
                <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                  <div style={{
                    width: 54, height: bar.h, borderRadius: "4px 4px 0 0",
                    background: bar.color,
                    transformOrigin: "bottom", animation: `barRise 0.5s ease-out ${i * 0.1}s both`,
                  }} />
                  <span style={{
                    fontFamily: FONT_MONO, fontSize: 13, fontWeight: 500, color: PALETTE.slate,
                  }}>{bar.label}</span>
                </div>
              ))}
            </div>
          </ThroughlineRect>
        </Piece>

        {/* Floating prompt field */}
        <div style={{
          position: "absolute", left: 920, top: 742, width: 560,
          padding: "14px 20px", borderRadius: 14, background: PALETTE.white,
          border: `1.5px solid ${PALETTE.signature}`,
          boxShadow: "0 8px 32px rgba(0,120,168,0.15)",
          animation: "s2PromptGlow 3s ease-in-out infinite",
          display: "flex", alignItems: "center", gap: 12, zIndex: 6,
        }}>
          <div style={{
            width: 28, height: 28, borderRadius: 7, background: `linear-gradient(135deg, ${PALETTE.signature}, ${PALETTE.sky})`,
            display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
          }}>
            <svg viewBox="0 0 16 16" width={16} height={16}>
              <path d="M8 2v8M4.5 6.5L8 10l3.5-3.5M3 13h10" fill="none" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div style={{
            fontFamily: FONT_BODY, fontSize: 16, color: PALETTE.ink, fontWeight: 400,
            display: "flex", alignItems: "center", whiteSpace: "nowrap", overflow: "hidden",
          }}>
            <span>Añade un gráfico de barras con los últimos cuatro trimestres.</span>
            <span style={{
              display: "inline-block", width: 2, height: 18, background: PALETTE.signature,
              marginLeft: 3, animation: "caretBlink 1s step-end infinite", flexShrink: 0,
            }} />
          </div>
        </div>

        {/* Shimmer sweep on artboard */}
        <div style={{
          position: "absolute", left: 280, top: 78, width: 1352, height: 620,
          borderRadius: 10, overflow: "hidden", pointerEvents: "none", zIndex: 1,
        }}>
          <div style={{
            position: "absolute", top: 0, bottom: 0, width: "20%",
            background: "linear-gradient(90deg, transparent, rgba(0,120,168,0.04), transparent)",
            animation: "s2Shimmer 8s ease-in-out infinite",
          }} />
        </div>
      