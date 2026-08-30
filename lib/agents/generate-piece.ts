//
// Generate a BRAND-NEW element ("piece") from a prompt + a marquee box — the
// editor's "draw an area, type what goes there" feature. The LLM counterpart of
// regenerate-piece.ts: same frozen design system (cached preamble system block) +
// read-only siblings for cohesion, but it CREATES an element from scratch instead
// of rewriting an existing one.
//
// Hard-bounds guarantee: the model returns ONLY the inner JSX that fills a
// 100%×100% box; the caller (insert-element.ts) wraps that in a deterministic
// absolutely-positioned box at the marquee bounds. So the element can never escape
// or mis-size the drawn area regardless of what the model emits.
//
import { MODELS } from "../anthropic";
import { promptDigest } from "../llm/safe-truncate";
import { getBuildClient } from "../llm/build-client";
import { withTransientRetry } from "./transient-retry";
import { stripCodeFence, elideDataUris } from "./code-extraction";
import { usageOf, type Usage } from "../usage";
import type { DecomposedPiece } from "./lego-decompose";

const SYSTEM = `You CREATE ONE brand-new element ("piece") for an animated brand-video scene, from a prompt.

You are given the scene's shared design system (module consts already in scope) and the other elements as read-only context. Emit ONLY the inner JSX for this ONE new element.

HARD RULES:
- Output ONLY the JSX for this ONE element — no imports, no prose, no markdown fence, no <Piece> wrapper, no positioning wrapper. It is inlined inside a box that is ALREADY absolutely positioned and sized to the user's drawn area.
- Your element fills a box of EXACTLY the given width × height. Size internals with percentages / flex / fixed px that fit that box. Do NOT emit position:absolute, left, top, right, bottom, width, or height on your OUTERMOST element — the box owns placement and size. Fill it edge to edge.
- Reference the shared consts (PALETTE.*, INK/ACCENT/BG, FONT_DISPLAY/FONT_BODY/FONT_MONO, LOGO_SRC, the @keyframes names, EASE_* etc.) EXACTLY as the sibling elements do. NEVER invent new colors, fonts, or @keyframes — reuse only what already exists. Match the scene's design grammar (corner radius, stroke weight, shadow recipe, mono-for-data convention). If unsure of a color, inherit (color:"inherit") or use currentColor.
- Do NOT overlap or restyle the sibling elements listed — they stay as they are.
- Animation is CSS only — reuse the existing @keyframes by name. No Remotion hooks (no useCurrentFrame/useVideoConfig), no Math.random (hardcode any "random-looking" values).
- Define NOTHING at module scope and reference NO undefined components — use only the provided consts + inline JSX/SVG (and <Img> for images, lucide icons for icons).
- It must be valid TSX that compiles when inlined.`;

// Long inlined data-URIs are elided from READ-ONLY sibling context (measured ~130k
// junk tokens per call on image-heavy scenes) — same rationale as regenerate-piece.
/** Sibling context for the prompt — word-boundary truncated, never mid-token
 *  (lib/llm/safe-truncate.ts explains why that is load-bearing). */
const siblingLine = (p: DecomposedPiece): string =>
  `- ${p.id} (${p.kind}): ${promptDigest(elideDataUris(p.body))}`;

export interface GenPieceInput {
  /** The decomposed module preamble (the frozen design system) — read-only context. */
  preamble: string;
  /** Other pieces in the same scene — read-only, for coherence + non-overlap. */
  siblings: DecomposedPiece[];
  sceneIndex: number;
  /** The marquee box, canvas px — told to the model as the target size to fill. */
  bounds: { x: number; y: number; w: number; h: number };
  /** What the user typed under the drawn box. Required. */
  prompt: string;
  /** The document's brand rules + materials (lib/brand/brand-prompt.ts). This
   *  is marquee-to-generate's on-brand guarantee: the element created inside
   *  the user's box follows their brand, not just the old design system. */
  brandBlock?: string | null;
  model?: string;
  /** Error-fed retry (founder, 2026-08-29): the previous attempt's code and
   *  the ACTUAL render error, so the second attempt targets the defect
   *  instead of re-rolling the dice. */
  repair?: { previousBody: string; renderError: string };
}
export interface GenPieceResult {
  ok: boolean;
  /** The inner JSX (fills a 100%×100% box) — the caller wraps it at `bounds`. */
  body?: string;
  usage?: Usage;
  error?: string;
}

export const generatePiece = async (input: GenPieceInput): Promise<GenPieceResult> => {
  const { preamble, siblings, sceneIndex, bounds, prompt } = input;
  const model = input.model || MODELS.codingAgentBuild;
  const client = getBuildClient();

  const user = [
    `CREATE a new element for scene ${sceneIndex}. It will be placed in an absolutely-positioned box of EXACTLY ${Math.round(bounds.w)}px wide × ${Math.round(bounds.h)}px tall. Size your element to fill that box.`,
    "",
    siblings.length
      ? `SIBLING ELEMENTS in this scene (do NOT overlap or restyle these — context only, reference their consts/grammar for cohesion):\n${siblings.map(siblingLine).join("\n")}`
      : "(no sibling elements)",
    "",
    `WHAT TO CREATE: ${prompt.trim()}`,
    "",
    ...(input.repair
      ? [
          "A PREVIOUS ATTEMPT at this element was REFUSED because it crashed the page when rendered.",
          `Render error: ${input.repair.renderError}`,
          "The refused code:",
          "```tsx",
          input.repair.previousBody,
          "```",
          "Emit a CORRECTED replacement that cannot fail this way — reference ONLY names that exist in the shared design system above, no hooks, no imports.",
          "",
        ]
      : []),
    "Emit ONLY the inner JSX for this new element — it fills the box; do not position or size the outermost element.",
  ].join("\n");

  let response;
  try {
    response = await withTransientRetry("generate-piece", () =>
      client.messages
        .stream(
        {
          model,
          max_tokens: 4000,
          // The preamble is per-video constant → a CACHED system block, so iterative
          // inserts on the same video prefill it from cache (z.ai honors
          // Anthropic-compat caching), exactly like regenerate-piece.
          system: [
            { type: "text", text: SYSTEM },
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
    return { ok: false, error: `generate-piece API error: ${err instanceof Error ? err.message : String(err)}` };
  }

  const usage = usageOf(response.usage);
  const text = response.content.find((c) => c.type === "text");
  const body = text && text.type === "text" ? stripCodeFence(text.text.trim()) : "";
  if (!body || body.length < 3) return { ok: false, usage, error: "empty generation" };
  // Reject an accidental full-file emission (imports / Section export) — we want a fragment.
  if (/^\s*import\b|export const Section/.test(body)) {
    return { ok: false, usage, error: "model emitted a full file, not an element fragment" };
  }
  return { ok: true, body, usage };
};
