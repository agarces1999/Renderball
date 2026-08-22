
        <ThroughlineRect
          width={660}
          height={820}
          animate="breathe"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 18,
            alignItems: "center",
            justifyContent: "flex-start",
          }}
        >
          {/* Thumbnail 1 — fully rendered */}
          <Piece id="s1.thumbnails.0" kind="card">
            <ThumbFull />
          </Piece>

          {/* Thumbnail 2 — partially filled */}
          <Piece id="s1.thumbnails.1" kind="card">
            <ThumbPartial />
          </Piece>

          {/* Progress ring — between middle and bottom */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: "-2px 0",
            }}
          >
            <svg width={44} height={44} viewBox="0 0 44 44">
              <circle
                cx="22"
                cy="22"
                r="17"
                fill="none"
                stroke={PALETTE.mist}
                strokeWidth="3"
              />
              <circle
                cx="22"
                cy="22"
                r="17"
                fill="none"
                stroke={PALETTE.cyan}
                strokeWidth="3"
                strokeLinecap="round"
                strokeDasharray={`${Math.PI * 17 * 2}`}
                strokeDashoffset={`${Math.PI * 17 * 2 * 0.5}`}
                transform="rotate(-90 22 22)"
              />
              <circle cx="22" cy="22" r="3" fill={PALETTE.cyan} style={{ animation: "dotPulse 2.4s ease-in-out infinite" }} />
            </svg>
          </div>

          {/* Thumbnail 3 — outline only */}
          <Piece id="s1.thumbnails.2" kind="card">
            <ThumbOutline />
          </Piece>
        </ThroughlineRect>
      