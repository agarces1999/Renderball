import React from "react";
import { Img } from "./Img";

/** naturalWidth/naturalHeight above this ratio means the logo asset is a
 *  horizontal LOCKUP — the brand name is already drawn inside the image, so
 *  rendering the wordmark span next to it would print the name twice.
 *  Mirrors isWideLockup in lib/render/build-wrapper.ts (the template
 *  interpolates the same WIDE_LOCKUP_RATIO constant). */
export const isWideLockup = (naturalWidth: number, naturalHeight: number): boolean =>
  naturalHeight > 0 && naturalWidth / naturalHeight > 2.5;

/** True when a CSS color reads as LIGHT (luminance > 0.5). Parses #hex and
 *  rgb()/rgba(); anything unparseable counts as light, preserving the legacy
 *  white-silhouette behavior. Drives the logo filter below: light ink means a
 *  dark canvas (silhouette the mark white); dark ink means a light canvas
 *  (render the mark's NATURAL colors — a white silhouette on a light canvas
 *  is invisible, the FP-rebuild top-left logo bug). */
export const isLightColor = (c: string): boolean => {
  let r: number, g: number, b: number;
  const hex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(c.trim());
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split("").map((x) => x + x).join("");
    const n = parseInt(h, 16);
    r = (n >> 16) & 255; g = (n >> 8) & 255; b = n & 255;
  } else {
    const m = /rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(c);
    if (!m) return true;
    r = +m[1]; g = +m[2]; b = +m[3];
  }
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 127;
};

export interface BrandChromeProps {
  sceneIndex: number;
  totalScenes: number;
  /** ONE archetype per video: corner (default, tech/minimal), footer
   *  (editorial band), strip (top app-bar). Never varies between scenes. */
  variant?: "corner" | "footer" | "strip";
  /** Pass LOGO_SRC. Omit when the brand has no real logo — the wordmark
   *  text then serves as the mark. */
  logoSrc?: string;
  /** Brand name text rendered next to the mark (or as the mark itself).
   *  Auto-suppressed once logoSrc loads and measures as a wide lockup
   *  (see isWideLockup) — the asset already contains the name. */
  wordmark?: string;
  /** STABLE context pill (tagline / event / category) — never the scene's
   *  editorial eyebrow. */
  category?: string;
  /** Set false on the ONE scene that renders its own hero logo (logo-led
   *  opening / CTA) so the frame keeps exactly one logo. */
  showCornerLogo?: boolean;
  /** Set true on a full-bleed brand-color scene: chrome flips to white ink
   *  so it clears contrast against the saturated field. */
  onBrandColorBg?: boolean;
  /** Chrome ink on normal (dark) scenes — e.g. BRAND_LIGHT. */
  ink: string;
  /** Active pagination dot / accents — e.g. BRAND_ACCENT. */
  accent: string;
  fontDisplay: string;
  fontBody: string;
  /** Optional footer-band background (footer variant only). */
  tint?: string;
}

export const BrandChrome: React.FC<BrandChromeProps> = ({
  sceneIndex,
  totalScenes,
  variant = "corner",
  logoSrc,
  wordmark,
  category,
  showCornerLogo,
  onBrandColorBg,
  ink,
  accent,
  fontDisplay,
  fontBody,
  tint,
}) => {
  const fg = onBrandColorBg ? "#ffffff" : ink;
  const dot = onBrandColorBg ? "#ffffff" : accent;
  const idle = onBrandColorBg ? "rgba(255,255,255,0.45)" : "rgba(255,255,255,0.25)";
  // Logo treatment follows the canvas: on a dark canvas (light ink) the mark
  // is silhouetted white; on a light canvas (dark ink) it keeps its natural
  // brand colors — forcing white there rendered it invisible.
  const logoFilter =
    onBrandColorBg || isLightColor(ink) ? "brightness(0) invert(1)" : "none";

  // Until the logo loads — and in SSR, where it never does — the wordmark
  // renders as always; measurement can only SUPPRESS it. The MP4 renderer
  // waits for images before capturing frames, so onLoad lands ahead of
  // frame 0. The data-rb-brand-* attributes are load-bearing: the static-HTML
  // preview strips React handlers, so the iframe route re-applies this same
  // rule via an injected vanilla script that finds them.
  const [logoIsLockup, setLogoIsLockup] = React.useState(false);

  const mark =
    showCornerLogo !== false ? (
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {logoSrc ? (
          <Img
            src={logoSrc}
            data-rb-brand-logo=""
            style={{ height: 24, width: "auto", filter: logoFilter }}
            onLoad={(e: React.SyntheticEvent<HTMLImageElement>) => {
              const el = e.currentTarget;
              if (isWideLockup(el.naturalWidth, el.naturalHeight)) setLogoIsLockup(true);
            }}
          />
        ) : null}
        {wordmark && !logoIsLockup ? (
          <span
            data-rb-brand-wordmark=""
            style={{
              fontFamily: fontDisplay,
              fontWeight: 600,
              fontSize: 18,
              color: fg,
              letterSpacing: "-0.01em",
              whiteSpace: "nowrap",
            }}
          >
            {wordmark}
          </span>
        ) : null}
      </div>
    ) : (
      <div />
    );

  const pill = category ? (
    <div style={{ display: "flex", alignItems: "center", gap: 8, maxWidth: 460 }}>
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: dot,
          opacity: 0.85,
          flexShrink: 0,
        }}
      />
      <span
        style={{
          fontFamily: fontBody,
          fontSize: 11,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: fg,
          opacity: onBrandColorBg ? 0.95 : 0.75,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {category}
      </span>
    </div>
  ) : null;

  // Pagination dots REMOVED (QA 2026-07-06): scene-progress dots at the bottom
  // of every frame read as website carousel chrome and made rendered scenes
  // look like landing-page screenshots. A brand film shows no progress UI.
  // sceneIndex/totalScenes stay in the props contract (compat + future use).
  void sceneIndex;
  void totalScenes;
  void idle;

  if (variant === "footer") {
    return (
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: 64,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 40px",
          background: tint ?? "rgba(255,255,255,0.04)",
          zIndex: 20,
        }}
      >
        {mark}
        {pill ?? <div />}
      </div>
    );
  }

  if (variant === "strip") {
    return (
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,
          height: 56,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 40px",
          zIndex: 20,
        }}
      >
        {mark}
        {pill ?? <div />}
      </div>
    );
  }

  // corner (default)
  return (
    <>
      {showCornerLogo !== false && (
        <div style={{ position: "absolute", top: 32, left: 40, zIndex: 20 }}>{mark}</div>
      )}
      {pill && (
        <div style={{ position: "absolute", top: 36, right: 40, zIndex: 20 }}>{pill}</div>
      )}
    </>
  );
};
