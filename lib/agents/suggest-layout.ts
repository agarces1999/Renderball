//
// Suggest a LAYOUT for one page: a handful of boxes and what belongs in each.
//
// The marquee answers "I know where this goes" — you draw the box yourself. This
// answers the question before that one: "what should this page even look like?"
// The user types an intent at the top of the slide, presses Suggest, and gets
// proposed regions drawn on the canvas with a label each.
//
// Deliberately it does NOT generate the elements. Designing a page costs real
// tokens and minutes, so the cheap step (where do things go) is shown and
// approved before the expensive one (make them) — the same "story before render"
// rule the build pipeline follows. Each suggestion carries the prompt that would
// be handed to generate-piece, so accepting one is exactly the marquee flow with
// the box and the words pre-filled.
//
// Geometry is NOT trusted from the model: bounds are clamped to the canvas, held
// to a legible minimum, de-overlapped against each other and against the page's
// existing elements, and capped in number — see `sanitizeSuggestions`.
//
import { MODELS } from "../anthropic";
import { getBuildClient } from "../llm/build-client";
import { withTransientRetry } from "./transient-retry";
import { stripCodeFence, elideDataUris } from "./code-extraction";
import { usageOf, type Usage } from "../usage";
import type { DecomposedPiece } from "./lego-decompose";

const SYSTEM = `You plan the LAYOUT of ONE page of a presentation deck.

Given the page's canvas size, what already sits on it, and what the user wants, propose the REGIONS the page should be built from — where each thing goes and what belongs there. You do not write the elements; you decide the composition.

Return ONLY a JSON object, no prose and no markdown fence:

{"regions":[{"label":"Headline","prompt":"a bold headline reading …","x":120,"y":110,"w":1100,"h":220}]}

RULES:
- 2 to 6 regions. Fewer, larger, confident regions beat many small ones. A deck page is not a dashboard.
- Coordinates are pixels on the given canvas, origin top-left. Every region must sit fully inside the canvas.
- Regions MUST NOT overlap each other, and MUST NOT overlap the existing elements listed.
- Respect a generous margin from the canvas edges (about 6% of the width). Decks breathe.
- "label" is 1-3 words naming the region ("Headline", "KPI row", "Product shot").
- "prompt" is a specific instruction for whoever builds that element — say what it says and what it looks like, in one sentence. Use the user's own facts and numbers; never invent statistics.
- Size regions for their content: a headline is wide and short, a chart is large, a caption is small.
- Align regions to a shared grid — matching left edges and consistent gutters — so the page reads as designed rather than scattered.`;

/** A region the model proposed, after validation. */
export interface LayoutSuggestion {
  label: string;
  prompt: string;
  bounds: { x: number; y: number; w: number; h: number };
}

export interface SuggestLayoutInput {
  sceneIndex: number;
  /** Canvas size in px — the coordinate space the bounds come back in. */
  canvas: { w: number; h: number };
  /** What is already on the page; suggestions must not land on top of it. */
  existing: DecomposedPiece[];
  /** Occupied boxes for the existing pieces, when known (canvas px). */
  occupied?: { x: number; y: number; w: number; h: number }[];
  /** What the user typed in the Suggest box. Required. */
  prompt: string;
  /** The document's brand rules, so proposals respect the brand's grammar. */
  brandBlock?: string | null;
  model?: string;
}

export interface SuggestLayoutResult {
  ok: boolean;
  suggestions?: LayoutSuggestion[];
  usage?: Usage;
  error?: string;
}

/** Smallest region worth proposing — below this nothing legible fits. */
const MIN_W = 120;
const MIN_H = 60;
const MAX_REGIONS = 6;

/**
 * How much of `a` is covered by `b`, as a fraction of a's area.
 *
 * A boolean "do these touch at all" test was tried first and is too brutal: on a
 * real slide, measured element boxes graze each other constantly, so every
 * proposal got rejected and Suggest returned "no usable regions" on a page with
 * obvious free space. What matters is whether a region would SIT ON something,
 * not whether it shares an edge with it.
 */
const coveredFraction = (
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): number => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  const area = a.w * a.h;
  return area > 0 ? (w * h) / area : 0;
};

/** A proposal may graze existing content, but must not sit on top of it. */
const MAX_COVER_BY_EXISTING = 0.25;
/**
 * ...and must not SWALLOW it either.
 *
 * The one-directional test above is not enough: a large proposed region that
 * completely contains a small text block is only a few percent covered by it, so
 * it passes — and then renders as a box drawn straight over the KPI rows. Both
 * directions have to be checked. A line of text mostly inside a region means
 * that region is on top of it, however big the region is.
 */
const MAX_EXISTING_SWALLOWED = 0.5;
/** Two proposals may share an edge, but must not stack. */
const MAX_COVER_BY_SIBLING = 0.1;

/**
 * Trust the model's INTENT, never its arithmetic.
 *
 * Layout models routinely emit boxes that hang off the canvas, collide, or come
 * back 4px tall. Rather than round-trip a repair prompt, each region is clamped
 * into the canvas, dropped if it is too small to hold anything legible, and
 * dropped if it collides with an already-accepted region or with something
 * already on the page. Order is preserved, so the model's most important region
 * wins a collision.
 */
export const sanitizeSuggestions = (
  raw: unknown,
  canvas: { w: number; h: number },
  occupied: { x: number; y: number; w: number; h: number }[] = [],
): LayoutSuggestion[] => {
  const list = Array.isArray((raw as { regions?: unknown })?.regions)
    ? ((raw as { regions: unknown[] }).regions)
    : [];
  const kept: LayoutSuggestion[] = [];

  for (const item of list) {
    if (kept.length >= MAX_REGIONS) break;
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const label = typeof r.label === "string" ? r.label.trim().slice(0, 40) : "";
    const prompt = typeof r.prompt === "string" ? r.prompt.trim().slice(0, 400) : "";
    if (!prompt) continue; // a region with nothing to build is not a suggestion

    const nums = [r.x, r.y, r.w, r.h].map((v) => (typeof v === "number" && Number.isFinite(v) ? v : NaN));
    if (nums.some(Number.isNaN)) continue;
    let [x, y, w, h] = nums;

    // Clamp into the canvas without changing the region's size where possible.
    w = Math.min(Math.max(w, 0), canvas.w);
    h = Math.min(Math.max(h, 0), canvas.h);
    x = Math.min(Math.max(x, 0), canvas.w - w);
    y = Math.min(Math.max(y, 0), canvas.h - h);
    if (w < MIN_W || h < MIN_H) continue;

    const bounds = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
    const collides = occupied.some(
      (o) =>
        coveredFraction(bounds, o) > MAX_COVER_BY_EXISTING ||
        coveredFraction(o, bounds) > MAX_EXISTING_SWALLOWED,
    );
    if (collides) continue;
    if (kept.some((k) => coveredFraction(bounds, k.bounds) > MAX_COVER_BY_SIBLING)) continue;

    kept.push({ label: label || "Element", prompt, bounds });
  }
  return kept;
};

/**
 * Validate client-supplied occupied rectangles.
 *
 * These arrive from the browser, so they are untrusted input on a route that
 * spends tokens: anything non-numeric is dropped, and the list is capped so a
 * crafted body cannot inflate the prompt.
 */
export const parseOccupied = (raw: unknown): { x: number; y: number; w: number; h: number }[] => {
  if (!Array.isArray(raw)) return [];
  const out: { x: number; y: number; w: number; h: number }[] = [];
  for (const item of raw.slice(0, 40)) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const nums = [r.x, r.y, r.w, r.h].map((v) =>
      typeof v === "number" && Number.isFinite(v) ? v : NaN,
    );
    if (nums.some(Number.isNaN)) continue;
    const [x, y, w, h] = nums;
    if (w <= 0 || h <= 0) continue;
    out.push({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });
  }
  return out;
};

/** First JSON object in a blob of model text. */
const parseJson = (text: string): unknown => {
  const cleaned = stripCodeFence(text.trim());
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
  }
};

const existingLine = (p: DecomposedPiece): string =>
  `- ${p.id} (${p.kind}): ${elideDataUris(p.body).replace(/\s+/g, " ").trim().slice(0, 120)}`;

export const suggestLayout = async (input: SuggestLayoutInput): Promise<SuggestLayoutResult> => {
  const { sceneIndex, canvas, existing, prompt } = input;
  const occupied = input.occupied ?? [];
  const model = input.model || MODELS.codingAgentBuild;
  const client = getBuildClient();

  const lines: string[] = [
    `PAGE ${sceneIndex + 1}. Canvas is ${Math.round(canvas.w)}px wide × ${Math.round(canvas.h)}px tall.`,
    "",
  ];

  // Geometry FIRST, description second. A model given only prose ("do not
  // overlap the headline") reliably proposes a box straight over the headline;
  // given the actual rectangles it routes around them. These are measured in the
  // browser from the rendered page — see occupiedBounds in ElementEditor.
  if (occupied.length) {
    lines.push(
      "OCCUPIED RECTANGLES — every region you propose must avoid ALL of these (canvas px):",
      ...occupied.map((o) => `- x:${o.x} y:${o.y} w:${o.w} h:${o.h}`),
      "",
      "Place your regions in the space these leave free. If the page is already full, propose fewer regions rather than stacking on top of them.",
      "",
    );
  }

  lines.push(
    existing.length
      ? `WHAT THOSE ELEMENTS ARE (context only):\n${existing.map(existingLine).join("\n")}`
      : "The page is empty — you are composing it from nothing.",
    "",
    `WHAT THE USER WANTS: ${prompt.trim()}`,
    "",
    "Return the JSON object described in your instructions and nothing else.",
  );

  const user = lines.join("\n");

  let response;
  try {
    response = await withTransientRetry("suggest-layout", () =>
      client.messages
        .stream({
          model,
          max_tokens: 2000,
          system: [
            { type: "text", text: SYSTEM },
            ...(input.brandBlock ? [{ type: "text" as const, text: input.brandBlock }] : []),
          ],
          messages: [{ role: "user", content: user }],
        })
        .finalMessage(),
    );
  } catch (err) {
    return {
      ok: false,
      error: `suggest-layout API error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const usage = usageOf(response.usage);
  const text = response.content.find((c) => c.type === "text");
  const parsed = text && text.type === "text" ? parseJson(text.text) : null;
  if (!parsed) return { ok: false, usage, error: "could not read a layout from the model" };

  const suggestions = sanitizeSuggestions(parsed, canvas, input.occupied ?? []);
  if (suggestions.length === 0) {
    return { ok: false, usage, error: "no usable regions came back — try describing the page differently" };
  }
  return { ok: true, suggestions, usage };
};
