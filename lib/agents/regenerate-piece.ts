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
import { getAnthropic, MODELS } from "../anthropic";
import { withTransientRetry } from "./transient-retry";
import { stripCodeFence, elideDataUris } from "./code-extraction";
import { usageOf, type Usage } from "../usage";
import type { DecomposedPiece } from "./lego-decompose";

const SYSTEM = `You regenerate ONE element ("piece") of an animated brand-video scene, IN PLACE.

You are given the scene's shared design system (module consts already in scope) and the element's current JSX. Re-emit ONLY the replacement JSX for this ONE element.

HARD RULES:
- Output ONLY the JSX for this ONE element — no imports, no prose, no markdown fence, no <Piece> wrapper. It is inlined verbatim where the old element was.
- Reference the shared consts (PALETTE.*, FONT_DISPLAY/FONT_BODY/FONT_MONO, LOGO_SRC, the @keyframes names, EASE_* etc.) EXACTLY as the current element and its siblings do. NEVER invent new colors, fonts, or @keyframes — reuse only what already exists. Match the scene's design grammar (corner radius, stroke weight, shadow recipe, mono-for-data convention).
- Keep this element's ROLE, FORM, and rough BOUNDS. MATCH THE CURRENT ELEMENT'S FORM: if the current JSX is a call to a shared component (e.g. <FormatCard x={..} y={..} .../>, <StatTile .../>), return that SAME component with adjusted props and KEEP its positioning props (x/y/left/top/w/h) so it stays in place — do NOT convert it into a raw <div>. If the current JSX is raw positioned markup, keep position:absolute + the same left/top region. Either way a text element stays text, a mock stays a mock, an image stays an image, and you do NOT overlap the sibling elements listed.
- Animation is CSS only — reuse the existing @keyframes by name. No Remotion hooks (no useCurrentFrame/useVideoConfig), no Math.random (hardcode any "random-looking" values).
- Define NOTHING at module scope and reference NO undefined components — use only the provided consts + inline JSX/SVG (and <Img> for images).
- It must be valid TSX that compiles when inlined.`;

// Long inlined data-URIs are elided from READ-ONLY context (preamble + sibling
// summaries) — measured 97% of Arc's 505KB preamble was base64 ≈ ~130k junk
// tokens per regen. Never elided from the piece body itself: the model re-emits
// the body, and an elided URI there would ship a broken image.
const siblingLine = (p: DecomposedPiece): string =>
  `- ${p.id} (${p.kind}): ${elideDataUris(p.body).replace(/\s+/g, " ").trim().slice(0, 150)}`;

export interface RegenPieceInput {
  /** The decomposed module preamble (the frozen design system) — read-only context. */
  preamble: string;
  piece: DecomposedPiece;
  /** Other pieces in the same scene — read-only, for coherence + non-overlap. */
  siblings: DecomposedPiece[];
  sceneIndex: number;
  /** Optional free-text ask ("make it darker", "use a bar chart"). */
  instruction?: string;
  model?: string;
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
  const model = input.model || MODELS.codingAgentBuild;
  const client = getAnthropic();

  const user = [
    `THIS ELEMENT to regenerate — scene ${sceneIndex}, id "${piece.id}", kind "${piece.kind}". Current JSX:`,
    "```tsx",
    piece.body.trim(),
    "```",
    "",
    siblings.length
      ? `SIBLING ELEMENTS in this scene (do NOT overlap or restyle these — context only):\n${siblings.map(siblingLine).join("\n")}`
      : "(no sibling elements)",
    "",
    `INSTRUCTION: ${instruction?.trim() || "Regenerate this element with a fresh, higher-quality take on the same content and role."}`,
    "",
    "Re-emit ONLY the replacement JSX for THIS element.",
  ].join("\n");

  let response;
  try {
    response = await withTransientRetry("regen-piece", () =>
      client.messages
        .stream({
          model,
          max_tokens: 4000,
          // The preamble is per-video constant, so it lives in a CACHED system
          // block: iterative regens on the same video prefill it from cache
          // (z.ai honors Anthropic-compat caching — build calls measure 86-139k
          // cache-read tokens). Only the small piece+instruction turn re-prefills.
          system: [
            { type: "text", text: SYSTEM },
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
        })
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
