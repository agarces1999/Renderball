
        <div style={{ position: "absolute", inset: 0, background: "radial-gradient(ellipse 60% 50% at 72% 48%, rgba(0,120,168,0.045) 0%, transparent 70%)" }} />
        <DotGrid opacity={0.05} gap={32} size={1.5} />
        {[
          { x: 12, y: 18, s: 5, d: "drift1 9s ease-in-out infinite" },
          { x: 88, y: 30, s: 4, d: "drift2 11s ease-in-out infinite" },
          { x: 8, y: 82, s: 6, d: "drift3 13s ease-in-out infinite" },
        ].map((e, i) => (
          <div key={i} style={{
            position: "absolute", left: `${e.x}%`, top: `${e.y}%`,
            width: e.s, height: e.s, borderRadius: "50%",
            background: PALETTE.signature, opacity: 0.12,
            boxShadow: `0 0 18px ${PALETTE.signature}`, animation: e.d, pointerEvents: "none",
          }} />
        ))}
        <div style={{
          position: "absolute", left: 1140, top: 370, width: 440, height: 340, borderRadius: 6,
          background: "radial-gradient(circle at 50% 60%, rgba(0,120,168,0.06) 0%, transparent 70%)",
          animation: "s2ChartGlow 4s ease-in-out infinite", pointerEvents: "none",
        }} />
      