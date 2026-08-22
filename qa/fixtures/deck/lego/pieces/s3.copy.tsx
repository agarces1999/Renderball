
        <div
          style={{
            position: "absolute",
            left: 80,
            top: 128,
            width: 640,
            display: "flex",
            flexDirection: "column",
            gap: 26,
          }}
        >
          {/* Eyebrow */}
          <div
            data-content-path="eyebrow"
            style={{
              fontFamily: FONT_BODY,
              fontSize: 15,
              fontWeight: 600,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              color: PALETTE.signature,
              display: "inline-flex",
              alignItems: "center",
              gap: 12,
            }}
          >
            <span style={{ width: 32, height: 2, background: PALETTE.signature, opacity: 0.7 }} />
            {c.eyebrow}
          </div>

          {/* Headline */}
          <h1
            data-content-path="headline"
            style={{
              fontFamily: FONT_DISPLAY,
              fontWeight: 800,
              fontSize: 72,
              lineHeight: 1.0,
              letterSpacing: "-0.035em",
              color: PALETTE.ink,
              margin: 0,
              maxWidth: 620,
            }}
          >
            {c.headline}
          </h1>

          {/* Accent bar under headline */}
          <div style={{ width: 120, height: 4, background: PALETTE.signature, borderRadius: 2 }} />

          {/* Lede */}
          <p
            data-content-path="lede"
            style={{
              fontFamily: FONT_BODY,
              fontSize: 24,
              lineHeight: 1.5,
              color: PALETTE.ink,
              opacity: 0.78,
              margin: 0,
              maxWidth: 580,
            }}
          >
            {c.lede}
          </p>

          {/* Bullets */}
          {c.bullets?.length ? (
            <ul
              style={{
                listStyle: "none",
                margin: "20px 0 0 0",
                padding: 0,
                display: "flex",
                flexDirection: "column",
                gap: 16,
              }}
            >
              {c.bullets.map((b, i) => (
                <li
                  key={i}
                  data-content-path={`bullets.${i}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 14,
                    fontFamily: FONT_BODY,
                    fontSize: 20,
                    lineHeight: 1.35,
                    color: PALETTE.ink,
                    opacity: 0.9,
                  }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: PALETTE.signature,
                      flexShrink: 0,
                    }}
                  />
                  <span>{b}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      