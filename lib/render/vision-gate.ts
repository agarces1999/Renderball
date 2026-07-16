/**
 * Render-truth vision gate (Phase 3) — the holistic readability/brand-fit layer
 * the deterministic gates can't cover.
 *
 * Deterministic gates (overflow) catch unambiguous correctness. But "the logos
 * are washed out," "this is a wall of type," "the canvas isn't the brand color,"
 * and "this just looks broken" are judgment calls a brittle pixel heuristic
 * false-positives on (proven in Phase 1 — the monochrome-logo contrast FP). So
 * those go to an Opus vision pass on the rendered screenshot, judged against the
 * brand truth.
 *
 * ADVISORY by default: findings are surfaced as warnings, not blockers, until
 * the false-positive rate is calibrated on real builds. The judge is injected
 * so the gate logic is unit-tested with a mock — no real vision spend.
 */
import { promises as fs } from "fs";

export interface VisionFinding {
  /** Scene index the finding applies to. SEQUENCE_SCENE (-1) = whole-video finding. */
  scene: number;
  issue: string;
  /**
   * Where the finding came from. Absent/"scene" = a per-frame verdict (routable
   * to a scene retry). "sequence" = the whole-video judge (monotony/arc) —
   * route to head-level fixes, NEVER a single-scene regen.
   */
  scope?: "scene" | "sequence";
}

/** Sentinel scene index for sequence-level findings (no single scene owns them). */
export const SEQUENCE_SCENE = -1;

/** Brand truth the rubric judges against. */
export interface BrandTruth {
  name?: string;
  /** The canvas/page background the brand actually uses (e.g. burgundy #440b12). */
  backgroundColor?: string;
  /** Signature accent (CTAs/emphasis). */
  accent?: string;
  /** Expected font families (e.g. a serif the brand uses for emphasis). */
  fonts?: string[];
}

/** A judge verdict for one scene frame. */
export interface VisionVerdict {
  ok: boolean;
  issues: string[];
}

/** Injected: judge one screenshot against the rubric. Returns issues found. */
export type VisionJudge = (
  screenshotPath: string,
  sceneIndex: number,
  rubric: string,
) => Promise<VisionVerdict>;

/**
 * Pull the plan's concrete elements out of a visual_concept so plan-fidelity is
 * judged PER ELEMENT instead of against a prose blob. Two sources:
 *   1. Quoted labels — the plan's literal on-screen strings ('Email Tool',
 *      "app.hubspot.com"). These are the strongest fidelity anchors.
 *   2. Concrete element nouns (with up to two modifier words: "glass cards",
 *      "connector lines", "app window") from the Composition half of the
 *      concept — the Animations half re-names the same elements.
 * Deduped, capped, quoted labels first. Best-effort: an empty result just means
 * the rubric falls back to the prose concept alone.
 */
export const extractPlannedElements = (concept: string): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const t = raw.trim().replace(/\s+/g, " ");
    if (t.length < 2 || t.length > 60 || !/[a-z0-9]/i.test(t)) return;
    const k = t.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(t);
    }
  };

  // 1) Quoted labels. Opening quote must follow start/space/punct and the closing
  //    quote must precede space/punct/end so possessives ("the scene's tabs")
  //    don't open a phantom span.
  const QUOTED = /(^|[\s(,:;—–-])(?:'([^'\n]{1,60})'|"([^"\n]{1,60})"|‘([^‘’\n]{1,60})’|“([^“”\n]{1,60})”)(?=[\s).,;:!?—–-]|$)/g;
  for (const m of concept.matchAll(QUOTED)) push(m[2] ?? m[3] ?? m[4] ?? m[5] ?? "");

  // 2) Concrete element nouns (+ up to two preceding modifier tokens). Only the
  //    Composition section — Animations re-mentions every element.
  const composition = concept.split(/\bAnimations?\s*:/i)[0] ?? concept;
  // Modifier tokens need ≥2 chars — the stranded "s" of a possessive
  // ("scene's tabs") must not become a modifier ("s tabs").
  const ELEMENT_NOUN =
    /(?:\b[A-Za-z][\w-]+\s+){0,2}\b(?:logo|wordmark|tagline|headline|subheadline|subhead|caption|button|cta|card|tab|panel|sidebar|navbar|nav|dashboard|diagram|chart|graph|timeline|badge|pill|divider|bar|window|feed|record|ticker|table|grid|row|avatar|icon|illustration|map|mockup|screen|sparkline|counter|terminal|browser|device|phone|list)s?\b/gi;
  const LEADING_STOP =
    /^(?:the|a|an|of|in|on|at|to|from|with|and|or|for|its|their|each|every|per|this|that|these|those|then|also|show(?:s|ing)?|read(?:s|ing)?|sit(?:s|ting)?|hold(?:s|ing)?|below|above|beneath|behind)\s+/i;
  for (const m of composition.match(ELEMENT_NOUN) ?? []) {
    let t = m;
    while (LEADING_STOP.test(t)) t = t.replace(LEADING_STOP, "");
    push(t);
  }
  // Bounded: the checklist is a rubric aid, not an inventory. Quoted labels won
  // their slots first (pushed first).
  return out.slice(0, 14);
};

export const buildRubric = (
  brand: BrandTruth,
  sceneConcept?: string,
  // Optional override; by default the checklist is extracted from the concept
  // itself so every existing caller gets per-element fidelity for free.
  plannedElements?: string[],
): string => {
  const elements = sceneConcept ? (plannedElements ?? extractPlannedElements(sceneConcept)) : (plannedElements ?? []);
  const lines = [
    "You are a brutally honest brand-video QA reviewer. This is ONE rendered scene of a 1920×1080 brand video a customer PAID for.",
    "Judge ONLY what you can see. Report concrete, visible problems a viewer would notice — not nitpicks.",
    "Check:",
    brand.backgroundColor
      ? `- Canvas/background: the brand's real background is ${brand.backgroundColor}. Flag if the canvas is a clearly different color OR the opposite luminance (near-black canvas for a light brand, or vice versa).`
      : "- Canvas/background: flag a generic dark/black canvas if it clearly clashes with the brand.",
    brand.accent
      ? `- Accent hierarchy: ${brand.accent} is the brand's signature color and should visibly LEAD (CTA, emphasis, hero highlight). Flag if a different color dominates every accent while ${brand.accent} is nearly absent.`
      : "- Accent hierarchy: flag when the dominant accent color clearly isn't the brand's.",
    '- Placeholder/broken data: flag ANY masked or unresolved value — prices like "$•••.00" or "$—", a "Loading" label, an empty white box where a logo/image should be, tofu/□ glyphs, obviously truncated text. These read as a broken render.',
    "- Web-page chrome: this must look like a FILM frame. Flag website navigation bars with LINKS, pagination/carousel dots, scroll indicators, or a composition that reads as a landing-page screenshot rather than a staged scene. SANCTIONED EXEMPTION — every scene deliberately carries the video's own brand chrome: a small brand wordmark/logo in the TOP-LEFT corner and a small uppercase context pill in the TOP-RIGHT (e.g. \"● OURA RING\"). These are the film's watermark, present BY DESIGN. Never report them — alone or together, in any wording. Only flag corner elements that are something ELSE (a clickable-looking nav menu, multiple links, a button row).",
    "- Readability: flag any text or logo that is washed out, low-contrast, or hard to read against its surface — including a hero illustration so dim it reads as an indistinct blob.",
    "- Wall-of-type: flag a scene that is essentially just large text with no substantial non-text/diegetic element.",
    "- Density/craft: reference-grade furnishing is the bar — this frame must look FINISHED, not sketched. Every prominent container you can see — an app window, dashboard, browser mock, phone screen, card, or panel — must show realistic interior content: labeled rows, real-looking values or numbers, timestamps, small captions, avatars or icons. Flag: a large mock or panel whose interior is empty or a plain wash of color; a 'dashboard' or 'app window' that is just an outlined rectangle with a title; a chart area with axes but no data marks; a scene whose lower half is entirely empty canvas. Deliberate negative space around ONE fully-drawn hero element is fine — an unfurnished container or a half-empty frame is not.",
    brand.fonts && brand.fonts.length
      ? `- Fonts: the brand uses ${brand.fonts.join(", ")}. Flag if the type looks like a generic default that ignores the brand's faces (esp. a missing serif).`
      : "- Fonts: flag obviously off-brand/default typography.",
    "- Clipping/overflow: flag any element cut off at an edge (a deterministic gate also checks this; report if you still see it).",
    ...(sceneConcept
      ? [
          // Full concept (was a 500-char slice that cut real plans mid-sentence
          // — concepts run 800–1300 chars). 4000 is a safety valve only.
          `- Plan fidelity: the scene was designed to this concept: "${sceneConcept.slice(0, 4000)}". For EACH planned element, verify three things: (a) PRESENT — you can point at it in the frame; (b) FURNISHED — it carries its stated content (labels, values, rows), not a blank stand-in; (c) RECOGNIZABLE — a viewer would name it the way the plan does. Flag every planned element that is missing, blank, or unrecognizably degraded, and any specified interaction that looks broken or the concept's emotional beat visibly inverted.`,
          ...(elements.length
            ? [`  Planned elements to verify one by one: ${elements.map((e) => `"${e}"`).join(", ")}.`]
            : []),
        ]
      : []),
    'Return ONLY JSON: {"ok": boolean, "issues": ["short, specific problem", ...]}. ok=true and issues:[] when the scene looks correct and on-brand. No prose.',
  ];
  return lines.join("\n");
};

/**
 * The judge model (GLM-4.5V) keeps flagging the sanctioned BrandChrome — the
 * corner wordmark + context pill every scene carries by design — as "web-page
 * chrome" no matter how loudly the rubric exempts it (observed verbatim on the
 * Oura build). Prompt-side exemption alone is unreliable, so findings that are
 * ONLY about those corner marks are dropped post-hoc. A finding that also names
 * a real defect (overlap, unreadable, clipped, missing…) always survives.
 */
export const isSanctionedChromeFinding = (issue: string): boolean => {
  const mentionsChrome =
    /wordmark|nav(igation)?\s+pill|context pill|corner (logo|mark)|brand (mark|chrome)|watermark/i.test(issue);
  const mentionsCorner = /top[- ](left|right)|corner/i.test(issue);
  const realDefect =
    /overlap|collid|unread|illegib|clipped|cut ?off|missing|broken|invisible|obscur|washed[- ]out|low[- ]contrast/i.test(
      issue,
    );
  return mentionsChrome && mentionsCorner && !realDefect;
};

/**
 * Run the vision gate over the per-scene screenshots. Returns findings (one per
 * issue). Best-effort: a judge error on a scene is skipped (advisory pass must
 * never break a build). Reuses one rubric across scenes.
 */
export const runVisionGate = async (
  scenes: { scene: number; screenshotPath?: string; concept?: string }[],
  brand: BrandTruth,
  judge: VisionJudge,
): Promise<VisionFinding[]> => {
  // The judge calls are fully independent — run them CONCURRENTLY. Serially
  // this was 5 sequential vision round-trips (each with a 60s abort ceiling);
  // parallel is one round-trip of wall-clock. Rubric is per-scene now (plan
  // fidelity judges the frame against ITS concept).
  const judged = await Promise.allSettled(
    scenes
      .filter((s): s is { scene: number; screenshotPath: string; concept?: string } => !!s.screenshotPath)
      .map(async (s) => ({
        scene: s.scene,
        verdict: await judge(s.screenshotPath, s.scene, buildRubric(brand, s.concept)),
      })),
  );
  const out: VisionFinding[] = [];
  for (const r of judged) {
    // advisory — a scene whose judge call failed is skipped (never breaks a build)
    if (r.status !== "fulfilled") continue;
    const { scene, verdict } = r.value;
    if (!verdict.ok)
      for (const issue of verdict.issues)
        if (!isSanctionedChromeFinding(issue)) out.push({ scene, issue });
  }
  return out;
};

/** Parse the model's JSON verdict tolerantly (finds the first {...} object). */
export const parseVerdict = (text: string): VisionVerdict => {
  try {
    const m = /\{[\s\S]*\}/.exec(text);
    if (!m) return { ok: true, issues: [] };
    const o = JSON.parse(m[0]) as { ok?: unknown; issues?: unknown };
    const issues = Array.isArray(o.issues) ? o.issues.filter((x): x is string => typeof x === "string") : [];
    return { ok: o.ok === true && issues.length === 0, issues };
  } catch {
    return { ok: true, issues: [] };
  }
};

/**
 * Build the real Opus-vision judge. Reads the PNG, sends it + the rubric to the
 * vision-capable model, parses the JSON verdict. `callVision` is injected (the
 * route passes an Anthropic-backed call) so this stays free of a hard SDK dep
 * here and unit-testable.
 */
export const makeVisionJudge = (
  callVision: (imageBase64: string, rubric: string) => Promise<string>,
): VisionJudge => {
  return async (screenshotPath, _sceneIndex, rubric) => {
    const buf = await fs.readFile(screenshotPath);
    const text = await callVision(buf.toString("base64"), rubric);
    return parseVerdict(text);
  };
};

// ─── Sequence-level gate (whole-video, one call) ─────────────────────
//
// Per-frame verdicts are structurally blind to repetition: five separate CLEAN
// verdicts missed the same radial glow recycled in 4/5 scenes (founder caught
// it by eye in the parity audit). Monotony, archetype repetition, and a flat
// arc only exist ACROSS frames, so all frames go to the judge in ONE call.

/** Injected multi-image judge: all ordered frames + one prompt → raw model text. */
export type SequenceJudge = (imagesB64: string[], prompt: string) => Promise<string>;

/**
 * Rubric for the whole-video pass. Same {ok, issues[]} JSON contract as the
 * per-scene rubric so downstream parsing/telemetry is uniform.
 */
export const buildSequenceRubric = (sceneCount: number, brand: BrandTruth): string => {
  const lines = [
    `You are a brutally honest brand-video QA reviewer judging a WHOLE video, not one frame. You are given ${sceneCount} frames IN ORDER: image 1 is scene 0 (the opening), image ${sceneCount} is scene ${sceneCount - 1} (the closing/CTA). Each frame already passed single-frame QA — judge ONLY how they work as a SEQUENCE.`,
    "Check:",
    `- Atmosphere monotony: flag when 3 or more scenes share the same background treatment — the same centered radial glow, the same gradient wash, the same vignette, the same floating-dot field in the same spot. Name the scenes (e.g. "scenes 0, 2, 3 all use the same centered radial glow").${
      brand.backgroundColor
        ? ` The brand canvas color ${brand.backgroundColor} repeating on every scene is EXPECTED consistency — never flag the canvas color itself.`
        : " A consistent brand canvas color across scenes is EXPECTED — never flag the canvas color itself."
    }`,
    "- Archetype repetition: flag when several scenes are the same layout re-skinned — centered-logo-plus-headline three times, two near-identical split screens, the same hub diagram twice. The video should read as different staged shots, not one slide restyled.",
    "- Arc progression: the video must MOVE. Early frames establish, the middle escalates or demonstrates, the closing lands the CTA with different energy than the open. Flag when a late frame is interchangeable with an early frame in tone, composition, or energy — a closing scene that looks like the opening restated.",
    "- Throughline evolution: a recurring motif (a device, product window, diagram, mascot) should EVOLVE across scenes — grow, gain content, move, resolve — not be copy-pasted identically. Flag identical reuse of the same drawn element across scenes.",
    'SANCTIONED CHROME: every frame deliberately carries the video\'s own brand chrome — a small brand wordmark in the TOP-LEFT corner and a small uppercase context pill in the TOP-RIGHT (e.g. "● OURA RING"). Their repetition across all frames is BY DESIGN. Never report them — alone, together, or as "repeated in every scene".',
    'Return ONLY JSON: {"ok": boolean, "issues": ["short, specific problem naming the scenes involved", ...]}. ok=true and issues:[] when the sequence reads as a progressing story. No prose.',
  ];
  return lines.join("\n");
};

/**
 * Run the whole-video pass: all frames (already in scene order — index i =
 * scene i) go to the injected multi-image judge in ONE call. Findings come back
 * as {scene: SEQUENCE_SCENE, scope: "sequence"} so callers route them to
 * head-level fixes, never a single-scene retry. Never throws (advisory): a
 * judge error or an unparseable verdict becomes ONE distinguishable
 * "SEQUENCE-JUDGE-ERROR:" finding — silence must mean "ran clean", not
 * "swallowed" (the Duolingo lesson).
 */
export const judgeSequence = async (
  imagesB64: string[],
  brand: BrandTruth,
  judge: SequenceJudge,
): Promise<VisionFinding[]> => {
  if (imagesB64.length === 0) return [];
  const errorFinding = (why: string): VisionFinding[] => [
    { scene: SEQUENCE_SCENE, scope: "sequence", issue: `SEQUENCE-JUDGE-ERROR: ${why}` },
  ];
  let text: string;
  try {
    text = await judge(imagesB64, buildSequenceRubric(imagesB64.length, brand));
  } catch (e) {
    return errorFinding(`judge call failed — ${e instanceof Error ? e.message : String(e)}`);
  }
  // Same tolerant parse pattern as parseVerdict — but malformed output here is
  // an explicit error finding, NOT a silent pass: this call is one-per-build,
  // so a swallowed failure would silently disable the whole sequence layer.
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return errorFinding("verdict contained no JSON object");
  let o: { ok?: unknown; issues?: unknown };
  try {
    o = JSON.parse(m[0]) as { ok?: unknown; issues?: unknown };
  } catch {
    return errorFinding("verdict JSON did not parse");
  }
  const issues = Array.isArray(o.issues) ? o.issues.filter((x): x is string => typeof x === "string") : [];
  if (o.ok === true && issues.length === 0) return [];
  // The sanctioned-chrome post-filter applies here too — "wordmark repeated in
  // every corner" is the by-design watermark, not monotony.
  return issues
    .filter((issue) => !isSanctionedChromeFinding(issue))
    .map((issue) => ({ scene: SEQUENCE_SCENE, scope: "sequence" as const, issue }));
};

// ─── Brand-fidelity backstop (crawl-independent) ─────────────────────
//
// The rest of QA validates render-vs-CRAWL consistency: the vision rubric is told
// "the brand bg is {extracted_color}" and checks the render matches it. Circular —
// when the crawl extracts the WRONG color, the render matches the wrong reference
// and passes (Robinhood shipped blue, all "on-brand" to QA). Nothing audited the
// crawl against reality.
//
// This closes that loop using the model's world-knowledge of the brand — but
// crucially TEXT-ONLY (brand name + the extracted palette, NO image). Validated
// 2026-06-22: with a frame present the model parrots the frame's color (passes the
// wrong color); with no image it recalls accurately (Robinhood green, DoorDash red,
// Spotify green, Canva cyan) and correctly checks the signature color is PRESENT in
// the palette — so brand-color-as-accent on a dark canvas (DoorDash) is NOT flagged,
// while a wrong palette (Robinhood blue) IS.

export interface BrandFidelityVerdict {
  onBrand: boolean;
  issue: string;
}

/** Text-only prompt: recall the brand's signature color, check it's present in the
 *  extracted palette. High-bar (only a confident, clearly-missing signature color
 *  flags) + passes cleanly on brands the model doesn't know. */
export const buildBrandColorPrompt = (name: string, palette: string[]): string =>
  `The brand is "${name}". A generated video used this color palette: [${palette.join(", ")}]. From your OWN knowledge of ${name}'s single signature brand color, is that signature color present in the palette (allow close shades / the same hue family)? If you do NOT confidently know this brand, set onBrand:true (do not guess). Return ONLY JSON: {"brandColor":"name + hex","present":boolean,"onBrand":boolean,"issue":"<brand color> missing — palette is <short summary>" or ""}. No prose.`;

/** Tolerant parse — defaults to onBrand:true (never flag on an unparseable/odd
 *  response; this is an advisory backstop, false positives erode trust). */
export const parseBrandFidelity = (text: string): BrandFidelityVerdict => {
  try {
    const m = /\{[\s\S]*\}/.exec(text);
    if (!m) return { onBrand: true, issue: "" };
    const o = JSON.parse(m[0]) as { onBrand?: unknown; issue?: unknown };
    const issue = typeof o.issue === "string" ? o.issue.trim() : "";
    // Only a verdict that EXPLICITLY says onBrand:false (with a reason) flags.
    if (o.onBrand === false && issue) return { onBrand: false, issue };
    return { onBrand: true, issue: "" };
  } catch {
    return { onBrand: true, issue: "" };
  }
};

/**
 * Check the brand's signature color (from the model's knowledge) is present in the
 * crawl-extracted `palette` — NO image, so the recall can't anchor to a wrong frame.
 * Best-effort + advisory: no name / empty palette / any error → on-brand (never
 * block, never false-alarm). `callText` injected for unit tests.
 */
export const checkBrandColorFidelity = async (
  brand: { name?: string },
  palette: string[],
  callText: (prompt: string) => Promise<string>,
): Promise<BrandFidelityVerdict> => {
  if (!brand.name || palette.length === 0) return { onBrand: true, issue: "" };
  try {
    const text = await callText(buildBrandColorPrompt(brand.name, palette));
    return parseBrandFidelity(text);
  } catch {
    return { onBrand: true, issue: "" };
  }
};
