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
  /** DESIGN-LANGUAGE CARD (RB_DESIGN_CARD, 10x program 2026-09-04): a vision
   *  read of the brand's own homepage screenshot — mood, density, radii,
   *  type character, how the accent is really used, surfaces, imagery style,
   *  what not to do. Hex codes and font names cannot say "pill corners only
   *  on CTAs, sharp elsewhere; color as flat full-bleed bands; no shadows"
   *  (the Anthropic probe's exact reading). Read once per brand, cached. */
  designCard?: string;
}

export interface PackScene {
  label: string;
  description: string;
  /** The approved structured copy payload — stringified, verbatim. */
  content: string;
  /** The outline's per-page composition/device plan (visual_concept). The
   *  outline stage already authors this — gate-enforced concrete — and the
   *  user approves it with the outline; until 2026-09-02 the harness DROPPED
   *  it, so the author re-derived every page's device from scratch (ab7: a
   *  page whose approved concept said "five tile rows, rounded-rectangle
   *  cards" was authored as a plain bullet list). Feeding it is retrieval,
   *  not scaffolding: the author keeps full styling ownership. */
  visual?: string;
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
  /** PARALLEL AUTHORING (RB_AUTHOR_PARALLEL, 10x program 2026-09-04): the
   *  deck is written in two passes — a DESIGN pass that emits the module
   *  preamble (design system, chrome, helpers, keyframes) plus a plan per
   *  page, then N PAGE passes in parallel, each emitting one Section against
   *  the fixed preamble. Only the FILE CONTRACT changes per pass; outline,
   *  brand facts, truth rules, composition and motion directives are the same
   *  words every pass reads. Omit for the one-call author. */
  parallel?:
    | { pass: "design" }
    | { pass: "plan"; preamble: string }
    | { pass: "page"; page: number; preamble: string; plans: string };
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
    .map(
      (s, i) =>
        `Page ${i + 1} — ${s.label}\nIntent: ${s.description}\n${
          s.visual?.trim()
            ? `Approved visual concept (the user signed off on this direction — realize its device and composition, executing and refining freely): ${s.visual.trim()}\n`
            : ""
        }Approved copy (use this text, compress freely, add no facts): ${s.content}`,
    )
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
    input.brand.designCard?.trim()
      ? `DESIGN LANGUAGE (read from the brand's own homepage — match this look, not merely the palette; where it conflicts with a generic "premium deck" instinct, the brand wins):\n${input.brand.designCard.trim()}`
      : null,
    input.brand.logoSrc
      ? `The REAL brand logo is provided as an asset URL below. Use it as the lockup in every page's chrome (an <img> at natural aspect, height 24-36px) and larger where the story calls for it. Do not draw your own logo and do not write the brand name as plain text where the logo should be.`
      : `No logo asset was retrieved. Use a restrained text wordmark ("${input.brand.brandName}") in the chrome — do NOT invent a logo mark.`,
    assets.length ? `Allowed asset URLs (the ONLY external URLs permitted anywhere in the file):\n${assets.map((u) => `  - ${u}`).join("\n")}` : `No asset URLs — the file must reference no external URLs at all.`,
  ].filter((l): l is string => !!l).join("\n");

  const par = input.parallel;
  const opening = par?.pass === "design"
    ? `You are the design engine of a premium presentation studio. This ${n}-page deck is authored in TWO PASSES and this is the DESIGN PASS: you design the whole deck's identity and plan every page, but emit no page yet. Compose at full ambition — the page passes execute exactly what you lay down here.`
    : par?.pass === "plan"
      ? `You are the design engine of a premium presentation studio. This brand already has a DECK SYSTEM (the module preamble below — its identity, chrome, helpers and keyframes are FIXED and reused across the brand's decks). This call PLANS every page of this ${n}-page deck against that system; the page passes then write the pages. Plan at full ambition — the pages execute exactly what you lay down.`
      : par?.pass === "page"
      ? `You are the design engine of a premium presentation studio. This ${n}-page deck is authored in TWO PASSES; the design pass is done and its module preamble is FIXED. This call writes ONE page — page ${par.page + 1} — at full ambition, exactly on its plan.`
      : `You are the design engine of a premium presentation studio. Author a complete ${n}-page deck as ONE self-contained React file. This is your only pass: no revisions follow, so compose at full ambition now.`;
  const passContract = par?.pass === "design"
    ? `- DESIGN PASS OUTPUT, part 1 — the complete MODULE PREAMBLE in one \`\`\`tsx block: the two imports and \`type Script = any;\`, \`const PALETTE\`, \`FONT_DISPLAY\`/\`FONT_BODY\`/\`FONT_MONO\`, the deck's single <style> component (every @font-face and every @keyframes the pages will use), the chrome component every page renders (lockup, page number, footer rail — it takes a \`page\` prop and renders that <style>), and EVERY shared helper component and constant the pages will need (cards, stat tiles, kickers, device primitives, easing constants). Do NOT emit any \`SectionN\` — the page passes do. The preamble must compile on its own.
- DESIGN PASS OUTPUT, part 2 — the PAGE PLANS in one \`\`\`text block after the code: for each page 1-${n}, 4-8 lines headed \`Page K — <label>\`: the concrete graphic device, the layout zones with canvas coordinates, the type moments (headline size/placement), the motion beats (which elements enter, in what order, which helper/keyframe), and which shared helpers it uses. No two pages may use the same device.`
    : par?.pass === "plan"
      ? `- PLAN PASS OUTPUT — the PAGE PLANS in one \`\`\`text block and nothing else: for each page 1-${n}, 4-8 lines headed \`Page K — <label>\`: the concrete graphic device (built from the system's helpers and primitives, or drawn as SVG), the layout zones with canvas coordinates, the type moments, the motion beats (which elements enter, in what order, which keyframe from the system), and which shared helpers it uses. No two pages may use the same device. Emit NO code.`
      : par?.pass === "page"
      ? `- The MODULE PREAMBLE below is FIXED: reference its constants, helpers, keyframes and chrome exactly by name. Do NOT re-emit or modify it. Define NOTHING at module scope — no imports, no new top-level constants or components (put page-local helpers INSIDE the section body).
- Emit ONLY \`export const Section${par.page}: React.FC<{ script?: Script }>\` for page ${par.page + 1}, following ITS plan below. The other pages' plans are given so devices stay distinct and the story flows — do not write them.`
      : `- ${input.chapterEmitEnd && input.chapterEmitEnd < n
          ? `This ${n}-page deck is authored in chapters. THIS call: export ONLY \`Section0\` through \`Section${input.chapterEmitEnd - 1}\` (pages 1-${input.chapterEmitEnd}). Later chapters continue the SAME file — so declare every shared constant, helper, and chrome component at module top level now, and design the identity to carry all ${n} pages.`
          : `Export exactly ${n} components: \`export const Section0\` through \`export const Section${n - 1}\` (React.FC<{ script?: Script }>), one per page, in outline order.`}`;
  const passContext = par?.pass === "page"
    ? `\n\nTHE FIXED MODULE PREAMBLE (already in the file — reference, never re-emit):\n\n\`\`\`tsx\n${par.preamble.trim()}\n\`\`\`\n\nTHE PAGE PLANS (yours is page ${par.page + 1}):\n\n${par.plans.trim()}\n`
    : par?.pass === "plan"
      ? `\n\nTHE BRAND'S DECK SYSTEM (the fixed module preamble — plan with its helpers, primitives, chrome and keyframes):\n\n\`\`\`tsx\n${par.preamble.trim()}\n\`\`\`\n`
      : "";
  const output = par?.pass === "design"
    ? `OUTPUT: reply with the preamble in one \`\`\`tsx block, then the page plans in one \`\`\`text block. No commentary.`
    : par?.pass === "plan"
      ? `OUTPUT: reply with ONLY the page plans in one \`\`\`text block. No code, no commentary.`
      : par?.pass === "page"
      ? `OUTPUT: reply with ONLY the \`Section${par.page}\` component in a single \`\`\`tsx block. No commentary before or after.`
      : `OUTPUT: reply with ONLY the complete file in a single \`\`\`tsx code block. No commentary before or after.`;

  return `${opening}

THE APPROVED OUTLINE (verbatim — the user has signed off on this story):

${outline}

Deck tone: ${input.tone ?? "confident, premium, editorial"}.
Original brief, for grounding: ${input.briefPrompt}${passContext}

FILE CONTRACT:
- TypeScript React. Start with \`import React from "react";\` then \`import { Piece } from "./Piece";\` and nothing else imported. Then \`type Script = any;\`
${passContract}
- Each section renders a full ${w}x${h} page: root div style {{ position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "hidden" }} with an explicit background.
- Inline styles only (React.CSSProperties objects). No CSS files, no Tailwind, no hooks, no state, no refs.
- EDITABILITY GRAMMAR (hard): inside each section, wrap every visually distinct block in \`<Piece id="sN.pM" kind="...">\` ... \`</Piece>\` — N = page index, M = a per-page counter. The wrapper is transparent: the block inside it positions ITSELF (position: "absolute" with its own coordinates). Use kind="chrome" for the recurring page furniture (lockup, page number, footer rail — one chrome Piece per page, listed LAST in the section) and kind="diegetic" for everything else. One graphic device = ONE Piece (a whole SVG diagram is one Piece). Headline, supporting text, quote cards, stat rows: each its own Piece. Shared helper components and constants live at module top level, OUTSIDE the sections — never inside a Piece. Piece ids are LITERAL strings, unique on their page — NEVER render a <Piece> inside a loop or compute its id (repetition belongs INSIDE one Piece: put the .map inside the wrapper, not around it).
- No external URLs except the allowed asset URLs listed above.
- ${input.brand.fonts?.display || input.brand.fonts?.body
    ? `Typography: set FONT_DISPLAY and FONT_BODY to the BRAND TYPE stacks given below (FONT_MONO: ${input.brand.fonts?.mono ? "the brand mono stack below" : "a system mono stack — SF Mono/Menlo/monospace"}). For each face file URL provided, emit ONE @font-face rule (font-family exactly as named in the stack, src: url(<that URL>), font-display: swap) inside the deck's single <style> element, which your chrome component renders on EVERY page — each page is served as its own document, so a <style> that only page 1 renders leaves every other page without its fonts. Every stack ends in a system family, so a failed load degrades gracefully.`
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

MOTION (the deck is presented live — pages move, purposefully; this is a signature of the studio):
- Every page opens with a brief entrance choreography: its blocks arrive in reading order, staggered 60-120ms apart, each with ONE finite CSS animation of 500-900ms, ease-out — opacity plus a small transform (translateY 16-32px, or scale 0.96→1). The whole page has settled within 1.5s. Motion serves the argument: the graphic device may draw itself in (a stroke-dashoffset line, bars growing via scaleX from their origin) — that is the page's moment.
- HARD INVARIANT — the static inline style IS the final designed state. Every animated element's inline style declares its resting appearance (opacity 1, no offset transform); the hidden starting pose lives ONLY in the @keyframes from-frame, applied with animation-fill-mode "backwards" (never "forwards" or "both"). The deck is exported, thumbnailed, measured and edited at its settled end state, so an element that does not rest on its own static styles is a defect: never write a static opacity: 0 or an offset transform.
- Animate only opacity, transform, and stroke-dashoffset/stroke-dasharray. Never width, height, left, top, font-size, or color.
- One graphic device per page may carry one restrained ambient loop (4-12s, infinite, ease-in-out, subtle) — on an INNER part of the device (a ring, a dot, a bar's fill), never on a block's outermost element and never on text. Everything else comes to rest.
- Declare every @keyframes in the deck's single <style> element (the same one that carries any @font-face), and render that <style> on EVERY page from the chrome component every section renders — each page is served as its own document, so keyframes rendered only on page 1 leave pages 2+ motionless. Prefix the names "rb-" and reference them from inline styles via the animation shorthand (e.g. animation: "rb-rise 700ms cubic-bezier(0.2,0.7,0.2,1) 120ms backwards"). Stagger with literal delays — no Math.random, no Date.
- Reduced motion is handled by the host; add no media queries.

${output}`;
};
