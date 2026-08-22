
        <DotGrid opacity={0.07} gap={32} />
        <div
          style={{
            position: "absolute",
            left: "72%",
            top: "28%",
            width: 640,
            height: 640,
            marginLeft: -320,
            marginTop: -320,
            borderRadius: "50%",
            background: `radial-gradient(circle, ${PALETTE.signature}18 0%, transparent 62%)`,
            filter: "blur(40px)",
            animation: "glowBreathe 6s ease-in-out infinite",
            pointerEvents: "none",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: "22%",
            top: "78%",
            width: 520,
            height: 520,
            marginLeft: -260,
            marginTop: -260,
            borderRadius: "50%",
            background: `radial-gradient(circle, ${PALETTE.cyan}12 0%, transparent 62%)`,
            filter: "blur(40px)",
            animation: "glowBreathe 8s ease-in-out infinite reverse",
            pointerEvents: "none",
          }}
        />
        <DriftEmbers color={PALETTE.signature} />
        <GrainOverlay opacity={0.025} />
      