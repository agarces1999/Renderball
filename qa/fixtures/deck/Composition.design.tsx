import React from "react";
import { Img } from "./Img";
import { Piece } from "./Piece";
import { BrandChrome } from "./BrandChrome";
import { Check, Lock, ArrowRight } from "lucide-react";

interface Script {
  scenes: Array<{
    content: {
      eyebrow?: string;
      headline?: string;
      lede?: string;
      bullets?: string[];
      caption?: string;
      meta?: Array<{ label: string; value: string }>;
      cta?: { primary?: string; secondary?: string };
      illustration?: string;
      asset_ids?: string[];
    };
    register?: string;
    visual_concept?: string;
  }>;
  assets: { images: string[]; fonts: string[] };
  config: Record<string, unknown>;
}

// ─── Palette (crawled — used verbatim, no invented hex) ───────────────────
const PALETTE = {
  white: "#ffffff",
  ink: "#1a2332",
  navy: "#21296a",
  signature: "#0078a8",
  sky: "#3388ff",
  cyan: "#70ddf0",
  slate: "#64748b",
  mist: "#e2e8f0",
  steel: "#94a3b8",
} as const;

const BRAND_LIGHT = PALETTE.white;
const BRAND_INK = PALETTE.ink;
const BRAND_ACCENT = PALETTE.signature;
const BRAND_ACCENT_SOFT = PALETTE.cyan;

// ─── Fonts (LOCKED — verbatim) ────────────────────────────────────────────
const FONT_DISPLAY = '"Inter", undefined';
const FONT_BODY = '"Inter", undefined';
const FONT_MONO = '"JetBrains Mono", "SFMono-Regular", Consolas, monospace';

const BRAND_FONTS_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap');
`;

// ─── Section frame ────────────────────────────────────────────────────────
const SECTION_FRAME: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  overflow: "hidden",
  boxSizing: "border-box",
  background: PALETTE.white,
};

// ─── Shared @keyframes ────────────────────────────────────────────────────
const SHARED_KEYFRAMES = `
@keyframes recuadroBreathe {
  0%, 100% { opacity: 0.92; transform: translate(-50%, -50%) scale(1); }
  50%      { opacity: 1;    transform: translate(-50%, -50%) scale(1.012); }
}
@keyframes recuadroDraw {
  0%   { stroke-dashoffset: 720; }
  100% { stroke-dashoffset: 0; }
}
@keyframes recuadroCornerPulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(0,120,168,0.0); }
  50%      { box-shadow: 0 0 0 4px rgba(0,120,168,0.18); }
}
@keyframes glowBreathe {
  0%, 100% { opacity: 0.18; }
  50%      { opacity: 0.34; }
}
@keyframes drift1 {
  0%, 100% { transform: translate(0, 0); }
  50%      { transform: translate(18px, -14px); }
}
@keyframes drift2 {
  0%, 100% { transform: translate(0, 0); }
  50%      { transform: translate(-22px, 16px); }
}
@keyframes drift3 {
  0%, 100% { transform: translate(0, 0); }
  50%      { transform: translate(12px, 22px); }
}
@keyframes sweep {
  0%   { transform: translateX(-30%); opacity: 0; }
  40%  { opacity: 0.5; }
  100% { transform: translateX(130%); opacity: 0; }
}
@keyframes breathe {
  0%, 100% { transform: scale(1); }
  50%      { transform: scale(1.015); }
}
@keyframes caretBlink {
  0%, 49%  { opacity: 1; }
  50%, 100%{ opacity: 0; }
}
@keyframes ringSpin {
  0%   { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}
@keyframes dotPulse {
  0%, 100% { opacity: 0.25; transform: scale(1); }
  50%      { opacity: 0.55; transform: scale(1.4); }
}
@keyframes barRise {
  0%   { transform: scaleY(0); }
  100% { transform: scaleY(1); }
}
@keyframes fadeRise {
  0%   { opacity: 0; transform: translateY(14px); }
  100% { opacity: 1; transform: translateY(0); }
}
`;

// ─── Throughline motif anchor ─────────────────────────────────────────────
const THROUGHLINE_SLUG = "el-recuadro-un-marco-de-diapositiva-vac-o-en-la-";
const THROUGHLINE_ANCHOR: React.CSSProperties = {
  position: "absolute",
  left: 1360,
  top: 540,
  transform: "translate(-50%, -50%)",
};

const ThroughlineRect: React.FC<{
  width: number;
  height: number;
  style?: React.CSSProperties;
  children?: React.ReactNode;
  animate?: "breathe" | "cornerPulse" | "none";
}> = ({ width, height, style, children, animate = "breathe" }) => (
  <div
    data-throughline={THROUGHLINE_SLUG}
    style={{
      ...THROUGHLINE_ANCHOR,
      width,
      height,
      boxSizing: "border-box",
      animation:
        animate === "breathe"
          ? "recuadroBreathe 5s ease-in-out infinite"
          : animate === "cornerPulse"
            ? "recuadroCornerPulse 3.2s ease-in-out infinite"
            : undefined,
      ...style,
    }}
  >
    {children}
  </div>
);

// ─── Recurring atmospheric helpers ────────────────────────────────────────
const DotGrid: React.FC<{ opacity?: number; size?: number; gap?: number }> = ({
  opacity = 0.12,
  size = 2,
  gap = 28,
}) => (
  <div
    style={{
      position: "absolute",
      inset: 0,
      pointerEvents: "none",
      opacity,
      backgroundImage: `radial-gradient(${PALETTE.mist} ${size}px, transparent ${size + 1}px)`,
      backgroundSize: `${gap}px ${gap}px`,
    }}
  />
);

const GrainOverlay: React.FC<{ opacity?: number }> = ({ opacity = 0.05 }) => (
  <div
    style={{
      position: "absolute",
      inset: 0,
      pointerEvents: "none",
      opacity,
      backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' seed='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
    }}
  />
);

const DriftEmbers: React.FC<{ color?: string }> = ({
  color = PALETTE.signature,
}) => {
  const embers = [
    { x: 18, y: 22, s: 6, d: "drift1 9s ease-in-out infinite" },
    { x: 72, y: 38, s: 4, d: "drift2 11s ease-in-out infinite" },
    { x: 36, y: 78, s: 5, d: "drift3 13s ease-in-out infinite" },
    { x: 84, y: 70, s: 3, d: "drift1 10s ease-in-out infinite" },
  ];
  return (
    <>
      {embers.map((e, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            left: `${e.x}%`,
            top: `${e.y}%`,
            width: e.s,
            height: e.s,
            borderRadius: "50%",
            background: color,
            boxShadow: `0 0 18px ${color}, 0 0 36px ${color}66`,
            opacity: 0.45,
            animation: e.d,
            pointerEvents: "none",
          }}
        />
      ))}
    </>
  );
};

// ─── Brand chrome wrapper (configured once, used in every scene) ───────────
const Chrome: React.FC<{
  sceneIndex: number;
  totalScenes: number;
  category?: string;
  showCornerLogo?: boolean;
  onBrandColorBg?: boolean;
}> = (p) => (
  <BrandChrome
    {...p}
    variant="corner"
    wordmark="Flarebit"
    ink={BRAND_INK}
    accent={BRAND_ACCENT}
    fontDisplay={FONT_DISPLAY}
    fontBody={FONT_BODY}
  />
);

const TOTAL_SCENES = 5;

// ═══════════════════════════════════════════════════════════════════════════
// Section 0 — "Lienzo vacío"
// ═══════════════════════════════════════════════════════════════════════════

export const Section0: React.FC<{ script: Script }> = ({ script }) => {
  const c = script.scenes[0].content;

  const ToolbarIcon: React.FC<{ d: string }> = ({ d }) => (
    <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke={PALETTE.slate} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: d }} />
  );
  const toolbarD = [
    '<path d="M5 3 L5 18 L9 14 L12 21 L14 20 L11 13 L17 13 Z" fill="' + PALETTE.slate + '"/>',
    '<rect x="4" y="6" width="16" height="12" rx="1.5"/>',
    '<path d="M5 5 H19 M12 5 V19 M9 19 H15"/>',
    '<rect x="4" y="5" width="16" height="14" rx="1.5"/><circle cx="9" cy="10" r="1.6" fill="' + PALETTE.slate + '"/><path d="M5 17 L10 12 L14 16 L17 13 L19 15"/>',
    '<circle cx="8" cy="9" r="3.2"/><rect x="13" y="6" width="6" height="6" rx="1"/><path d="M8 14 L12 20 L4 20 Z"/>',
  ];

  return (
    <div style={{ ...SECTION_FRAME, background: PALETTE.white, fontFamily: FONT_BODY, color: BRAND_INK }}>
      <style dangerouslySetInnerHTML={{ __html: BRAND_FONTS_CSS }} />

      {/* Atmosphere */}
      <Piece id="s0.atmos" kind="atmosphere">
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
      </Piece>

      {/* Design-tool toolbar (floating, top center) */}
      <Piece id="s0.toolbar" kind="diegetic">
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
      </Piece>

      {/* Throughline — empty slide frame */}
      <Piece id="s0.throughline" kind="diegetic" throughline={THROUGHLINE_SLUG}>
        <ThroughlineRect width={760} height={480} animate="breathe">
          {/* Slide tab */}
          <div
            style={{
              position: "absolute",
              left: 0,
              top: -30,
              background: PALETTE.white,
              border: `1px solid ${PALETTE.slate}`,
              borderBottom: "none",
              borderRadius: "6px 6px 0 0",
              padding: "5px 14px",
              fontFamily: FONT_MONO,
              fontSize: 13,
              color: PALETTE.slate,
              letterSpacing: "0.04em",
              whiteSpace: "nowrap",
            }}
          >
            Diapositiva 1 de ?
          </div>
          {/* Frame body */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              border: `1px solid ${PALETTE.slate}`,
              background: PALETTE.white,
              borderRadius: 2,
            }}
          />
          {/* Signature corner brackets */}
          <div
            style={{
              position: "absolute",
              left: -1,
              top: -1,
              width: 24,
              height: 24,
              borderTop: `2px solid ${PALETTE.signature}`,
              borderLeft: `2px solid ${PALETTE.signature}`,
            }}
          />
          <div
            style={{
              position: "absolute",
              right: -1,
              bottom: -1,
              width: 24,
              height: 24,
              borderBottom: `2px solid ${PALETTE.signature}`,
              borderRight: `2px solid ${PALETTE.signature}`,
            }}
          />
          {/* Blinking caret */}
          <div
            style={{
              position: "absolute",
              left: 64,
              top: "50%",
              transform: "translateY(-50%)",
              width: 2,
              height: 58,
              background: PALETTE.signature,
              animation: "caretBlink 1.1s steps(1) infinite",
              borderRadius: 1,
            }}
          />
          {/* Timestamp */}
          <div
            style={{
              position: "absolute",
              right: 18,
              bottom: 14,
              fontFamily: FONT_MONO,
              fontSize: 15,
              color: PALETTE.steel,
              letterSpacing: "0.1em",
            }}
          >
            23:47
          </div>
          <div
            style={{
              position: "absolute",
              inset: 0,
              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.9), inset 0 -1px 0 rgba(100,116,139,0.08)",
              pointerEvents: "none",
              borderRadius: 2,
            }}
          />
        </ThroughlineRect>
      </Piece>

      {/* Editorial copy stack */}
      <Piece id="s0.copy" kind="text">
        <div
          style={{
            position: "absolute",
            left: 80,
            top: 150,
            width: 840,
            display: "flex",
            flexDirection: "column",
            gap: 28,
          }}
        >
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 12,
              fontFamily: FONT_BODY,
              fontSize: 15,
              fontWeight: 600,
              letterSpacing: "0.22em",
              textTransform: "uppercase",
              color: PALETTE.signature,
            }}
          >
            <span style={{ width: 30, height: 2, background: PALETTE.signature }} />
            <span data-content-path="eyebrow">{c.eyebrow}</span>
          </div>

          <h1
            data-content-path="headline"
            style={{
              fontFamily: FONT_DISPLAY,
              fontSize: 96,
              fontWeight: 700,
              lineHeight: 1.0,
              letterSpacing: "-0.025em",
              color: PALETTE.ink,
              margin: 0,
              maxWidth: 820,
            }}
          >
            {c.headline}
          </h1>

          <div style={{ width: 64, height: 4, background: PALETTE.signature, borderRadius: 2 }} />

          <p
            data-content-path="lede"
            style={{
              fontFamily: FONT_BODY,
              fontSize: 26,
              lineHeight: 1.4,
              color: PALETTE.ink,
              opacity: 0.82,
              margin: 0,
              maxWidth: 720,
            }}
          >
            {c.lede}
          </p>
        </div>

        {/* Lower-third caption */}
        <div
          style={{
            position: "absolute",
            left: 80,
            top: 750,
            width: 840,
            display: "flex",
            flexDirection: "column",
            gap: 16,
          }}
        >
          <div
            data-content-path="caption"
            style={{
              fontFamily: FONT_MONO,
              fontSize: 20,
              color: PALETTE.steel,
              letterSpacing: "0.06em",
            }}
          >
            {c.caption}
          </div>
        </div>

        {/* Footer meta row */}
        <div
          style={{
            position: "absolute",
            left: 80,
            right: 80,
            bottom: 64,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            borderTop: `1px solid ${PALETTE.mist}`,
            paddingTop: 18,
          }}
        >
          <span
            style={{
              fontFamily: FONT_MONO,
              fontSize: 14,
              letterSpacing: "0.2em",
              textTransform: "uppercase",
              color: PALETTE.signature,
              fontWeight: 500,
            }}
          >
            01 / 05
          </span>
          <span
            style={{
              fontFamily: FONT_MONO,
              fontSize: 14,
              letterSpacing: "0.2em",
              textTransform: "uppercase",
              color: PALETTE.steel,
            }}
          >
            Lienzo vacío
          </span>
        </div>
      </Piece>

      {/* Brand chrome */}
      <Piece id="s0.chrome" kind="chrome">
        <Chrome sceneIndex={0} totalScenes={TOTAL_SCENES} category="Flarebit Studio" />
      </Piece>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════════
// Section 1 — "Pega tu enlace"
// ═══════════════════════════════════════════════════════════════════════════

export const Section1: React.FC<{ script: Script }> = ({ script }) => {
  const c = script.scenes[1].content;

  const ThumbFull: React.FC = () => (
    <div
      style={{
        width: 620,
        height: 230,
        background: PALETTE.white,
        border: `1px solid ${PALETTE.mist}`,
        borderRadius: 12,
        boxShadow: "0 16px 48px rgba(0,0,0,0.08)",
        padding: 28,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 14,
        boxSizing: "border-box",
      }}
    >
      <div style={{ width: 52, height: 4, background: PALETTE.signature, borderRadius: 2 }} />
      <div
        style={{
          fontFamily: FONT_DISPLAY,
          fontWeight: 700,
          fontSize: 34,
          color: PALETTE.ink,
          lineHeight: 1.08,
          letterSpacing: "-0.02em",
        }}
      >
        Tu Empresa
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ width: "82%", height: 6, borderRadius: 3, background: PALETTE.mist }} />
        <div style={{ width: "58%", height: 6, borderRadius: 3, background: PALETTE.mist, opacity: 0.6 }} />
      </div>
    </div>
  );

  const ThumbPartial: React.FC = () => (
    <div
      style={{
        width: 620,
        height: 230,
        background: `${PALETTE.white}80`,
        border: `1px solid ${PALETTE.mist}`,
        borderRadius: 12,
        padding: 28,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 14,
        opacity: 0.72,
        boxSizing: "border-box",
      }}
    >
      <div style={{ width: 36, height: 4, background: PALETTE.mist, borderRadius: 2 }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ width: "70%", height: 8, borderRadius: 4, background: PALETTE.slate, opacity: 0.4 }} />
        <div style={{ width: "48%", height: 6, borderRadius: 3, background: PALETTE.slate, opacity: 0.32 }} />
        <div style={{ width: "62%", height: 6, borderRadius: 3, background: PALETTE.slate, opacity: 0.25 }} />
      </div>
    </div>
  );

  const ThumbOutline: React.FC = () => (
    <div
      style={{
        width: 620,
        height: 230,
        border: `1px solid ${PALETTE.mist}`,
        borderRadius: 12,
        background: "transparent",
        opacity: 0.5,
      }}
    />
  );

  return (
    <div style={{ ...SECTION_FRAME, background: PALETTE.white, fontFamily: FONT_BODY }}>
      <style dangerouslySetInnerHTML={{ __html: SHARED_KEYFRAMES }} />

      {/* Atmosphere */}
      <Piece id="s1.atmos" kind="atmosphere">
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
      </Piece>

      {/* Vertical divider */}
      <div
        style={{
          position: "absolute",
          left: 878,
          top: 72,
          bottom: 72,
          width: 1,
          background: PALETTE.mist,
        }}
      />

      {/* Copy stack — LEFT */}
      <Piece id="s1.copy" kind="text">
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
      </Piece>

      {/* Browser mock + input panel — LEFT, lower */}
      <Piece id="s1.browser" kind="diegetic">
        <div
          style={{
            position: "absolute",
            left: 80,
            top: 660,
            width: 720,
            animation: "breathe 5s ease-in-out infinite",
          }}
        >
          {/* Browser chrome */}
          <div
            style={{
              background: "#f8fafc",
              borderRadius: "12px 12px 0 0",
              border: `1px solid ${PALETTE.mist}`,
              borderBottom: "none",
              overflow: "hidden",
            }}
          >
            {/* Tab bar */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "10px 14px 6px",
              }}
            >
              <div style={{ display: "flex", gap: 6 }}>
                <div
                  style={{ width: 12, height: 12, borderRadius: "50%", background: "#FF5F56" }}
                />
                <div
                  style={{ width: 12, height: 12, borderRadius: "50%", background: "#FFBD2E" }}
                />
                <div
                  style={{ width: 12, height: 12, borderRadius: "50%", background: "#27C93F" }}
                />
              </div>
              <div
                style={{
                  marginLeft: 14,
                  background: PALETTE.white,
                  borderRadius: "6px 6px 0 0",
                  padding: "6px 14px",
                  fontSize: 12,
                  color: PALETTE.ink,
                  fontFamily: FONT_MONO,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  border: `1px solid ${PALETTE.mist}`,
                  borderBottom: "1px solid transparent",
                  marginBottom: -1,
                }}
              >
                <Lock size={11} strokeWidth={2.5} color="#22c55e" />
                flarebit.ai/nuevo
              </div>
            </div>
            {/* URL / address bar */}
            <div
              style={{
                background: PALETTE.white,
                padding: "8px 14px",
                borderTop: `1px solid ${PALETTE.mist}`,
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <div
                style={{
                  flex: 1,
                  background: "#f1f5f9",
                  borderRadius: 6,
                  padding: "7px 12px",
                  fontSize: 13,
                  color: PALETTE.slate,
                  fontFamily: FONT_MONO,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <Lock size={12} strokeWidth={2.5} color="#22c55e" />
                https://flarebit.ai/nuevo
              </div>
            </div>
          </div>

          {/* Input panel — "Pega tu URL" */}
          <div
            style={{
              background: PALETTE.white,
              border: `1px solid ${PALETTE.mist}`,
              borderTop: "none",
              borderRadius: "0 0 12px 12px",
              padding: 24,
              boxShadow: "0 20px 60px rgba(0,0,0,0.06)",
              boxSizing: "border-box",
            }}
          >
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: PALETTE.ink,
                marginBottom: 12,
                fontFamily: FONT_BODY,
                letterSpacing: "0.01em",
              }}
            >
              Pega tu URL
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "stretch" }}>
              <div
                style={{
                  flex: 1,
                  background: "#f8fafc",
                  border: `1px solid ${PALETTE.mist}`,
                  borderRadius: 8,
                  padding: "12px 14px",
                  fontSize: 15,
                  color: PALETTE.ink,
                  fontFamily: FONT_MONO,
                  display: "flex",
                  alignItems: "center",
                  boxSizing: "border-box",
                }}
              >
                https://tuempresa.com
                <span
                  style={{
                    width: 2,
                    height: 18,
                    background: PALETTE.signature,
                    marginLeft: 2,
                    animation: "caretBlink 1s step-end infinite",
                    display: "inline-block",
                  }}
                />
              </div>
              <button
                style={{
                  background: PALETTE.signature,
                  color: PALETTE.white,
                  border: "none",
                  borderRadius: 8,
                  padding: "0 22px",
                  fontSize: 15,
                  fontWeight: 600,
                  fontFamily: FONT_BODY,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                Generar deck
                <ArrowRight size={16} strokeWidth={2.25} color={PALETTE.white} />
              </button>
            </div>
          </div>
        </div>
      </Piece>

      {/* Three thumbnails + progress ring — RIGHT, throughline-wrapped */}
      <Piece id="s1.thumbnails" kind="diegetic" throughline={THROUGHLINE_SLUG}>
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
      </Piece>

      {/* Brand chrome */}
      <Piece id="s1.chrome" kind="chrome">
        <Chrome sceneIndex={1} totalScenes={TOTAL_SCENES} category="Flarebit · AI Decks" />
      </Piece>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════════
// Section 2 — "Dibuja y describe"
// ═══════════════════════════════════════════════════════════════════════════

export const Section2: React.FC<{ script: Script }> = ({ script }) => {
  const c = script.scenes[2].content;

  const toolbarIcons = [
    { name: "cursor", svg: '<path d="M5 3l5.5 14.5-2.2-5.8 5.3-4.2z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>' },
    { name: "rectangle", svg: '<rect x="3" y="5" width="14" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/>' },
    { name: "text", svg: '<path d="M4 5h12M10 5v11M7 16h6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' },
    { name: "image", svg: '<rect x="3" y="4" width="14" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="7" cy="8" r="1.3" fill="currentColor"/><path d="M4 13l3.5-3 2.5 2.5L13 9l3 4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>' },
    { name: "shapes", svg: '<rect x="3" y="9" width="7" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="13" cy="12" r="3.5" fill="none" stroke="currentColor" stroke-width="1.5"/>' },
  ];

  const layers = [
    { label: "Título", swatchBg: "linear-gradient(135deg, #1a2332 0%, #1a2332 100%)" },
    { label: "Texto", swatchBg: "repeating-linear-gradient(90deg, #64748b 0, #64748b 3px, transparent 3px, transparent 6px)" },
    { label: "Acento", swatchBg: PALETTE.signature },
  ];

  const bars = [
    { label: "Q1", h: 70, color: PALETTE.signature },
    { label: "Q2", h: 110, color: PALETTE.sky },
    { label: "Q3", h: 155, color: PALETTE.signature },
    { label: "Q4", h: 200, color: PALETTE.sky },
  ];

  const SECTION2_KEYFRAMES = `
    @keyframes s2PromptGlow {
      0%, 100% { box-shadow: 0 4px 24px rgba(0,120,168,0.12); }
      50%      { box-shadow: 0 4px 32px rgba(0,120,168,0.22); }
    }
    @keyframes s2EditPulse {
      0%, 100% { opacity: 1; }
      50%      { opacity: 0.4; }
    }
    @keyframes s2ChartGlow {
      0%, 100% { opacity: 0.0; }
      50%      { opacity: 0.08; }
    }
    @keyframes s2Shimmer {
      0%   { transform: translateX(-40%); }
      100% { transform: translateX(140%); }
    }
  `;

  return (
    <div style={{ ...SECTION_FRAME, background: PALETTE.white, fontFamily: FONT_BODY, color: BRAND_INK }}>
      <style dangerouslySetInnerHTML={{ __html: BRAND_FONTS_CSS + SHARED_KEYFRAMES + SECTION2_KEYFRAMES }} />

      {/* Atmosphere */}
      <Piece id="s2.atmos" kind="atmosphere">
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
      </Piece>

      {/* Workspace mock (full-frame diegetic hero) */}
      <Piece id="s2.workspace" kind="diegetic">
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
      </Piece>

      {/* Editorial copy overlay */}
      <Piece id="s2.copy" kind="text">
        <div style={{
          position: "absolute", left: 280, top: 730, width: 600,
          display: "flex", flexDirection: "column", gap: 18, zIndex: 7,
        }}>
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 10,
            fontFamily: FONT_BODY, fontSize: 13, fontWeight: 700,
            letterSpacing: "0.2em", textTransform: "uppercase", color: PALETTE.signature,
          }}>
            <span style={{ width: 26, height: 2, background: PALETTE.signature, opacity: 0.5 }} />
            <span data-content-path="eyebrow">{c.eyebrow}</span>
          </div>
          <h1 data-content-path="headline" style={{
            fontFamily: FONT_DISPLAY, fontSize: 80, fontWeight: 800,
            lineHeight: 1.02, letterSpacing: "-0.03em", color: PALETTE.signature,
            margin: 0, maxWidth: 580,
          }}>
            {c.headline}
          </h1>
          <p data-content-path="lede" style={{
            fontFamily: FONT_BODY, fontSize: 24, fontWeight: 400, lineHeight: 1.45,
            color: PALETTE.slate, margin: 0, maxWidth: 560, opacity: 0.9,
          }}>{c.lede}</p>
        </div>

        {/* Caption — workflow annotation near prompt */}
        <div style={{
          position: "absolute", left: 920, top: 822, width: 560, zIndex: 6,
          display: "flex", alignItems: "center", gap: 8,
        }}>
          <span style={{
            fontFamily: FONT_MONO, fontSize: 12, fontWeight: 500, letterSpacing: "0.1em",
            textTransform: "uppercase", color: PALETTE.steel,
          }} data-content-path="caption">
            {c.caption}
          </span>
        </div>
      </Piece>

      {/* Brand chrome */}
      <Piece id="s2.chrome" kind="chrome">
        <Chrome sceneIndex={2} totalScenes={TOTAL_SCENES} category="Flarebit Studio" />
      </Piece>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════════
// Section 3 — "Tu marca en cada slide"
// ═══════════════════════════════════════════════════════════════════════════

export const Section3: React.FC<{ script: Script }> = ({ script }) => {
  const c = script.scenes[3].content;

  const bulletLines = ["Línea de texto", "Línea de texto", "Línea de texto"];
  const chips = ["Tipografía", "Paleta", "Tono"];

  const SECTION3_KEYFRAMES = `
    @keyframes s3ThumbFloat { 0%,100%{ transform: translateY(0); } 50%{ transform: translateY(-4px); } }
    @keyframes s3ChipGlow { 0%,100%{ box-shadow: 0 0 0 0 rgba(112,221,240,0); } 50%{ box-shadow: 0 0 14px 2px rgba(112,221,240,0.22); } }
    @keyframes s3AccentBarGrow { 0%{ transform: scaleX(0); } 100%{ transform: scaleX(1); } }
    @keyframes s3PillPulse { 0%,100%{ box-shadow: 0 0 0 0 rgba(0,120,168,0); } 50%{ box-shadow: 0 0 0 3px rgba(0,120,168,0.20); } }
    @keyframes s3SparkDraw { 0%{ stroke-dashoffset: 200; } 100%{ stroke-dashoffset: 0; } }
  `;

  return (
    <div style={{ ...SECTION_FRAME, background: PALETTE.white, fontFamily: FONT_BODY }}>
      <style
        dangerouslySetInnerHTML={{
          __html:
            BRAND_FONTS_CSS +
            SHARED_KEYFRAMES +
            SECTION3_KEYFRAMES,
        }}
      />

      {/* Atmosphere */}
      <Piece id="s3.atmos" kind="atmosphere">
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
      </Piece>

      {/* Editorial copy — left zone */}
      <Piece id="s3.copy" kind="text">
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
      </Piece>

      {/* Throughline — slide thumbnails row (el recuadro evolved) */}
      <Piece id="s3.thumbnails" kind="diegetic" throughline={THROUGHLINE_SLUG}>
        <div
          data-throughline={THROUGHLINE_SLUG}
          style={{
            ...THROUGHLINE_ANCHOR,
            width: 820,
            height: 200,
            boxSizing: "border-box",
          }}
        >
          {/* "4 diapositivas" indicator */}
          <div
            style={{
              position: "absolute",
              top: -30,
              right: 0,
              fontFamily: FONT_MONO,
              fontSize: 14,
              color: PALETTE.steel,
              letterSpacing: "0.04em",
            }}
          >
            4 diapositivas
          </div>

          {/* Thumbnail row */}
          <div
            style={{
              display: "flex",
              gap: 16,
              justifyContent: "center",
              alignItems: "flex-start",
            }}
          >
            {/* Thumbnail 1 — Title slide */}
            <div
              style={{
                width: 191,
                height: 130,
                border: `1px solid ${PALETTE.slate}`,
                borderRadius: 10,
                background: PALETTE.white,
                padding: 16,
                boxSizing: "border-box",
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                alignItems: "center",
                gap: 12,
                animation: "s3ThumbFloat 5s ease-in-out 0s infinite",
                boxShadow: "0 8px 24px rgba(26,35,50,0.06)",
              }}
            >
              <div
                style={{
                  fontFamily: FONT_DISPLAY,
                  fontWeight: 700,
                  fontSize: 16,
                  color: PALETTE.ink,
                  textAlign: "center",
                }}
              >
                Tu Empresa
              </div>
              <div
                style={{
                  width: 48,
                  height: 4,
                  background: PALETTE.signature,
                  borderRadius: 2,
                  transformOrigin: "center",
                  animation: "s3AccentBarGrow 1.2s ease-out 0.3s both",
                }}
              />
            </div>

            {/* Thumbnail 2 — Three-bullet slide */}
            <div
              style={{
                width: 191,
                height: 130,
                border: `1px solid ${PALETTE.slate}`,
                borderRadius: 10,
                background: PALETTE.white,
                padding: 16,
                boxSizing: "border-box",
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                gap: 9,
                animation: "s3ThumbFloat 5s ease-in-out 0.8s infinite",
                boxShadow: "0 8px 24px rgba(26,35,50,0.06)",
              }}
            >
              {bulletLines.map((line, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span
                    style={{
                      width: 5,
                      height: 5,
                      borderRadius: "50%",
                      background: PALETTE.sky,
                      flexShrink: 0,
                    }}
                  />
                  <span
                    style={{
                      fontFamily: FONT_BODY,
                      fontSize: 10,
                      color: PALETTE.slate,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {line}
                  </span>
                </div>
              ))}
            </div>

            {/* Thumbnail 3 — Stat / growth slide */}
            <div
              style={{
                width: 191,
                height: 130,
                border: `1px solid ${PALETTE.slate}`,
                borderRadius: 10,
                background: PALETTE.white,
                padding: 16,
                boxSizing: "border-box",
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                alignItems: "center",
                gap: 10,
                animation: "s3ThumbFloat 5s ease-in-out 1.6s infinite",
                boxShadow: "0 8px 24px rgba(26,35,50,0.06)",
              }}
            >
              <svg viewBox="0 0 88 34" width={100} height={38}>
                <polyline
                  points="4,28 18,24 30,26 42,16 54,13 66,8 84,4"
                  fill="none"
                  stroke={PALETTE.signature}
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeDasharray={200}
                  style={{ animation: "s3SparkDraw 2s ease-out 0.5s both" }}
                />
                <circle cx="84" cy="4" r="3.5" fill={PALETTE.signature} />
              </svg>
              <div
                style={{
                  fontFamily: FONT_BODY,
                  fontSize: 10,
                  color: PALETTE.slate,
                  textAlign: "center",
                  letterSpacing: "0.01em",
                }}
              >
                crecimiento interanual
              </div>
            </div>

            {/* Thumbnail 4 — Closing slide with CTA pill */}
            <div
              style={{
                width: 191,
                height: 130,
                border: `1px solid ${PALETTE.slate}`,
                borderRadius: 10,
                background: PALETTE.white,
                padding: 16,
                boxSizing: "border-box",
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                alignItems: "center",
                gap: 9,
                animation: "s3ThumbFloat 5s ease-in-out 2.4s infinite",
                boxShadow: "0 8px 24px rgba(26,35,50,0.06)",
              }}
            >
              <div style={{ width: 110, height: 5, background: PALETTE.mist, borderRadius: 2 }} />
              <div style={{ width: 86, height: 5, background: PALETTE.mist, borderRadius: 2 }} />
              <div
                style={{
                  background: PALETTE.signature,
                  color: PALETTE.white,
                  fontFamily: FONT_BODY,
                  fontSize: 12,
                  fontWeight: 600,
                  padding: "6px 18px",
                  borderRadius: 999,
                  marginTop: 4,
                  animation: "s3PillPulse 3s ease-in-out 1.5s infinite",
                }}
              >
                Contáctanos
              </div>
            </div>
          </div>

          {/* Tiny connector dots between thumbnails */}
          <div
            style={{
              position: "absolute",
              bottom: -16,
              left: "50%",
              transform: "translateX(-50%)",
              display: "flex",
              gap: 6,
            }}
          >
            {[0, 1, 2, 3].map((i) => (
              <span
                key={i}
                style={{
                  width: 4,
                  height: 4,
                  borderRadius: "50%",
                  background: i === 0 ? PALETTE.signature : PALETTE.mist,
                }}
              />
            ))}
          </div>
        </div>
      </Piece>

      {/* Lower zone — divider + consistency chips + caption + meta footer */}
      <Piece id="s3.footer" kind="diegetic">
        {/* Divider */}
        <div
          style={{
            position: "absolute",
            left: 80,
            right: 80,
            top: 760,
            height: 1,
            background: PALETTE.mist,
          }}
        />

        {/* Consistency chips */}
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: 796,
            transform: "translateX(-50%)",
            display: "flex",
            gap: 18,
          }}
        >
          {chips.map((chip, i) => (
            <div
              key={i}
              style={{
                border: `1px solid ${PALETTE.cyan}`,
                borderRadius: 999,
                padding: "9px 22px",
                fontFamily: FONT_BODY,
                fontSize: 16,
                fontWeight: 500,
                color: PALETTE.ink,
                background: `${PALETTE.cyan}0a`,
                animation: `s3ChipGlow 4.5s ease-in-out ${i * 0.6}s infinite`,
              }}
            >
              {chip}
            </div>
          ))}
        </div>

        {/* Caption */}
        {c.caption && (
          <div
            data-content-path="caption"
            style={{
              position: "absolute",
              left: "50%",
              top: 868,
              transform: "translateX(-50%)",
              fontFamily: FONT_MONO,
              fontSize: 14,
              color: PALETTE.steel,
              textAlign: "center",
              letterSpacing: "0.06em",
              maxWidth: 800,
            }}
          >
            {c.caption}
          </div>
        )}

        {/* Left meta footer */}
        <div
          style={{
            position: "absolute",
            left: 80,
            bottom: 72,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <div
            style={{
              fontFamily: FONT_MONO,
              fontSize: 12,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: PALETTE.steel,
            }}
          >
            Identidad aplicada
          </div>
          <div
            style={{
              fontFamily: FONT_DISPLAY,
              fontSize: 22,
              fontWeight: 700,
              color: PALETTE.ink,
            }}
          >
            Tipografía · Paleta · Tono
          </div>
        </div>

        {/* Right meta footer */}
        <div
          style={{
            position: "absolute",
            right: 80,
            bottom: 72,
            display: "flex",
            flexDirection: "column",
            gap: 6,
            textAlign: "right",
          }}
        >
          <div
            style={{
              fontFamily: FONT_MONO,
              fontSize: 12,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: PALETTE.steel,
            }}
          >
            Cierre con CTA
          </div>
          <div
            style={{
              fontFamily: FONT_DISPLAY,
              fontSize: 22,
              fontWeight: 700,
              color: PALETTE.ink,
            }}
          >
            Portada → Cierre
          </div>
        </div>
      </Piece>

      {/* Brand chrome */}
      <Piece id="s3.chrome" kind="chrome">
        <Chrome sceneIndex={3} totalScenes={TOTAL_SCENES} category="Flarebit Studio" />
      </Piece>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════════
// Section 4 — "Acceso anticipado"
// ═══════════════════════════════════════════════════════════════════════════

export const Section4: React.FC<{ script: Script }> = ({ script }) => {
  const c = script.scenes[4].content;

  const SECTION4_KEYFRAMES = `
    @keyframes s4BarGrow { 0% { transform: scaleX(0); } 100% { transform: scaleX(1); } }
    @keyframes s4GlowPulse { 0%,100% { opacity: 0.16; } 50% { opacity: 0.30; } }
  `;

  return (
    <div style={{ ...SECTION_FRAME, background: PALETTE.white, fontFamily: FONT_BODY }}>
      <style dangerouslySetInnerHTML={{ __html: BRAND_FONTS_CSS + SHARED_KEYFRAMES + SECTION4_KEYFRAMES }} />

      {/* Atmosphere */}
      <Piece id="s4.atmos" kind="atmosphere">
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
      </Piece>

      {/* Centered editorial copy stack */}
      <Piece id="s4.copy" kind="text">
        <div style={{ position: "absolute", top: 130, left: "50%", transform: "translateX(-50%)", display: "flex", flexDirection: "column", alignItems: "center", gap: 26, width: 1000 }}>
          {/* Eyebrow */}
          <div style={{ fontFamily: FONT_BODY, fontSize: 14, fontWeight: 600, letterSpacing: "0.18em", textTransform: "uppercase", color: PALETTE.signature, display: "inline-flex", alignItems: "center", gap: 12 }}>
            <span style={{ width: 32, height: 2, background: PALETTE.signature, opacity: 0.55, borderRadius: 1 }} />
            <span data-content-path="eyebrow">{c.eyebrow}</span>
          </div>

          {/* Headline */}
          <h1 data-content-path="headline" style={{ fontFamily: FONT_DISPLAY, fontWeight: 800, fontSize: 92, lineHeight: 1.0, letterSpacing: "-0.035em", color: PALETTE.ink, margin: 0, textAlign: "center" }}>
            {c.headline}
          </h1>

          {/* Accent bar — ~40% canvas width */}
          <div style={{ width: 768, height: 5, background: PALETTE.signature, borderRadius: 3, transformOrigin: "center", animation: "s4BarGrow 0.7s cubic-bezier(.2,.8,.2,1) 0.2s both" }} />

          {/* Lede */}
          <p data-content-path="lede" style={{ fontFamily: FONT_BODY, fontSize: 26, lineHeight: 1.5, color: PALETTE.ink, opacity: 0.82, margin: 0, textAlign: "center", maxWidth: 780 }}>
            {c.lede}
          </p>
        </div>
      </Piece>

      {/* Throughline — the rectangle evolved into an actionable button */}
      <Piece id="s4.cta" kind="diegetic" throughline={THROUGHLINE_SLUG}>
        <ThroughlineRect
          width={380}
          height={76}
          animate="breathe"
          style={{
            borderRadius: 999,
            background: PALETTE.signature,
            border: "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 16px 48px rgba(0,120,168,0.32), 0 4px 12px rgba(0,120,168,0.18)",
          }}
        >
          <span data-content-path="cta.primary" style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 24, color: PALETTE.white, letterSpacing: "0.01em" }}>
            {c.cta?.primary}
          </span>
        </ThroughlineRect>
      </Piece>

      {/* URL + info card below the CTA button, anchored to same x */}
      <Piece id="s4.meta" kind="text">
        <div style={{ position: "absolute", left: 1360, top: 620, transform: "translateX(-50%)", display: "flex", flexDirection: "column", alignItems: "center", gap: 22 }}>
          {/* URL */}
          <div data-content-path="cta.secondary" style={{ fontFamily: FONT_MONO, fontSize: 20, color: PALETTE.slate, letterSpacing: "0.02em" }}>
            {c.cta?.secondary}
          </div>

          {/* Info card — caption split into two labeled rows */}
          <div data-content-path="caption" style={{
            border: `1px solid ${PALETTE.mist}`,
            borderRadius: 14,
            padding: "18px 32px",
            display: "flex",
            gap: 28,
            alignItems: "center",
            background: PALETTE.white,
            boxShadow: "0 4px 20px rgba(15,23,42,0.04)",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: PALETTE.signature, flexShrink: 0 }} />
              <span style={{ fontFamily: FONT_BODY, fontSize: 16, color: PALETTE.ink, fontWeight: 600, letterSpacing: "0.01em" }}>Cupos limitados</span>
            </div>
            <div style={{ width: 1, height: 22, background: PALETTE.mist }} />
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: PALETTE.signature, flexShrink: 0 }} />
              <span style={{ fontFamily: FONT_BODY, fontSize: 16, color: PALETTE.ink, fontWeight: 600, letterSpacing: "0.01em" }}>Beta privada</span>
            </div>
          </div>
        </div>
      </Piece>

      {/* Chrome */}
      <Piece id="s4.chrome" kind="chrome">
        <Chrome sceneIndex={4} totalScenes={TOTAL_SCENES} category="AI Deck Platform" />
      </Piece>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════════
// Generated — preview only
// ═══════════════════════════════════════════════════════════════════════════

export const Generated: React.FC<{ script: Script }> = ({ script }) => (
  <>
    <style dangerouslySetInnerHTML={{ __html: BRAND_FONTS_CSS }} />
    <style dangerouslySetInnerHTML={{ __html: SHARED_KEYFRAMES }} />
    <Section0 script={script} />
    <Section1 script={script} />
    <Section2 script={script} />
    <Section3 script={script} />
    <Section4 script={script} />
  </>
);