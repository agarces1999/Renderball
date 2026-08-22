
        <DotGrid opacity={0.12} gap={28} />
        <div
          style={{
            position: "absolute",
            left: 1360,
            top: 540,
            transform: "translate(-50%,-50%)",
            width: 1100,
            height: 760,
            background:
              "radial-gradient(circle, rgba(0,120,168,0.05) 0%, rgba(0,120,168,0.02) 40%, transparent 70%)",
            animation: "glowBreathe 6s ease-in-out infinite",
            pointerEvents: "none",
          }}
        />
        <DriftEmbers color={PALETTE.signature} />
        <GrainOverlay opacity={0.035} />
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "repeating-linear-gradient(90deg, transparent 0px, transparent 120px, rgba(0,120,168,0.025) 120px, rgba(0,120,168,0.025) 121px)",
            pointerEvents: "none",
          }}
        />
      