/**
 * The component/LEGO scene model — the schema the engine pivots to.
 *
 * A scene is a TREE of PIECES. A piece is a self-contained, independently
 * positioned, independently regeneratable unit. Composite pieces (a diegetic
 * mockup / panel / KPI cluster) may hold CHILD pieces, so the user can
 * regenerate the whole composite OR drill in and regenerate one child — both
 * levels — while each piece's source lives in its own file, which is the
 * structural guarantee that regenerating one piece cannot touch any other.
 *
 * GENERATION stays monolithic (the agent composes the whole scene in one pass —
 * that's where the validated richness comes from); it wraps each role in a
 * `<Piece>` sentinel. A deterministic decomposer (no LLM) then slices each
 * `<Piece>` body into its own file, hoists the shared design system into a
 * frozen `Theme`, and writes a `SceneManifest`. A deterministic assembler stitches
 * theme + manifest + piece files back into the exact `Composition.tsx` the
 * validated Remotion / preview / gate / MP4-reuse stack already consumes.
 *
 * See project memory `project_lego_component_pivot` for the why + the milestones.
 */

export type PieceKind =
  /** An editorial text stack (eyebrow→headline→lede→bullets→caption→meta) rendered
   *  as ONE flow column (preserves the "stacked text MUST flow" rule). Binds to
   *  script.scenes[K].content, so its text stays editable via the scene-content model. */
  | "text"
  /** A diegetic UI object — browser mock, chart, toggle panel, eligibility table,
   *  KPI cluster — however complex. MAY have `children` (its own sub-pieces). */
  | "diegetic"
  /** A standalone image (`<Img>`). */
  | "image"
  /** A full-bleed decorative layer (background glow, grain overlay). Up to two per
   *  scene so a glow can sit UNDER content and grain OVER it. Never content. */
  | "atmosphere"
  /** BrandChrome (logo, pagination). One per scene. */
  | "chrome";

/** Placement of a piece within its parent (the scene frame, or a composite piece),
 *  in absolute canvas px. Owned by the MANIFEST, never by the piece's own code —
 *  so a drag (reposition) is a pure manifest edit and a regen cannot move a piece. */
export interface Bounds {
  x: number;
  y: number;
  /** For `text` pieces, treat as a MAX width and let height flow (a wrapped headline
   *  must not be clipped by a frozen box — the defect the flow rule prevents).
   *  For diegetic/image/atmosphere, a fixed rect. */
  w: number;
  h: number;
  z: number;
}

export interface Piece {
  /** Stable within a scene. Composite children extend the parent id:
   *  "s2.panel", "s2.panel.card1". The render-time `data-piece-id` for hit-testing. */
  id: string;
  kind: PieceKind;
  /** Path (relative to the scene folder) of the piece's own .tsx, which
   *  default-exports `({ theme, content }) => JSX`. The unit of isolation. */
  file: string;
  bounds: Bounds;
  /** scene-content path this piece's text binds to (text pieces), e.g. the scene
   *  index whose `content` it renders. Lets text edits stay LLM-free. */
  contentRef?: string;
  /** Set when this piece is (part of) the cross-scene throughline motif. The
   *  assembler co-locates this attribute AND literal px bounds on the same wrapper
   *  so the presence + drift gates still see it. */
  throughlineSlug?: string;
  /**
   * INTENTIONAL BLEED / OVERHANG — this piece is DESIGNED to paint outside its
   * declared box (a toast overhanging a modal edge, a card breaking its column,
   * a shape running off-frame). The box-enforcement pass (assemble.ts, gated on
   * `RB_ENFORCE_BOX`) never clips a piece that declares this.
   *
   * Deliberate layering is a feature and shows up in our best frames, so
   * clipping has to be opt-OUT-able. Note what this does and does not cover:
   * an overhang BETWEEN two elements INSIDE one piece (the Razorpay s2
   * "Payment Successful" toast over its modal) needs no flag at all — clipping
   * is applied at the PIECE wrapper, and both the modal and the toast are
   * descendants of the same hero piece, so their mutual overlap is untouched.
   * This flag is only for a piece whose painted content leaves ITS OWN box.
   *
   * Nothing authors it yet — the composition head is not prompted for it — so
   * it is the mechanism, not the policy. Ship the policy with the head change
   * that populates it.
   */
  bleed?: boolean;
  /**
   * TEXT pieces only. A precomputed shrink-to-fit factor in (0,1]: the assembler
   * emits `transform: scale(fitScale)` with a compensating width so an over-long
   * headline renders SMALLER instead of growing past its box. 1 / undefined ⇒
   * no downscale.
   *
   * Precomputed rather than measured at runtime on purpose. `@remotion/
   * layout-utils`' `fitText` was the suggested tool and cannot be used in this
   * path (see cast-build's fit computation): the composition is rendered with
   * `renderToStaticMarkup` in two load-bearing places — the SSR gate and
   * measure-scene — where there is no DOM to measure in, so a runtime fit would
   * make the measured frame disagree with the MP4, and measure-scene IS the
   * render-truth gate. The capacity engine (lib/render/capacity.ts) already
   * predicts wrapped line counts in pure Node from calibrated font metrics, so
   * the factor is derived there and baked into the CSS.
   */
  fitScale?: number;
  /** Composite pieces only: nested, independently-editable sub-pieces. Absent ⇒ a leaf. */
  children?: Piece[];
}

export interface SceneManifest {
  scene: number;
  /** Theme token ref or literal color for the scene canvas. */
  background: string;
  /** Ordered (paint order). A piece may nest `children`. */
  pieces: Piece[];
}

/**
 * The frozen, de-entangled design system shared by every piece in a build. This
 * REPLACES the module-scope const entanglement of the monolithic model and is the
 * cohesion mechanism: a regenerated piece reads the same theme — including the
 * design GRAMMAR, not just tokens — so it echoes the scene's look by construction.
 * Emitted once as theme.json + a generated `Object.freeze`d theme.ts; never
 * rewritten by a piece regen (no shared symbol to mutate).
 */
export interface Theme {
  /** ink, accent, canvas, panelBg, hairline, … — the de-entangled PALETTE consts. */
  palette: Record<string, string>;
  fonts: {
    display: string;
    body: string;
    mono: string;
    /** @font-face / @import CSS injected once per Section so a standalone-mounted
     *  Section (preview SSR + measure) carries its own fonts. */
    fontFaceCss: string;
  };
  /** Shared `@keyframes` source. The decomposer namespaces these per piece at
   *  assembly (drift1 → p3_drift1) while keeping `${token}` interpolations valid. */
  keyframes: string;
  /** The design GRAMMAR — what makes independently-coded pieces still cohere.
   *  Without this in the theme, piece-coders re-improvise radius/stroke/shadow and
   *  the output regresses to an "assembled-from-a-kit" look. */
  grammar: {
    /** Allowed corner radii, smallest→largest (e.g. [8, 12, 16]). */
    radiusScale: number[];
    /** Default hairline/border stroke weight in px. */
    strokeWeight: number;
    /** Hairline/border color token. */
    hairline: string;
    /** Panel/card surface background token. */
    panelBg: string;
    /** The shared shadow recipe, e.g. "0 30px 80px rgba(0,0,0,0.4)". */
    shadowRecipe: string;
    /** The role convention: which font carries DATA vs prose ("mono for data"). */
    dataFont: "mono" | "body";
  };
}
