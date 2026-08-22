
        {/* Soft glow behind the CTA cluster */}
        <div style={{ position: "absolute", left: 1360, top: 540, width: 640, height: 420, marginLeft: -320, marginTop: -210, borderRadius: "50%", background: `radial-gradient(circle at 50% 50%, ${PALETTE.signature}20 0%, transparent 65%)`, filter: "blur(40px)", animation: "s4GlowPulse 4s ease-in-out infinite", pointerEvents: "none" }} />
        {/* Two cyan accent dots at 25% opacity */}
        <div style={{ position: "absolute", left: "18%", top: "30%", width: 12, height: 12, borderRadius: "50%", background: PALETTE.cyan, opacity: 0.25, boxShadow: `0 0 24px ${PALETTE.cyan}55`, animation: "drift1 9s ease-in-out infinite", pointerEvents: "none" }} />
        <div style={{ position: "absolute", left: "82%", top: "68%", width: 10, height: 10, borderRadius: "50%", background: PALETTE.cyan, opacity: 0.25, boxShadow: `0 0 20px ${PALETTE.cyan}55`, animation: "drift2 11s ease-in-out infinite", pointerEvents: "none" }} />
        {/* Subtle dot grid */}
        <DotGrid opacity={0.05} size={1.5} gap={36} />
        {/* Grain */}
        <GrainOverlay opacity={0.035} />
        {/* Bottom-edge hairline */}
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 1, background: PALETTE.mist }} />
        {/* Faint vertical guide lines */}
        <div style={{ position: "absolute", left: 120, top: 120, bottom: 120, width: 1, background: PALETTE.mist, opacity: 0.4 }} />
        <div style={{ position: "absolute", right: 120, top: 120, bottom: 120, width: 1, background: PALETTE.mist, opacity: 0.4 }} />
      