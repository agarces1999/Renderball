/**
 * Script JSON schema — V1 (2026-05-28 cleanup pass).
 *
 * Contract between Agent 1 (Script Generator) and the rendering
 * pipeline (Design Agent + Choreography Agent + wrapper + Remotion
 * renderer). After this cleanup the schema only carries fields the
 * current architecture actually populates and consumes — the V0.1
 * element-based types are gone, along with QA / SFX / video-asset
 * scaffolding that was never wired up.
 *
 * If you add a new field, also add it to lib/agents/schema-validator.ts
 * so Agent 1 outputs are validated against the type.
 */

// ─── Identity & top-level ─────────────────────────────────────────────

type ScriptStatus =
  | "draft"
  | "approved"
  | "rendering"
  | "rendered"
  | "delivered"
  | "archived";

export type VoicePreset =
  | "Avery"
  | "Iris"
  | "Marcus"
  | "Nova"
  | "Hollis"
  | "Reese"
  | "Edmund"
  | "Imogen";

export interface Script {
  id: string; // ulid
  customer_id: string;
  brand_kit_id: string | null;
  created_at: string; // ISO 8601
  schema_version: "1.0";

  // Stage 0 — customer inputs
  brief: {
    purpose: string;
    about: string;
    cta: string;
    source_assets?: string[]; // S3 URIs
  };

  /**
   * The story spine the whole piece follows. Agent 1 designs this FIRST
   * — before any section — then stages each section as a move within
   * it. This is what makes the rendered frontend read as ONE narrative
   * (tension that builds, a turn, a payoff) rather than a deck of
   * disconnected sections.
   *
   * Threaded to the Design Agent at build time so the composition
   * reinforces the arc + recurring motif across sections. Optional for
   * back-compat with scripts generated before this field existed;
   * new Agent 1 output always populates it.
   */
  narrative?: {
    /** One sentence: who it's for, the tension, the transformation. */
    logline: string;
    /**
     * How the story moves across the sections — the shape of tension
     * and release. e.g. "Open on the cost of the status quo, escalate
     * the friction, turn on the product as the unlock, prove it in
     * use, resolve on the invitation."
     */
    arc: string;
    /**
     * A recurring motif that threads the sections into one story — a
     * visual object, a phrase that recurs and evolves, a number that
     * grows, a color that shifts from cold to warm. Optional.
     */
    throughline?: string;
  };

  // Agent inferences, user-overridable at the script gate.
  config: {
    duration_seconds: number; // 5–60 (capped to keep render cost predictable + dead-air rules satisfiable)
    aspect_ratio: "16:9" | "9:16" | "1:1";
    resolution: "1080p" | "4k";
    tone: string;
    pacing: "fast" | "medium" | "slow";
    /** @deprecated kept transiently for migration; not used. */
    fps?: 30;
    /**
     * Document kind (canvas pivot, docs/PIVOT.md). "deck" = a static
     * multi-page design document: scenes are pages, choreography is skipped
     * at build time, scene timings are inert metadata, export is PDF/PNG.
     * Absent or "video" = the legacy animated pipeline, unchanged.
     */
    kind?: "video" | "deck";
  };

  /**
   * Audio plan. The voiceover + music are populated by Agent 1 as
   * placeholders for future TTS / music-library integration. The
   * renderer doesn't currently consume them — they survive on the
   * script for when Task 10 (VO + music) lands.
   */
  audio: {
    voiceover: {
      voice_preset: VoicePreset;
      script: string; // full VO text
      language: "en-US" | "en-GB";
    } | null;
    music: {
      source: "library" | "uploaded";
      asset_id: string;
      mood_tags: string[];
      license: string;
      volume_db: number;
    } | null;
    /** Always empty in V1; reserved for future SFX cues. */
    sfx: never[];
  };

  /**
   * Asset manifest. Only `fonts` + `images` are consumed by the
   * current pipeline; audio + videos arrays survive as `never[]`
   * placeholders for Task 10.
   */
  assets: {
    fonts: FontAsset[];
    images: ImageAsset[];
    audio: never[];
    videos: never[];
  };

  scenes: Scene[];

  /**
   * Uncertainty checkpoint (doctrine 2026-07-14: "ask the user whenever
   * there is uncertainty" — batched here, never mid-build). When the brief
   * leaves a genuinely consequential choice open, Agent 1 records it as a
   * decision with a working ASSUMPTION so generation never blocks; the
   * /review story screen surfaces the batch and the user confirms or
   * overrides before the expensive build. Resolved answers are threaded
   * into the build input. Optional for back-compat; empty means the brief
   * was unambiguous.
   */
  decisions?: ScriptDecision[];

  status: ScriptStatus;
  approved_at?: string;
}

/**
 * Per-scene COMPOSITION SPEC — the blueprint layer of the cast doctrine
 * (2026-07-16). The parity audit measured that the fast emitter transcribes
 * explicit inventories at reference quality but invents poorly; so ALL
 * invention moves upstream: a thinking head authors, per scene, exactly what
 * each element is and what lives inside it, with real brand/scene-specific
 * values. Element generation then embeds the inventory verbatim — the model
 * furnishes what the spec names, never template examples. Optional for
 * back-compat: scenes without a spec fall back to visual_concept-driven
 * briefs.
 */
/** Head-authored pixel bounds on the scene's aspect canvas (frame-authoring,
 *  2026-07-17). w/h are the wrapper's rendered size; for text elements w is a
 *  MAX width and height flows (mirrors piece-model.Bounds). */
export interface ElementBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ElementSpec {
  /** Which cast slot this describes: hero | copy | atmosphere | connector | throughline. */
  role: string;
  /** What the element IS, concretely ("a Duolingo lesson screen in a phone frame"). */
  subject: string;
  /**
   * The interior inventory — SHORT concrete items the element must visibly
   * contain, with real values authored for THIS brand and scene ("XP bar
   * 340/500", "streak flame '7'", "chips: días / noches"). Heroes need ≥6;
   * generation transcribes these, it does not invent them.
   */
  interior: string[];
  /** Scene.content fields this element exclusively renders (ownership). */
  ownsCopy?: string[];
  /** One sustained motion beat tied to a named interior item. */
  motion?: string;
  /**
   * FOCAL RANK (frame-authoring, 2026-07-17): 1 = the dominant focal object,
   * near optical center; ascending integers = progressively subordinate.
   * Exactly one element per composed scene carries rank 1 — the head reasons
   * about the WHOLE frame's hierarchy here instead of leaving placement to a
   * content-blind table. Atmosphere carries none (it is the base layer).
   */
  focalRank?: number;
  /**
   * HEAD-AUTHORED PIXEL BOUNDS (frame-authoring, 2026-07-17) on the scene's
   * aspect canvas (1920×1080 @16:9, 1080×1920 @9:16, 1080×1080 @1:1). The
   * composition head PLACES every element so the whole frame is composed — one
   * dominant focal object near optical center, deliberate negative space, mass
   * distributed to fill the frame (no corner-clustering). layout-composer
   * CONSUMES these bounds (it no longer authors geometry from a blind table)
   * and validates them; the element cast mounts the leaf into this exact rect,
   * and the LEGO editor's move/resize edits this field + re-runs the validator
   * (0 LLM). Optional for back-compat: atmosphere is full-bleed, and stored /
   * un-composed scenes fall back to the deterministic layout table.
   */
  bounds?: ElementBounds;
}

/** The per-frame SINGULARITY budget (frame-authoring, 2026-07-17): exactly ONE
 *  brand mark and ONE CTA per scene, each naming WHICH element owns it — a role
 *  ("hero"/"copy"), "chrome" for the corner brand lockup, or "none" when the
 *  scene carries neither. Prevents the duplicate-brand-pill / competing-CTA
 *  defects the reference never has. */
export interface FrameBudget {
  brandMark: string;
  cta: string;
}

export interface SceneComposition {
  elements: ElementSpec[];
  /** The atmosphere treatment for THIS scene — must differ from adjacent scenes. */
  atmosphere: string;
  /**
   * The NEGATIVE-SPACE plan (frame-authoring, 2026-07-17): a sentence naming
   * WHERE the deliberate emptiness lives, so the frame breathes around its
   * focal object the way the reference does — the distinction between intended
   * air and the dead-void corner-clustering defect.
   */
  negativeSpace?: string;
  /** The per-frame singularity budget (see FrameBudget). */
  budget?: FrameBudget;
}

export interface ScriptDecision {
  /** Stable kebab-case slug, unique within the script (e.g. "audience-focus"). */
  id: string;
  /** The plain-English question the user is being asked. */
  question: string;
  /** Why this was uncertain — one sentence of context from the brief/crawl. */
  context?: string;
  /** 2–4 concrete choices. The FIRST is the agent's working assumption. */
  options: string[];
  /** The user's answer (one of options, or free text). Unset = assumption stands. */
  resolved?: string;
}

// ─── Assets ───────────────────────────────────────────────────────────

export interface FontAsset {
  id: string;
  family: string;
  weights: number[];
  styles: ("normal" | "italic")[];
  src: string;
  format: "woff2" | "woff" | "ttf" | "otf";
  fallback_chain: string[];
  license_id: string;
  preload: true;
}

export interface ImageAsset {
  id: string;
  src: string;
  width: number;
  height: number;
  format: "png" | "jpg" | "webp" | "svg";
  alt_text?: string;
  license_id: string;
}

// ─── Scenes ───────────────────────────────────────────────────────────

/**
 * The deliberate visual "shape" of a scene, assigned by the Script Agent to
 * force variety across the sequence so consecutive scenes don't all wear the
 * same editorial template (the repetition the non-tech pilot exposed). The
 * Design Agent maps each register to a distinct layout archetype.
 */
type SceneRegister =
  | "stat" // one massive number/metric, minimal supporting copy
  | "quote" // a pull-quote / manifesto line, centered, large
  | "full-bleed" // edge-to-edge imagery or color field with overlaid text
  | "split" // asymmetric left/right (text vs visual)
  | "list" // a real list of points / steps / features
  | "centered"; // classic centered headline + lede (the current default)

export interface Scene {
  id: string; // ulid
  index: number; // 0-based
  label: string; // human-readable, short (2-6 words)
  /**
   * One-sentence intent for this scene — what idea it conveys, not
   * the on-screen text. In manual mode this is the user's
   * `moments[i].description` verbatim. In auto/freeform mode the
   * agent writes it as part of script generation.
   */
  description?: string;
  /**
   * The visual concept the agent CHOSE for this moment. Two-part
   * brief: a Composition sentence (what's on the page) followed by
   * an Animations list (each entry = element + animation name +
   * timing in seconds).
   *
   * Example: "Composition: split layout with a VS-Code-style IDE on
   * the left and a terminal panel on the right. ... Animations: IDE
   * fadeRise at 0s duration 0.8s. Code lines typewriter-reveal from
   * 1s with 0.15s stagger. ..."
   */
  visual_concept: string;
  /**
   * The deliberate visual shape for this scene. The Script Agent assigns it
   * to vary the sequence; the Design Agent maps it to a layout archetype.
   * Optional for back-compat; defaults to "centered" when absent.
   */
  register?: SceneRegister;
  /**
   * The composition blueprint (see SceneComposition) — authored by the
   * thinking head at build time, consumed by the element cast. Optional:
   * absent on stored/approved scripts until the composition pass runs.
   */
  composition?: SceneComposition;
  /**
   * The content manifest — every named copy slot a viewer reads, plus
   * the assets and illustration intent the section incorporates.
   *
   * The Design Agent maps each field to a specific layout slot:
   * eyebrow above, headline next, lede below, bullets as a list,
   * meta as a footer grid OR KPI tile grid when numeric.
   */
  content: {
    /** Optional small uppercase category label (e.g. "THE LEGACY TRAP"). */
    eyebrow?: string;
    /** The hero text. REQUIRED. ≤80 chars. */
    headline: string;
    /** 1-2 sentence supporting paragraph that establishes context. ≤240 chars. */
    lede?: string;
    /** 2-4 supporting points rendered as a <ul><li>. Each ≤80 chars. */
    bullets?: string[];
    /** Small support text under primary content. ≤100 chars. */
    caption?: string;
    /** Footer key-value pairs OR KPI tiles when values are numeric. */
    meta?: { label: string; value: string }[];
    /** CTA copy for the closing section. */
    cta?: { primary: string; secondary?: string };
    /**
     * Inline-SVG illustration intent. Design Agent renders a matching
     * SVG from its codified library. Freeform descriptors allowed.
     */
    illustration?:
      | "checkmark"
      | "arrow-flow"
      | "lock"
      | "gear"
      | "concentric-rings"
      | "phone-mockup"
      | "browser-tab"
      | "code-window"
      | "dashboard-grid"
      | "stat-counter"
      | "line-chart"
      | "bar-chart"
      | "sparkline"
      | "data-waterfall"
      | (string & {});
    /** Image asset refs to mount with <Img>. Resolve via script.assets.images. */
    asset_ids: string[];
    /** @deprecated kept for legacy scripts; new scripts use the typed fields above. */
    texts?: string[];
  };
  /** When this section starts in the timeline, measured in seconds from t=0. */
  start_seconds: number;
  /** When this section ends in the timeline, in seconds from t=0. */
  end_seconds: number;
  /** @deprecated migration-only; wrapper converts seconds → frames. */
  start_frame?: number;
  /** @deprecated migration-only. */
  end_frame?: number;
  /**
   * Set by the per-scene regenerate endpoint. Lets downstream callers
   * track which scenes have been touched since the last full build.
   */
  regenerated_at?: string;
}
