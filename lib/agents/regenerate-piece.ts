//
// M2 — per-element (per-piece) regeneration. The ONE LLM op of the visual editor.
//
// Regenerates a SINGLE piece's inner JSX against the scene's frozen design system
// (the decomposed preamble — read-only) plus its sibling pieces as read-only
// context (for style + non-overlap coherence). It returns ONLY the replacement
// body; the caller writes exactly one piece file, then reassembles. Because every
// piece is its own file (M1b), the regenerated Composition differs from the
// original in that one body and nothing else — the zero-neighbor guarantee as a
// filesystem fact, not a prompt request.
//
import { MODELS } from "../anthropic";
import { promptDigest } from "../llm/safe-truncate";
import { getBuildClient } from "../llm/build-client";
import { withTransientRetry } from "./transient-retry";
import { stripCodeFence, elideDataUris } from "./code-extraction";
import { usageOf, type Usage } from "../usage";
import type { DecomposedPiece } from "./lego-decompose";

const SYSTEM = `You regenerate ONE element ("piece") of an animated brand-video scene, IN PLACE.

You are given the scene's shared design system (module consts already in scope) and the element's current JSX. Re-emit ONLY the replacement JSX for this ONE element.

HARD RULES:
- Output ONLY the JSX for this ONE element — no imports, no prose, no markdown fence, no <Piece> wrapper. It is inlined verbatim where the old element was.
- Reference the shared consts (PALETTE.*, FONT_DISPLAY/FONT_BODY/FONT_MONO, LOGO_SRC, the @keyframes names, EASE_* etc.) EXACTLY as the current element and its siblings do. NEVER invent new colors, fonts, or @keyframes — reuse only what already exists. Match the scene's design grammar (corner radius, stroke weight, shadow recipe, mono-for-data convention).
- Keep this element's ROLE, FORM, and rough BOUNDS. MATCH THE CURRENT ELEMENT'S FORM: if the current JSX is a call to a shared component (e.g. <FormatCard x={..} y={..} .../>, <StatTile .../>), return that SAME component with adjusted props and KEEP its positioning props (x/y/left/top/w/h) so it stays in place — do NOT convert it into a raw <div>. If the current JSX is raw positioned markup, keep position:absolute + the same left/top region. If the current JSX is UNPOSITIONED interior markup (no position:absolute on its outermost element — it lives in a system-owned box that handles placement), KEEP it unpositioned: do not add position:absolute, left, top, width, or height to the outermost element. Either way a text element stays text, a mock stays a mock, an image stays an image, and you do NOT overlap the sibling elements listed.
- Animation is CSS only — reuse the existing @keyframes by name. No Remotion hooks (no useCurrentFrame/useVideoConfig), no Math.random (hardcode any "random-looking" values).
- Define NOTHING at module scope and reference NO undefined components — use only the provided consts + inline JSX/SVG (and <Img> for images).
- It must be valid TSX that compiles when inlined.`;

/**
 * ANIMATE mode (founder, 2026-09-03: "just like we have regenerate for
 * elements let's have animate for elements as well with prompts"). The same
 * one-piece, zero-neighbor op, with the task inverted: the element is
 * finished and ONLY its motion changes. The rules below are the same contract
 * the author receives at build time (lib/harness/pack.ts MOTION) — the settled
 * end state must equal the designed layout, because export, thumbnails,
 * measurement and the editor all read the page settled.
 */
const ANIMATE_SYSTEM = `You add MOTION to ONE element ("piece") of a presentation page, IN PLACE. The element is otherwise finished: you change its motion and nothing else.

You are given the page's shared design system (module consts already in scope) and the element's current JSX. Re-emit ONLY the replacement JSX for this ONE element.

HARD RULES:
- Output ONLY the JSX for this ONE element — no imports, no prose, no markdown fence, no <Piece> wrapper. It is inlined verbatim where the old element was.
- Change NOTHING but motion. Text, colors, fonts, sizes, positions, structure, props and every existing style stay byte-identical. The only permitted additions are animation properties in inline styles (animation, animationDelay, animationFillMode, transformOrigin, willChange — React camelCase) and ONE <style> element holding your @keyframes.
- Put that <style> as the FIRST child inside the element's outermost tag: <div ...><style>{\`@keyframes rb-... { ... }\`}</style> ...the unchanged children... </div>. If the outermost element cannot hold children (an <img>), wrap it in a <div style={{ position: "absolute", left, top, width, height }}> that takes over its placement, and put the <style> and the image (now width/height "100%") inside.
- Name every keyframe with the prefix "rb-<element id with dots replaced by dashes>-" so it cannot collide with the deck's own keyframes, and define every keyframe you reference. You may also reuse a @keyframes the design system already defines, by name.
- THE INVARIANT: the element's static inline style IS its resting state. Entrances use animation-fill-mode "backwards" (never "forwards" or "both"); the hidden starting pose lives ONLY in the keyframes' from-frame, and the animation ends at the element's own designed appearance (to { opacity: 1; transform: none }). Never add a static opacity: 0 or an offset transform. The deck is exported, thumbnailed and edited at its settled end state, so anything that does not rest on its static styles is a defect.
- Animate only opacity, transform, and stroke-dashoffset/stroke-dasharray — never width, height, left, top, font-size or color.
- Entrances are finite (300-1200ms, ease-out, literal delays). A loop (infinite) is allowed only when asked for, only on INNER parts of the element (a dot, a ring, a bar's fill) — never on text and never on the outermost element — subtle, 3-12s, ease-in-out.
- If the instruction asks to remove motion ("no animation", "make it still"), remove every animation property and any <style> of keyframes the element carries, returning the element at rest.
- Animation is CSS only. No Remotion hooks, no state, no Math.random, no Date. Define NOTHING at module scope; reference NO undefined components.
- It must be valid TSX that compiles when inlined.`;

// Long inlined data-URIs are elided from READ-ONLY context (preamble + sibling
// summaries) — measured 97% of Arc's 505KB preamble was base64 ≈ ~130k junk
// tokens per regen. Never elided from the piece body itself: the model re-emits
// the body, and an elided URI there would ship a broken image.
/** Sibling context for the prompt — word-boundary truncated, never mid-token
 *  (lib/llm/safe-truncate.ts explains why that is load-bearing). */
const siblingLine = (p: DecomposedPiece): string =>
  `- ${p.id} (${p.kind}): ${promptDigest(elideDataUris(p.body))}`;

export interface RegenPieceInput {
  /** The decomposed module preamble (the frozen design system) — read-only context. */
  preamble: string;
  piece: DecomposedPiece;
  /** Other pieces in the same scene — read-only, for coherence + non-overlap. */
  siblings: DecomposedPiece[];
  sceneIndex: number;
  /** Optional free-text ask ("make it darker", "use a bar chart"). */
  instruction?: string;
  /**
   * The document's brand context as prompt text (lib/brand/brand-prompt.ts) —
   * the user's own brand rules and their uploaded materials. The preamble
   * tells the model what the design system IS; this tells it what the brand
   * REQUIRES and what it is allowed to reach for.
   */
  brandBlock?: string | null;
  model?: string;
  /** "animate": the element is finished; only its motion changes (ANIMATE_SYSTEM). */
  mode?: "regenerate" | "animate";
}
export interface RegenPieceResult {
  ok: boolean;
  body?: string;
  usage?: Usage;
  error?: string;
}

export const regeneratePiece = async (
  input: RegenPieceInput,
): Promise<RegenPieceResult> => {
  const { preamble, piece, siblings, sceneIndex, instruction } = input;
  const animate = input.mode === "animate";
  const model = input.model || MODELS.codingAgentBuild;
  const client = getBuildClient();

  const user = [
    `THIS ELEMENT to ${animate ? "animate" : "regenerate"} — scene ${sceneIndex}, id "${piece.id}", kind "${piece.kind}". Current JSX:`,
    "```tsx",
    piece.body.trim(),
    "```",
    "",
    siblings.length
      ? `SIBLING ELEMENTS in this scene (do NOT overlap or restyle these — context only${animate ? "; if they animate, stagger after their entrances" : ""}):\n${siblings.map(siblingLine).join("\n")}`
      : "(no sibling elements)",
    "",
    animate
      ? `MOTION INSTRUCTION: ${instruction?.trim() || "Give this element a purposeful entrance."}`
      : `INSTRUCTION: ${instruction?.trim() || "Regenerate this element with a fresh, higher-quality take on the same content and role."}`,
    "",
    "Re-emit ONLY the replacement JSX for THIS element.",
  ].join("\n");

  let response;
  try {
    response = await withTransientRetry(animate ? "animate-piece" : "regen-piece", () =>
      client.messages
        .stream(
        {
          model,
          max_tokens: 4000,
          // The preamble is per-video constant, so it lives in a CACHED system
          // block: iterative regens on the same video prefill it from cache
          // (z.ai honors Anthropic-compat caching — build calls measure 86-139k
          // cache-read tokens). Only the small piece+instruction turn re-prefills.
          system: [
            { type: "text", text: animate ? ANIMATE_SYSTEM : SYSTEM },
            // Placed BEFORE the cached design-system block so brand rules are
            // read as constraints on everything that follows. Uncached: it is
            // small, and it changes whenever the user edits their brand.
            ...(input.brandBlock
              ? [{ type: "text" as const, text: input.brandBlock }]
              : []),
            {
              type: "text",
              text: [
                "SHARED DESIGN SYSTEM (module consts already in scope — reference them, never redefine):",
                "```tsx",
                elideDataUris(preamble.trim()),
                "```",
              ].join("\n"),
              cache_control: { type: "ephemeral" },
            },
          ],
          messages: [{ role: "user", content: user }],
        },
          // INTERACTIVE cap. Without it this inherited the transport's 600s
          // build-stage default — so one stalled connection meant a user (and
          // the QA journey) staring at "Generating…" for up to ten minutes.
          // A timed-out attempt aborts, which withTransientRetry already
          // classifies as transient, so a stall now self-heals on the retry
          // instead of wedging the editor.
          { timeout: 120_000 },
        )
        .finalMessage(),
    );
  } catch (err) {
    return { ok: false, error: `regen-piece API error: ${err instanceof Error ? err.message : String(err)}` };
  }

  const usage = usageOf(response.usage);
  const text = response.content.find((c) => c.type === "text");
  const body = text && text.type === "text" ? stripCodeFence(text.text.trim()) : "";
  if (!body || body.length < 3) return { ok: false, usage, error: "empty regeneration" };
  // Reject an accidental full-file emission (imports / Section export) — we want a fragment.
  if (/^\s*import\b|export const Section/.test(body)) {
    return { ok: false, usage, error: "model emitted a full file, not an element fragment" };
  }
  return { ok: true, body, usage };
};
