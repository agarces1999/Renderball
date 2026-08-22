
        <div
          style={{
            position: "absolute",
            top: 14,
            left: "50%",
            transform: "translateX(-50%)",
            display: "flex",
            alignItems: "center",
            gap: 4,
            background: PALETTE.mist,
            borderRadius: 10,
            padding: "6px 8px",
            boxShadow: "0 2px 14px rgba(26,35,50,0.07)",
          }}
        >
          {toolbarD.map((d, i) => (
            <div
              key={i}
              style={{
                width: 36,
                height: 36,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 7,
                background: i === 0 ? PALETTE.white : "transparent",
                border: i === 0 ? `1px solid ${PALETTE.mist}` : "1px solid transparent",
              }}
            >
              <ToolbarIcon d={d} />
            </div>
          ))}
          <div style={{ width: 1, height: 22, background: PALETTE.steel, opacity: 0.35, margin: "0 6px" }} />
          <div style={{ width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 7 }}>
            <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke={PALETTE.steel} strokeWidth={1.75} strokeLinecap="round">
              <circle cx="12" cy="12" r="8" />
              <path d="M12 8 V12 L15 14" />
            </svg>
          </div>
        </div>
      