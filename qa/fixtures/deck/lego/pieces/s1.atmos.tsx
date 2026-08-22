
        <div
          style={{
            position: "absolute",
            right: -180,
            top: 120,
            width: 720,
            height: 720,
            borderRadius: "50%",
            background: `radial-gradient(circle, ${PALETTE.cyan}20 0%, transparent 62%)`,
            filter: "blur(40px)",
            animation: "glowBreathe 5s ease-in-out infinite",
            pointerEvents: "none",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: -200,
            bottom: -160,
            width: 600,
            height: 600,
            borderRadius: "50%",
            background: `radial-gradient(circle, ${PALETTE.signature}10 0%, transparent 60%)`,
            filter: "blur(40px)",
            animation: "glowBreathe 7s ease-in-out infinite",
            animationDelay: "1.5s",
            pointerEvents: "none",
          }}
        />
        <DotGrid opacity={0.08} />
        <DriftEmbers color={PALETTE.signature} />
        <GrainOverlay opacity={0.03} />
      