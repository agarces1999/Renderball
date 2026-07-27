/**
 * A blank document — the thing that makes "new document" open an EDITOR
 * instead of a form.
 *
 * WHY THIS EXISTS. Creating a document used to mean: fill in a brief, satisfy
 * a brand-kit gate (a logo was mandatory), wait ~60s and pay tokens for an
 * outline, approve it on a second page, then pay ~$1 and wait minutes for a
 * build — four surfaces and two paid steps before you ever saw a canvas. The
 * landing promises the opposite ("draw a box, say what belongs inside it"), so
 * the first thing after sign-in contradicted the pitch.
 *
 * The unlock is that a *valid* composition does not need a model. The design
 * agents' output has a fixed shape — a preamble of brand constants, then
 * `export const SectionN` wrapping `<Piece>` markers — and `Piece` is our own
 * shim, not something the model invents. So a blank document can be
 * synthesized deterministically: ZERO tokens, no gate, instant.
 *
 * What that buys architecturally: the editor never needs a "no document yet"
 * mode. A blank document is a real document with a real composition, so
 * rendering, the lego decomposition, undo, brand re-skin, export and
 * marquee-to-generate all work on it from the first second, with no special
 * cases anywhere downstream.
 *
 * Generation then becomes something you do FROM the canvas — the whole deck,
 * or one element at a time — rather than a toll gate in front of it.
 */
import { promises as fs } from "fs";
import path from "path";
import type { Script } from "../../src/schema";
import { writeGeneratedFiles } from "../render/build-wrapper";

/** A blank page is still a page: give it the canvas the brand system expects. */
const BLANK_PREAMBLE = `import React from "react";
import type { Script } from "../schema";
import { Piece } from "./Piece";

// Brand constants. These are the SAME names the design agents emit, so the
// brand panel's deterministic re-skin (lib/brand/reskin.ts) works on a blank
// document exactly as it does on a generated one.
const PALETTE = {
  accent:  "#00c28a",
  canvas:  "#ffffff",
  ink:     "#10141c",
  muted:   "#69707e",
  surface: "#f5f7f9",
  line:    "#e4e8ee",
};
const FONT_DISPLAY = \`"Geist", system-ui, sans-serif\`;
const FONT_BODY    = \`"Geist", system-ui, sans-serif\`;
const FONT_MONO    = \`"Geist Mono", ui-monospace, monospace\`;
const BRAND_FONTS_CSS = \`\`;
`;

/**
 * One empty page.
 *
 * Deliberately NOT literally empty: it carries a single `<Piece>` so the lego
 * decomposition has something to hold, and a faint centred hint so a new user
 * sees an invitation rather than a void. Both are ordinary editable elements —
 * the hint can be selected and deleted like anything else, and the first real
 * element the user draws sits beside it.
 */
const blankSection = (index: number): string => `
export const Section${index}: React.FC<{ script: Script }> = () => (
  <div style={{ position: "absolute", inset: 0, background: PALETTE.canvas, fontFamily: FONT_BODY }}>
    <Piece id="s${index}.hint" kind="text">
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          transform: "translate(-50%, -50%)",
          textAlign: "center",
          color: PALETTE.muted,
          fontFamily: FONT_MONO,
          fontSize: 28,
          letterSpacing: "0.04em",
        }}
      >
        draw a box to make something
      </div>
    </Piece>
  </div>
);
`;

/** The full composition source for a blank document of `pages` pages. */
export const blankCompositionSource = (pages: number): string =>
  BLANK_PREAMBLE +
  Array.from({ length: Math.max(1, pages) }, (_, i) => blankSection(i)).join("\n");

/** Seconds each deck page occupies on the notional timeline. */
const PAGE_SECONDS = 5;

/** A minimal LEGAL script — the same shape the pipeline produces, minus content. */
export const blankScript = (scriptId: string, pages = 1): Script =>
  ({
    id: scriptId,
    brand_kit_id: null,
    config: {
      kind: "deck",
      aspect_ratio: "16:9",
      duration_seconds: Math.max(1, pages) * PAGE_SECONDS,
    },
    scenes: Array.from({ length: Math.max(1, pages) }, (_, i) => ({
      id: `${scriptId}-s${i}`,
      index: i,
      label: `Page ${i + 1}`,
      description: "",
      visual_concept: "",
      start_seconds: i * PAGE_SECONDS,
      end_seconds: (i + 1) * PAGE_SECONDS,
      content: {},
    })),
  }) as unknown as Script;

/**
 * Materialise a blank document on disk: composition, shims, script.json — the
 * exact layout a built document has, so nothing downstream needs to know the
 * difference. Also publishes it, so the document survives a redeploy from the
 * moment it is created rather than only after its first edit.
 */
export const writeBlankDocument = async (
  scriptId: string,
  pages = 1,
): Promise<{ genDir: string; script: Script }> => {
  const genDir = path.join(process.cwd(), "src", "generated", scriptId);
  const script = blankScript(scriptId, pages);
  const code = blankCompositionSource(pages);

  await fs.mkdir(genDir, { recursive: true });
  await writeGeneratedFiles(genDir, {
    // The design file is the same source for a blank document — there is no
    // separate "design" pass to diverge from yet.
    designCode: code,
    code,
    script,
    warnings: {},
  });

  return { genDir, script };
};

/** True when this document has never been generated into — i.e. every page is
 *  still the untouched blank. Drives the editor's empty state. */
export const isBlankScript = (script: Script | null | undefined): boolean =>
  !!script &&
  script.scenes.length > 0 &&
  script.scenes.every((s) => !s.visual_concept && !s.description);
