
        <div
          style={{
            position: "absolute",
            left: 80,
            top: 88,
            width: 760,
            display: "flex",
            flexDirection: "column",
            gap: 22,
          }}
        >
          {/* Eyebrow */}
          <div
            data-content-path="eyebrow"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 10,
              fontFamily: FONT_BODY,
              fontSize: 14,
              fontWeight: 600,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              color: PALETTE.signature,
            }}
          >
            <span style={{ width: 28, height: 1, background: PALETTE.signature, opacity: 0.55 }} />
            {c.eyebrow}
          </div>

          {/* Headline */}
          <h1
            data-content-path="headline"
            style={{
              fontFamily: FONT_DISPLAY,
              fontWeight: 700,
              fontSize: 60,
              lineHeight: 1.02,
              letterSpacing: "-0.03em",
              color: PALETTE.ink,
              margin: 0,
            }}
          >
            <span style={{ color: PALETTE.signature }}>{c.headline}</span>
          </h1>

          {/* Lede */}
          <p
            data-content-path="lede"
            style={{
              fontFamily: FONT_BODY,
              fontSize: 24,
              lineHeight: 1.45,
              color: PALETTE.ink,
              opacity: 0.72,
              margin: 0,
              maxWidth: 700,
            }}
          >
            {c.lede}
          </p>
        </div>

        {/* Bullets — lower-left */}
        {c.bullets?.length ? (
          <ul
            style={{
              position: "absolute",
              left: 80,
              top: 530,
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "flex",
              flexDirection: "column",
              gap: 14,
              width: 720,
            }}
          >
            {c.bullets.map((b, i) => (
              <li
                key={i}
                data-content-path={`bullets.${i}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  fontFamily: FONT_BODY,
                  fontSize: 18,
                  lineHeight: 1.35,
                  color: PALETTE.ink,
                  opacity: 0.85,
                }}
              >
                <Check size={18} strokeWidth={2.25} color={PALETTE.signature} />
                <span>{b}</span>
              </li>
            ))}
          </ul>
        ) : null}

        {/* Caption */}
        {c.caption && (
          <div
            data-content-path="caption"
            style={{
              position: "absolute",
              left: 80,
              top: 942,
              fontFamily: FONT_MONO,
              fontSize: 14,
              letterSpacing: "0.06em",
              color: PALETTE.slate,
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: PALETTE.signature,
              }}
            />
            {c.caption}
          </div>
        )}
      