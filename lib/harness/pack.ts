/**
 * The context pack — the harness's load-bearing artifact (docs/HARNESS.md §2).
 *
 * Plain text, assembled deterministically from the approved script + the
 * crawl's brand facts. Everything the author needs, nothing that substitutes
 * for its judgment: the outline verbatim, the file contract, truth rules,
 * retrieved brand facts, and the four composition directives. Measured on
 * 2026-08-27: this pack lifted $0.30 one-call authors above an unpacked
 * frontier pass in the founder's blind ranking.
 */

export interface PackBrandFacts {
  brandName: string;
  /** Crawl palette hexes, most-branded first. May be empty (thin brands). */
  palette: string[];
  /** Resolved corner-mark logo URL (resolveCornerBrandMark) — or null. */
  logoSrc: string | null;
  /** Canvas mode from the crawl theme ("dark" | "light"). */
  mode: "dark" | "light";
  /** Canvas background from the resolved canvas plan. */
  background: string;
  /** Roles the USER locked in the ceremony — decisions, not crawl guesses.
   *  The pack renders them with authority so the author cannot mistake the
   *  locked accent for one anonymous swatch among eight (the founder's Fuse
   *  deck did exactly that: the locked maroon became the villain color). */
  roles?: { accent?: string; background?: string; monochrome?: boolean };
  /** The brand's type, resolved by the build (user picks beat the crawl).
   *  `stack` is a full font-family stack ending in a system family; `faceSrc`
   *  is the brand's own woff2/woff URL when the crawl captured one — it joins
   *  the asset allowlist and the author @font-faces it. Absent slots fall
   *  back to the system-stacks rule. Root-cause fix, 2026-08-31: fonts were
   *  crawled and stored but NEVER fed to the author — every harness deck was
   *  typeset in Helvetica regardless of brand. */
  fonts?: {
    display?: { stack: string; faceSrc?: string };
    body?: { stack: string; faceSrc?: string };
    mono?: { stack: string };
  };
}

export interface PackScene {
  label: string;
  description: string;
  /** The approved structured copy payload — stringified, verbatim. */
  content: string;
}

export interface PackInput {
  /** Long decks (>8 pages) are authored in chapters: the first call emits only
   *  Section0..emitEnd-1 but sees the WHOLE outline so the identity is designed
   *  for every page. Omit for single-breath decks. */
  chapterEmitEnd?: number;
  briefPrompt: string;
  tone: string | undefined;
  aspect: "16:9" | "9:16" | "1:1";
  scenes: PackScene[];
  brand: PackBrandFacts;
  /** Extra asset URLs the author may reference (brand files). */
  assetUrls: string[];
}

export const CANVAS_BY_ASPECT: Record<PackInput["aspect"], { w: number; h: number }> = {
  "16:9": { w: 1920, h: 1080 },
  "9:16": { w: 1080, h: 1920 },
  "1:1": { w: 1080, h: 1080 },
};

/** Every asset URL the emitted file is allowed to reference (logo + brand
 *  files + the brand's own font faces). */
export const packAssetAllowlist = (input: PackInput): string[] =>
  [
    input.brand.logoSrc,
    input.brand.fonts?.display?.faceSrc,
    input.brand.fonts?.body?.faceSrc,
    ...input.assetUrls,
  ].filter((u): u is string => !!u);

export const assemblePack = (input: PackInput): string => {
  const { w, h } = CANVAS_BY_ASPECT[input.aspect];
  const n = input.scenes.length;
  const sections = Array.from({ length: n }, (_, i) => `Section${i}`).join(", ");

  const outline = input.scenes
    .map((s, i) => `Page ${i + 1} — ${s.label}\nIntent: ${s.description}\nApproved copy (use this text, compress freely, add no facts): ${s.content}`)
    .join("\n\n");

  const assets = packAssetAllowlist(input);
  const roles = input.brand.roles ?? {};
  const roleLines = [
    roles.accent
      ? `- Accent: ${roles.accent} — THE brand accent. It leads: the color of emphasis, key devices, and what the deck is remembered by. Every other palette color is supporting cast.`
      : null,
    roles.background
      ? `- Page background: ${roles.background} — every page's canvas. Non-negotiable.`
      : null,
    roles.monochrome
      ? `- The user confirmed this brand is BLACK & WHITE: no chromatic accent anywhere. Craft comes from type, spacing, and neutral tone.`
      : null,
  ].filter((l): l is string => !!l);
  const brandLines = [
    `Brand: ${input.brand.brandName}. Canvas mode: ${input.brand.mode}. Canvas background: ${input.brand.background}.`,
    input.brand.palette.length
      ? `Brand palette (retrieved from the real site — stay inside this family plus neutrals): ${input.brand.palette.join(" ")}`
      : `No palette retrieved — choose ONE disciplined scheme and commit to it on every page.`,
    roleLines.length
      ? `USER-LOCKED COLOR ROLES (the user chose these while looking at the palette — obey them, they are decisions, not suggestions):\n${roleLines.join("\n")}`
      : null,
    input.brand.fonts?.display || input.brand.fonts?.body
      ? `BRAND TYPE (the brand's own faces — the deck is typeset in them, not in defaults):\n${[
          input.brand.fonts.display
            ? `- Display: ${input.brand.fonts.display.stack}${input.brand.fonts.display.faceSrc ? ` — face file: ${input.brand.fonts.display.faceSrc}` : ""}`
            : null,
          input.brand.fonts.body
            ? `- Body: ${input.brand.fonts.body.stack}${input.brand.fonts.body.faceSrc ? ` — face file: ${input.brand.fonts.body.faceSrc}` : ""}`
            : null,
          input.brand.fonts.mono ? `- Mono: ${input.brand.fonts.mono.stack}` : null,
        ]
          .filter(Boolean)
          .join("\n")}`
      : null,
    input.brand.logoSrc
      ? `The REAL brand logo is provided as an asset URL below. Use it as the lockup in every page's chrome (an <img> at natural aspect, height 24-36px) and larger where the story calls for it. Do not draw your own logo and do not write the brand name as plain text where the logo should be.`
      : `No logo asset was retrieved. Use a restrained text wordmark ("${input.brand.brandName}") in the chrome — do NOT invent a logo mark.`,
    assets.length ? `Allowed asset URLs (the ONLY external URLs permitted anywhere in the file):\n${assets.map((u) => `  - ${u}`).join("\n")}` : `No asset URLs — the file must reference no external URLs at all.`,
  ].filter((l): l is string => !!l).join("\n");

  return `You are the design engine of a premium presentation studio. Author a complete ${n}-page deck as ONE self-contained React file. This is your only pass: no revisions follow, so compose at full ambition now.

THE APPROVED OUTLINE (verbatim — the user has signed off on this story):

${outline}

Deck tone: ${input.tone ?? "confident, premium, editorial"}.
Original brief, for grounding: ${input.briefPrompt}

FILE CONTRACT:
- TypeScript React. Start with \`import React from "react";\` then \`import { Piece } from "./Piece";\` and nothing else imported. Then \`type Script = any;\`
- ${input.chapterEmitEnd && input.chapterEmitEnd < n
    ? `This ${n}-page deck is authored in chapters. THIS call: export ONLY \`Section0\` through \`Section${input.chapterEmitEnd - 1}\` (pages 1-${input.chapterEmitEnd}). Later chapters continue the SAME file — so declare every shared constant, helper, and chrome component at module top level now, and design the identity to carry all ${n} pages.`
    : `Export exactly ${n} components: \`export const Section0\` through \`export const Section${n - 1}\` (React.FC<{ script?: Script }>), one per page, in outline order.`}
- Each section renders a full ${w}x${h} page: root div style {{ position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "hidden" }} with an explicit background.
- Inline styles only (React.CSSProperties objects). No CSS files, no Tailwind, no hooks, no state, no refs.
- EDITABILITY GRAMMAR (hard): inside each section, wrap every visually distinct block in \`<Piece id="sN.pM" kind="...">\` ... \`</Piece>\` — N = page index, M = a per-page counter. The wrapper is transparent: the block inside it positions ITSELF (position: "absolute" with its own coordinates). Use kind="chrome" for the recurring page furniture (lockup, page number, footer rail — one chrome Piece per page, listed LAST in the section) and kind="diegetic" for everything else. One graphic device = ONE Piece (a whole SVG diagram is one Piece). Headline, supporting text, quote cards, stat rows: each its own Piece. Shared helper components and constants live at module top level, OUTSIDE the sections — never inside a Piece.
- No external URLs except the allowed asset URLs listed above.
- ${input.brand.fonts?.display || input.brand.fonts?.body
    ? `Typography: set FONT_DISPLAY and FONT_BODY to the BRAND TYPE stacks given below (FONT_MONO: ${input.brand.fonts?.mono ? "the brand mono stack below" : "a system mono stack — SF Mono/Menlo/monospace"}). For each face file URL provided, emit ONE @font-face rule (font-family exactly as named in the stack, src: url(<that URL>), font-display: swap) inside a single <style> tag rendered once in your chrome component. Every stack ends in a system family, so a failed load degrades gracefully.`
    : `System font stacks only (e.g. Helvetica Neue/Arial for display, SF Mono/Menlo/monospace for labels).`}
- Deterministic: no Math.random, no Date. SVG is available and encouraged for graphic devices.
- Every text-bearing block declares a horizontal bound (explicit width, maxWidth, or a right: offset). Unbounded text cannot autofit and will clip at the canvas edge.
- Declare your color system at module top level as \`const PALETTE = { accent, canvas, ink, muted, surface, line }\` — accent = the lead brand color, canvas = the page background, ink = primary text, muted = secondary text, surface = card/panel fills, line = hairlines. Add as many extra keys as you like (never rename these six), and reference PALETTE keys instead of scattering raw hex literals. This exact const name is what lets the user re-color the deck instantly afterwards.
- Declare your type system the same way: \`const FONT_DISPLAY\`, \`const FONT_BODY\`, and \`const FONT_MONO\` at module top level (full font-stack strings), referenced by every fontFamily — never inline a stack in a style. These exact names are what let the user re-type the deck instantly afterwards.

TRUTH RULES (hard):
- Every numeral on a page must come from the approved copy above. Invent NONE: no statistics, dollar figures, percentages, or years that are not in the outline. Page indices like "01 — 0${n}" are allowed.
- Every claim must come from the outline. Compress and rephrase freely; add no facts.

BRAND FACTS (retrieved from the real brand — use them, do not improvise a different identity):
${brandLines}

COMPOSITION DIRECTIVES:
- Commit to ONE visual identity: consistent page chrome (lockup, page numbers, footer rail) across all ${n} pages.
- Every page gets one purposeful graphic device that expresses THAT page's argument — a diagram born from the meaning — never generic decoration, never an empty half-canvas.
- Occupy the canvas: ${w}x${h} is large. Full-bleed composition, deliberate asymmetry, generous but intentional space.
- Match the register the outline asks for: one strong display headline per page, controlled secondary text, monospace kickers/labels, no bullet-list walls.

OUTPUT: reply with ONLY the complete file in a single \`\`\`tsx code block. No commentary before or after.`;
};
