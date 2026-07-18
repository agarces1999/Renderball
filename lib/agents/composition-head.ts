/**
 * COMPOSITION HEAD — the thinking head of the cast doctrine (2026-07-16).
 *
 * The parity audit measured the split: the fast emitter TRANSCRIBES explicit
 * inventories at reference quality but INVENTS poorly (template-example
 * leakage, duplicated headlines, thin interiors). So all invention moves
 * upstream to this one call: per scene, the head authors exactly what each
 * element IS and what lives inside it — real brand/scene-specific values,
 * explicit copy ownership, one motion beat per element — and the element cast
 * (cast-build.ts) embeds that blueprint verbatim in its briefs. "Think at the
 * head, emit at the leaves", with the thinking now written down as a contract
 * (src/schema.ts ElementSpec / SceneComposition) instead of hoped for at the
 * leaves.
 *
 * This module is a pure, testable leaf (same posture as layout-composer):
 *   - the TRANSPORT is injected (`caller` — production passes castCall),
 *   - the VALIDATOR is injected (`validate` — the composition checks live in
 *     schema-validator.ts and arrive by injection, keeping this module free
 *     of that dependency),
 *   - no I/O, no SDK, no env reads.
 *
 * Failure posture: validation errors are repair-retried with the errors
 * quoted verbatim; a terminal validation failure RETURNS the last attempt's
 * scenes plus the error log (the caller decides the fallback — un-composed
 * scenes still build via the generic-brief path). Only
 * unparseable-after-retries throws: with no parseable output there is nothing
 * to degrade to, and that is a head/transport defect, not a taste problem.
 */
import type { Script, Scene, SceneComposition } from "../../src/schema";

// ─── Canvas (frame-authoring) ────────────────────────────────────────────────
// Mirrors CANVAS in layout-composer.ts / measure-scene.ts — the head authors
// PIXEL bounds, so it must know the target canvas. Mirrored, not imported, to
// keep this a pure dependency-free leaf (the same doctrine layout-composer
// applies to CANVAS_DIMS). The values are the fixed product canvases.

export type Aspect = "16:9" | "9:16" | "1:1";

export const HEAD_CANVAS: Record<Aspect, { w: number; h: number }> = {
  "16:9": { w: 1920, h: 1080 },
  "9:16": { w: 1080, h: 1920 },
  "1:1": { w: 1080, h: 1080 },
};

const normalizeAspect = (a: string | undefined): Aspect =>
  a === "9:16" || a === "1:1" ? a : "16:9";

// ─── Public contract ────────────────────────────────────────────────────────

export interface CompositionPromptOpts {
  /** The brand the video is for — anchors "authored for THIS brand". */
  brandName?: string;
  /** One line describing the palette (hexes/mood) so interior values can name
   *  on-brand treatments ("pay button in the coral accent"). */
  paletteHint?: string;
  /** Free-form design-language notes threaded from the crawl/theme step. */
  designNotes?: string;
  /** The target canvas (frame-authoring): the head authors pixel bounds on
   *  this canvas. Default "16:9" (1920×1080). */
  aspect?: Aspect;
}

/** The one call shape the head makes. Structurally compatible with
 *  cast-provider's CastCall — production passes `castCall` directly. */
export interface CompositionHeadCall {
  system: string;
  user: string;
  maxTokens: number;
  effort: "none" | "low" | "medium" | "high";
}

export type CompositionCaller = (call: CompositionHeadCall) => Promise<{ text: string }>;

export interface GenerateCompositionOpts extends CompositionPromptOpts {
  script: Script;
  /** Injected transport (production: castCall). Only `text` is consumed. */
  caller: CompositionCaller;
  /** Injected validator (schema-validator's composition checks). Receives the
   *  scenes WITH compositions attached; returns human-readable errors, empty
   *  when clean. */
  validate?: (scenes: Scene[]) => string[];
  /** Total attempts including the first (default 3). */
  maxAttempts?: number;
}

export interface GenerateCompositionResult {
  /** script.scenes (copies — the input script is never mutated) with
   *  `composition` attached per scene. On terminal validation failure these
   *  are the LAST attempt's scenes — the caller decides the fallback. */
  scenes: Scene[];
  /** Attempts actually made (1 = clean first pass). */
  attempts: number;
  /** Every error across all attempts, prefixed `attempt N:`. Empty means the
   *  returned scenes validated clean. */
  errors: string[];
}

// ─── Call shape ─────────────────────────────────────────────────────────────

/**
 * The head THINKS — this is the ONE call in the cast path where thinking is
 * the point, so it gets effort "high" (gpt-oss's real dial; on GLM-wire
 * callers the field is a no-op, which is fine) and a ceiling sized for a full
 * multi-scene blueprint plus reasoning.
 *
 * 28000, not 16000 (acceptance v6 + Fireworks-gains audit, 2026-07-16): at
 * 16k the v6 Klarna head TRUNCATED attempts 1 and 2 at exactly the cap
 * (reasoning + 5-scene blueprint overflow), burning two full repair rounds on
 * a ceiling artifact. 28k covers the measured reasoning+emission shape with
 * honest headroom (Cerebras pre-debits this against TPM, so it is sized, not
 * lazy).
 */
export const HEAD_MAX_TOKENS = 28000;
export const HEAD_EFFORT = "high" as const;

// ─── The prompt ─────────────────────────────────────────────────────────────

/**
 * ONE compact worked example, deliberately for an UNRELATED brand (a fictional
 * coffee-subscription app) so no example value can pass as this script's
 * content. The system prompt brands it ILLUSTRATIVE and names copying a
 * validation failure — the template-example leakage defect, made a stated
 * contract violation instead of an accident waiting to happen.
 *
 * Exported so tests can assert the example COMPLIES with the contract the
 * prompt states (retry audit class 9: the prompt's own exemplar must pass the
 * validator it advertises — hero text-bearing floor, no owned-copy retyping).
 */
export const WORKED_EXAMPLE = JSON.stringify(
  [
    {
      elements: [
        {
          role: "hero",
          subject: "the Brewline mobile checkout screen in a rounded phone frame",
          focalRank: 1,
          bounds: { x: 980, y: 170, w: 560, h: 760 },
          interior: [
            "cart panel on a crisp off-white surface, charcoal ink — bright against the roast-brown canvas",
            'order row "Colombia Huila 12oz — $18.50" inside the cart panel',
            'delivery chip "Ships Thursday, Feb 12"',
            'subscription toggle ON, labeled "Every 2 weeks"',
            'price line "Subtotal $18.50 · Shipping FREE"',
            'pay button "Pay $18.50" in the accent',
            'loyalty banner "340 beans — 160 to a free bag"',
          ],
          ownsCopy: [],
          motion: 'the "Pay $18.50" button fills with the accent as the delivery chip settles into place',
        },
        {
          role: "copy",
          subject: "the editorial stack left of the phone: eyebrow, headline, lede",
          focalRank: 2,
          bounds: { x: 150, y: 250, w: 620, h: 520 },
          interior: ["eyebrow line in mono caps", "headline in display type", "lede at reading size beneath"],
          ownsCopy: ["eyebrow", "headline", "lede"],
          motion: "the headline rises as one block, then holds",
        },
        {
          role: "atmosphere",
          subject: "a warm roast-brown field behind everything",
          interior: ["radial glow upper-left", "drifting steam wisps", "fine film grain"],
          ownsCopy: [],
          motion: "the steam wisps drift upward on an 11s loop",
        },
      ],
      atmosphere: "warm roast-brown radial wash, steam wisps drifting upward through fine grain",
      negativeSpace:
        "the lower third and the wide gutter between the editorial column and the phone stay open, so the checkout reads as the one focal object with air around it",
      budget: { brandMark: "chrome", cta: "hero" },
    },
  ],
  null,
  1,
);

/**
 * Build the head's prompt pair. The SYSTEM carries the contract (what a
 * blueprint must contain, and the output shape); the USER carries this
 * script's actual material (brand, narrative, every scene's content manifest).
 */
export const buildCompositionPrompt = (
  script: Script,
  opts: CompositionPromptOpts = {},
): { system: string; user: string } => {
  const aspect = normalizeAspect(opts.aspect);
  const { w: W, h: H } = HEAD_CANVAS[aspect];
  const cx = Math.round(W / 2);
  const cy = Math.round(H / 2);
  const system = [
    `You are the COMPOSITION DIRECTOR for an animated brand video — for each scene, you author the complete blueprint the builders will transcribe, AND you COMPOSE THE WHOLE FRAME (every element's place on the canvas).`,
    `The builders downstream are fast literal transcribers: whatever you do not author, they will not invent well. Every creative decision lands HERE, as concrete values. No one else composes the frame — if you cluster the mass in a corner and leave a dead void, that is exactly what ships.`,
    ``,
    `FRAME COMPOSITION — the canvas is ${W}×${H}px (origin top-left). Compose it like a senior art director, the way a premium launch frame (Apple, Linear, Stripe) is composed, NOT like a form dumped in a column:`,
    `- ONE DOMINANT FOCAL OBJECT. Exactly one element is the hero the eye lands on first — usually the diegetic hero (a product screen, dashboard, device mock). Give it focalRank 1 and place it LARGE and near the OPTICAL CENTER (around ${cx},${cy} — its center within the central ~64% of the frame width and ~68% of its height, never jammed into a corner). Everything else is subordinate: focalRank 2, 3, … in descending prominence.`,
    `- DELIBERATE NEGATIVE SPACE. The frame must BREATHE — name, in negativeSpace, WHERE the intentional emptiness lives (a quiet band, a margin, the gutter beside the focal object). This is the opposite of the dead-void defect: emptiness is a COMPOSED choice around the focal object, not a corner-clustered accident with a huge blank middle.`,
    `- MASS FILLS THE FRAME. Distribute the elements so the whole canvas reads as composed — no element pushed to one corner while two-thirds of the frame sits empty. A subordinate copy stack, a footer meta strip, a chrome band, floating chips: use them to balance the focal object, not to crowd it.`,
    `- ONE GRID / CARD SYSTEM per scene: pick a single spatial system (a two-column split, a centered stack, a card-over-field) and place every element on it. Do not mix incompatible systems in one frame.`,
    `- SINGULARITY BUDGET: exactly ONE brand mark and ONE CTA per scene. In budget, name WHICH element owns each: a role ("hero"/"copy"), "chrome" for the corner brand lockup, or "none" when the scene carries neither. Never let two elements both render a brand pill or a call-to-action — duplicate brand marks and competing CTAs are the single loudest "AI slop" tell.`,
    `- THE CORNER LOCKUP IS ALWAYS PROVIDED. The app paints ONE clean brand lockup in the frame's TOP-LEFT corner on every scene automatically — you do NOT author it, and it is the scene's single brand mark by default (set budget.brandMark to "chrome"). Therefore NEVER author a brand logo, wordmark, or brand-name mark in the frame's upper-left, and never name "the [brand] logo upper-left" in any element's interior — it collides with the provided corner lockup and ships as a garbled double wordmark. A brand mark may appear inside a hero ONLY as diegetic product chrome INSIDE a device/app mock (a small logo in the mock's own sidebar or header), placed well clear of the frame's own top-left corner. If you truly need the mark on a role instead of the chrome, that role must place it away from the top-left corner and you must NOT also expect the corner lockup — but "chrome" is the right answer for almost every scene.`,
    ``,
    `PER-ELEMENT PLACEMENT: every non-atmosphere element carries a focalRank AND real pixel bounds { x, y, w, h } inside the ${W}×${H} canvas. Bounds must be DISJOINT (no two content elements overlap) unless the scene is a full-bleed treatment where the hero IS the canvas and copy sits on top. Keep a comfortable margin from every edge (nothing flush to the frame edge). The text (copy) element's w is a MAX width — its height flows. atmosphere is the full-bleed base layer and needs no bounds/focalRank.`,
    ``,
    `FOR EVERY SCENE, author:`,
    `1. elements[] — one entry per element the scene needs, each on this contract:`,
    `   - role: one of "hero" | "copy" | "atmosphere" | "connector" | "throughline".`,
    `     hero = the diegetic visual (a product screen, dashboard, chart, device mock — the thing the scene shows).`,
    `     copy = the editorial text stack.`,
    `     atmosphere = the full-bleed decorative base layer.`,
    `     connector = a full-bleed SVG relationship system — cast it ONLY when the scene's concept is genuinely relational (flow, network, convergence, scatter).`,
    `     throughline = the recurring cross-scene motif — cast it in EVERY scene when the script's narrative names a throughline. CRITICAL: the throughline is NOT a free-floating pinned layer hovering in empty space. Author its bounds so they sit ON the focal object — INSIDE or overlapping the hero's bounds (a status chip inside the product mock, a marker on the chart, a labeled slot within the hero panel), the way the motif lives as a real element of the scene rather than a sticker in the void. A throughline whose bounds land in the frame's negative space, disconnected from all content, ships as clutter and gets stripped (which can empty the scene). Keep it small, integrated, and on-content.`,
    `   - subject: what the element IS, concretely. Name the artifact ("the Acme billing dashboard in a browser frame"), never a vague gesture ("some UI", "a visual").`,
    `   - focalRank: the element's place in the frame's focal hierarchy — 1 for the single dominant focal object (near optical center), 2, 3, … descending. Exactly ONE element per scene is focalRank 1. (atmosphere carries none.)`,
    `   - bounds: { x, y, w, h } in pixels on the ${W}×${H} canvas — where this element sits and how big it is. The focalRank-1 element is LARGE and near center; content elements are pairwise DISJOINT; nothing flush to an edge. (atmosphere carries none — it is full-bleed.)`,
    `   - interior: the interior inventory — SHORT concrete items the element must visibly contain. A hero needs AT LEAST 6, and AT LEAST 4 of a hero's items must CARRY TEXT — quoted micro-copy or a concrete value (a chip, timestamp, label, price, metric: 'status chip "Rendering — 5 of 8"'); a text-free logo/glow/CTA-shape inventory renders a hollow scene and is a validation failure. The inventory should imply NESTED structure (rows inside panels, chips inside rows), never six floating fragments. SURFACE CONTRAST: one hero interior item must NAME the hero's dominant surface tone, chosen to CONTRAST with the scene canvas — if the scene canvas is dark, the hero's primary panel must be a light surface or carry high-luminance content ("checkout card on a crisp off-white surface"); if the canvas is light, a dark or richly saturated surface. A hero painted in the canvas's own tone renders as a washout and is a validation failure. EVERY item carries a REAL value authored for THIS brand and THIS scene — a label, number, name, timestamp, or state drawn from (or plausibly extending) this script's content. Plausible diegetic mock values (a price, balance, timestamp inside the product's own UI) are set dressing, not marketing claims — author them concrete and realistic. NEVER sample, masked, or placeholder values ("$XX", "$— — —", "•••", "Item 1", "Company name", lorem) — the builders ship your values verbatim, so a placeholder here ships as a placeholder on screen. Describe the copy widget CONCRETELY — "headline set in display type", "eyebrow line in mono caps" — NEVER with the word "placeholder" (an interior item containing "placeholder" ships that word on screen and is a validation failure). And interior items must NEVER contain the text of any copy field an element ownsCopy — the owning element renders those words exactly once; reference the WIDGET, not the words ("the CTA pill in the accent", never the CTA's text). A validator rejects interiors that retype owned copy.`,
    `   - ownsCopy: the scene content fields (eyebrow, headline, lede, bullets, caption, meta, cta) this element EXCLUSIVELY renders. Be explicit on every element — an empty array means it owns nothing. Ownership is exclusive: no field appears on two elements, and the headline is owned EXACTLY once per scene. An owned field's TEXT lives only in the owner's render — no interior[] item anywhere in the scene may restate it.`,
    `   - motion: ONE sustained motion beat, tied BY NAME to an item in that element's interior list ("the progress bar fills to 62% as the status chip ticks over").`,
    `2. atmosphere — this scene's atmosphere treatment in at least 6 words. It MUST differ from the adjacent scenes' treatments: vary the mechanism (wash vs bands vs rays vs grain), not just the adjective.`,
    `3. negativeSpace — one sentence (≥4 words) naming WHERE the deliberate emptiness lives on this frame (the quiet band, the margin, the gutter beside the focal object). Composed air, never a corner-clustered accident.`,
    `4. budget — { brandMark, cta }: name the ONE element that owns the single brand mark and the ONE element that owns the single CTA (a role, "chrome", or "none"). Exactly one of each per scene.`,
    ``,
    `ACCENT DISCIPLINE: the brand accent is PUNCTUATION — chips, rules, badges, highlights, small buttons, data moments — never a panel fill. No interior item may describe a large accent-colored surface: an accent-filled panel, slab, column, or half-frame ships as a flat color block and a deterministic gate rejects it.`,
    ``,
    `FULL-BLEED VERTICAL FILL: on a "full-bleed" register scene the hero IS the frame — its interior inventory must populate the FULL frame height, not one horizontal band. Name at least one interior item that lives in the UPPER third of the frame and one in the LOWER third (a nav/chrome band, floating product chips, a footer meta strip, an oversized backdrop texture). A full-bleed hero whose furniture clusters in the middle ships a huge empty band (the barbell defect) and fails a blocking gate.`,
    ``,
    `MOCK TERRITORY: when a scene casts BOTH a hero mock and a standalone copy element, the mock FORFEITS the copy column — never author a full-canvas app shell on such a scene. Name the mock's bounded container explicitly ("floating issue panel filling the right 60%", "browser window on the left two-thirds") so its rows and labels stay clear of the copy; a shell whose rows run edge-to-edge underneath free-standing copy ships interleaved, unreadable text and fails a blocking collision gate. If the concept truly demands a full-canvas shell, do NOT cast a separate copy element — author the copy as interior items ON one of the shell's own panels instead.`,
    ``,
    `CONCRETENESS ON ATTEMPT 1, by example — BAD: 'product card placeholder "A1"' (the word "placeholder" and the fake token both ship on screen, and both are validation failures). GOOD: 'product card "Mountain Water 12-pack — $14.99"'. Author the GOOD form the FIRST time — repair rounds are the expensive path.`,
    ``,
    `ADJACENT-SCENE VARIETY: adjacent scenes must not read as the same layout archetype more than 2 in a row — vary the hero's ARTIFACT TYPE (browser mock, phone frame, dashboard, chart panel, terminal, physical-object tableau) and its implied placement side scene to scene, so no three consecutive scenes ship the same split composition.`,
    ``,
    `OUTPUT: ONLY JSON — a single array of SceneComposition objects, one per scene, in scene order. No prose, no markdown fences, no keys beyond the contract:`,
    `[{ "elements": [{ "role", "subject", "focalRank", "bounds": { "x", "y", "w", "h" }, "interior": [...], "ownsCopy": [...], "motion" }], "atmosphere", "negativeSpace", "budget": { "brandMark", "cta" } }]`,
    ``,
    `WORKED EXAMPLE — one scene, for an UNRELATED brand (a fictional coffee-subscription app):`,
    WORKED_EXAMPLE,
    `The example is ILLUSTRATIVE — your values must come from this script's content and brand; copying any example value is a validation failure.`,
  ].join("\n");

  const sceneCount = script.scenes.length;
  const sceneBlocks = script.scenes.map((scene, i) =>
    [
      `Scene ${i} — "${scene.label}" (register ${scene.register ?? "centered"})`,
      scene.description ? `intent: ${scene.description}` : "",
      `visual concept: ${String(scene.visual_concept ?? "")}`,
      `content: ${JSON.stringify(scene.content ?? {})}`,
    ]
      .filter(Boolean)
      .join("\n"),
  );

  const n = script.narrative;
  const user = [
    `Canvas: ${W}×${H}px (aspect ${aspect}) — author every element's bounds { x, y, w, h } on THIS canvas, optical center ~${cx},${cy}.`,
    opts.brandName ? `Brand: ${opts.brandName}` : "",
    opts.paletteHint ? `Palette: ${opts.paletteHint}` : "",
    opts.designNotes ? `Design notes: ${opts.designNotes}` : "",
    n ? `Narrative: ${n.logline} — ${n.arc}${n.throughline ? ` — throughline motif: ${n.throughline}` : ""}` : "",
    ``,
    `SCENES (${sceneCount}, in order):`,
    sceneBlocks.join("\n\n"),
    ``,
    `Author the blueprint for ALL ${sceneCount} scenes. Emit ONLY the JSON array of exactly ${sceneCount} SceneComposition objects, in scene order.`,
  ]
    .filter((line) => line !== "")
    .join("\n");

  return { system, user };
};

// ─── Robust JSON extraction ─────────────────────────────────────────────────

/**
 * Parse the head's output down to a SceneComposition[]. Robust to the three
 * observed emission shapes: bare JSON, a ```json fence (with prose around it),
 * and prose-then-array. NOTE: code-extraction's stripCodeFence is
 * code-oriented (its fence regex doesn't match ```json), so the head owns its
 * own extraction. Returns the array, or an error string when nothing parses.
 */
export const parseCompositionJson = (text: string): SceneComposition[] | { error: string } => {
  const raw = text.trim();
  const candidates: string[] = [];

  // 1. Largest fenced block, any language tag (```json included).
  const fenceRe = /```[a-z]*[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/gi;
  let best = "";
  for (let m = fenceRe.exec(raw); m; m = fenceRe.exec(raw)) {
    if (m[1].length > best.length) best = m[1];
  }
  if (best) candidates.push(best.trim());

  // 2. The raw text itself.
  candidates.push(raw);

  // 3. First "[" to last "]" — the array dug out of surrounding prose.
  const a = raw.indexOf("[");
  const b = raw.lastIndexOf("]");
  if (a !== -1 && b > a) candidates.push(raw.slice(a, b + 1));

  let lastError = "no JSON array found in output";
  for (const cand of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(cand);
    } catch (err) {
      lastError = `JSON.parse failed: ${err instanceof Error ? err.message : String(err)}`;
      continue;
    }
    // Accept a bare array, or the courtesy `{ "scenes": [...] }` wrapper.
    const arr = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { scenes?: unknown }).scenes)
        ? (parsed as { scenes: unknown[] }).scenes
        : null;
    if (!arr) {
      lastError = "parsed JSON is not an array of SceneComposition objects";
      continue;
    }
    if (!arr.every((item) => item !== null && typeof item === "object" && Array.isArray((item as SceneComposition).elements))) {
      lastError = "array items are not SceneComposition objects (each needs an elements[] array)";
      continue;
    }
    return arr as SceneComposition[];
  }
  return { error: lastError };
};

// ─── The generation loop ────────────────────────────────────────────────────

/** The repair prompt: the FULL original ask + the errors verbatim + the broken
 *  output, and a full re-emit demand (a diff would desync scene order). */
const repairUser = (baseUser: string, previous: string, errors: string[]): string =>
  [
    baseUser,
    ``,
    `Your previous output FAILED. The errors, verbatim:`,
    ...errors.map((e) => `- ${e}`),
    `--- previous output ---`,
    previous.length > 8000 ? `${previous.slice(0, 8000)}\n… (truncated)` : previous,
    `--- end previous output ---`,
    `Re-emit the COMPLETE corrected JSON array — every scene, in scene order, not a diff. ONLY JSON.`,
  ].join("\n");

/** Attach one composition per scene, positionally, on COPIES (the input
 *  script is never mutated). A short array leaves the tail un-composed —
 *  those scenes fall back to the generic-brief path downstream. */
const attach = (scenes: Script["scenes"], compositions: SceneComposition[]): Scene[] =>
  scenes.map((scene, i) => (compositions[i] ? { ...scene, composition: compositions[i] } : { ...scene }));

/**
 * Run the head: prompt → parse → attach → injected validate, with
 * repair-retries that quote every error verbatim. See the module doc for the
 * failure posture (terminal validation returns; only unparseable-after-
 * retries throws).
 */
export const generateComposition = async (
  opts: GenerateCompositionOpts,
): Promise<GenerateCompositionResult> => {
  const { script, caller, validate } = opts;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const { system, user } = buildCompositionPrompt(script, opts);

  const errors: string[] = [];
  let lastScenes: Scene[] | null = null;
  let nextUser = user;
  let attempts = 0;
  let lastParseError = "";

  while (attempts < maxAttempts) {
    attempts++;
    const res = await caller({ system, user: nextUser, maxTokens: HEAD_MAX_TOKENS, effort: HEAD_EFFORT });
    const parsed = parseCompositionJson(res.text);

    if ("error" in parsed) {
      lastParseError = parsed.error;
      errors.push(`attempt ${attempts}: ${parsed.error}`);
      if (attempts < maxAttempts) nextUser = repairUser(user, res.text, [parsed.error]);
      continue;
    }

    // Structural check the head owns (the injected validator sees per-scene
    // content; the count contract lives with the attach step).
    const structural: string[] = [];
    if (parsed.length !== script.scenes.length) {
      structural.push(
        `returned ${parsed.length} compositions for ${script.scenes.length} scenes — emit exactly one SceneComposition per scene, in scene order`,
      );
    }

    const scenes = attach(script.scenes, parsed);
    lastScenes = scenes;

    const attemptErrors = [...structural, ...(validate ? validate(scenes) : [])];
    if (attemptErrors.length === 0) return { scenes, attempts, errors };

    errors.push(...attemptErrors.map((e) => `attempt ${attempts}: ${e}`));
    if (attempts < maxAttempts) nextUser = repairUser(user, res.text, attemptErrors);
  }

  // Terminal. Validation failures return the last parseable attempt's scenes
  // (the caller decides the fallback); with NOTHING ever parsed, throw — that
  // is a head/transport defect, and there is nothing to degrade to.
  if (lastScenes) return { scenes: lastScenes, attempts, errors };
  throw new Error(`composition-head: unparseable after ${attempts} attempts: ${lastParseError}`);
};
