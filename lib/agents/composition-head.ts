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

// ─── Public contract ────────────────────────────────────────────────────────

export interface CompositionPromptOpts {
  /** The brand the video is for — anchors "authored for THIS brand". */
  brandName?: string;
  /** One line describing the palette (hexes/mood) so interior values can name
   *  on-brand treatments ("pay button in the coral accent"). */
  paletteHint?: string;
  /** Free-form design-language notes threaded from the crawl/theme step. */
  designNotes?: string;
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
  const system = [
    `You are the COMPOSITION DIRECTOR for an animated brand video — for each scene, you author the complete blueprint the builders will transcribe.`,
    `The builders downstream are fast literal transcribers: whatever you do not author, they will not invent well. Every creative decision lands HERE, as concrete values.`,
    ``,
    `FOR EVERY SCENE, author:`,
    `1. elements[] — one entry per element the scene needs, each on this contract:`,
    `   - role: one of "hero" | "copy" | "atmosphere" | "connector" | "throughline".`,
    `     hero = the diegetic visual (a product screen, dashboard, chart, device mock — the thing the scene shows).`,
    `     copy = the editorial text stack.`,
    `     atmosphere = the full-bleed decorative base layer.`,
    `     connector = a full-bleed SVG relationship system — cast it ONLY when the scene's concept is genuinely relational (flow, network, convergence, scatter).`,
    `     throughline = the recurring cross-scene motif — cast it in EVERY scene when the script's narrative names a throughline.`,
    `   - subject: what the element IS, concretely. Name the artifact ("the Acme billing dashboard in a browser frame"), never a vague gesture ("some UI", "a visual").`,
    `   - interior: the interior inventory — SHORT concrete items the element must visibly contain. A hero needs AT LEAST 6, and AT LEAST 4 of a hero's items must CARRY TEXT — quoted micro-copy or a concrete value (a chip, timestamp, label, price, metric: 'status chip "Rendering — 5 of 8"'); a text-free logo/glow/CTA-shape inventory renders a hollow scene and is a validation failure. The inventory should imply NESTED structure (rows inside panels, chips inside rows), never six floating fragments. SURFACE CONTRAST: one hero interior item must NAME the hero's dominant surface tone, chosen to CONTRAST with the scene canvas — if the scene canvas is dark, the hero's primary panel must be a light surface or carry high-luminance content ("checkout card on a crisp off-white surface"); if the canvas is light, a dark or richly saturated surface. A hero painted in the canvas's own tone renders as a washout and is a validation failure. EVERY item carries a REAL value authored for THIS brand and THIS scene — a label, number, name, timestamp, or state drawn from (or plausibly extending) this script's content. Plausible diegetic mock values (a price, balance, timestamp inside the product's own UI) are set dressing, not marketing claims — author them concrete and realistic. NEVER sample, masked, or placeholder values ("$XX", "$— — —", "•••", "Item 1", "Company name", lorem) — the builders ship your values verbatim, so a placeholder here ships as a placeholder on screen. Describe the copy widget CONCRETELY — "headline set in display type", "eyebrow line in mono caps" — NEVER with the word "placeholder" (an interior item containing "placeholder" ships that word on screen and is a validation failure). And interior items must NEVER contain the text of any copy field an element ownsCopy — the owning element renders those words exactly once; reference the WIDGET, not the words ("the CTA pill in the accent", never the CTA's text). A validator rejects interiors that retype owned copy.`,
    `   - ownsCopy: the scene content fields (eyebrow, headline, lede, bullets, caption, meta, cta) this element EXCLUSIVELY renders. Be explicit on every element — an empty array means it owns nothing. Ownership is exclusive: no field appears on two elements, and the headline is owned EXACTLY once per scene. An owned field's TEXT lives only in the owner's render — no interior[] item anywhere in the scene may restate it.`,
    `   - motion: ONE sustained motion beat, tied BY NAME to an item in that element's interior list ("the progress bar fills to 62% as the status chip ticks over").`,
    `2. atmosphere — this scene's atmosphere treatment in at least 6 words. It MUST differ from the adjacent scenes' treatments: vary the mechanism (wash vs bands vs rays vs grain), not just the adjective.`,
    ``,
    `ADJACENT-SCENE VARIETY: adjacent scenes must not read as the same layout archetype more than 2 in a row — vary the hero's ARTIFACT TYPE (browser mock, phone frame, dashboard, chart panel, terminal, physical-object tableau) and its implied placement side scene to scene, so no three consecutive scenes ship the same split composition.`,
    ``,
    `OUTPUT: ONLY JSON — a single array of SceneComposition objects, one per scene, in scene order. No prose, no markdown fences, no keys beyond the contract:`,
    `[{ "elements": [{ "role", "subject", "interior": [...], "ownsCopy": [...], "motion" }], "atmosphere" }]`,
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
