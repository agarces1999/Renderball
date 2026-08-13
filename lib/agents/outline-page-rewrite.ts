/**
 * Rewrite ONE outline page from a user instruction (founder, 2026-08-13:
 * "allow me to edit the outline itself" — the AI half; the deterministic ops
 * live in outline-scene-ops.ts).
 *
 * Deliberately NOT the whole-outline loop: the model sees the deck's purpose,
 * the neighbouring page labels (so the rewritten page still belongs to its
 * story), the CURRENT page JSON, and the user's instruction — and returns
 * exactly one scene object. The result is spliced into the full script and
 * run through the SAME normalize + validate pass every generated outline
 * passes, with ONE corrective round on failure. The page the user approved
 * stays untouched unless the rewrite lands clean; there is no partial state.
 *
 * Transport: the outline's own Fireworks transport (castCall stage "outline")
 * — spend lands in the ledger at the transport, like every other call.
 */
import type { Scene, Script } from "../../src/schema";
import type { Usage } from "../usage";
import { addUsage, EMPTY_USAGE } from "../usage";
import {
  fireworksScriptTransport,
  type ScriptTransport,
} from "./script-generator";
import { normalizeScriptContent, validateScript } from "./schema-validator";
import { renumberScenes } from "./outline-scene-ops";

export interface PageRewriteResult {
  ok: boolean;
  /** The full script with the rewritten page spliced in (renumbered). */
  script?: Script;
  scene?: Scene;
  usage: Usage;
  /** Human sentence when !ok. */
  error?: string;
}

const contract = (index: number): string =>
  `Return ONLY a JSON object of the shape {"scene": { ... }} — the COMPLETE rewritten scene object for page ${index + 1}. ` +
  `Keep "id", "index", "start_seconds" and "end_seconds" EXACTLY as they are in the current page. ` +
  `Every content rule from the system prompt applies to this one scene.`;

const userMessage = (
  script: Script,
  index: number,
  instruction: string,
): string => {
  const neighbours = script.scenes
    .map((s, i) => `${i + 1}. ${s.label || s.content?.headline || "(untitled)"}${i === index ? "   ← THE PAGE BEING REWRITTEN" : ""}`)
    .join("\n");
  return [
    `A user is editing one page of an approved ${script.config.kind === "deck" ? "deck outline" : "story"}. Rewrite THAT PAGE ONLY.`,
    ``,
    `The deck, page by page (for narrative fit — do not rewrite the others):`,
    neighbours,
    ``,
    `The current page ${index + 1}, as JSON:`,
    JSON.stringify(script.scenes[index], null, 2),
    ``,
    `The user's instruction for this page:`,
    instruction.trim(),
    ``,
    contract(index),
  ].join("\n");
};

/** Split a validator verdict into its individual complaint segments. */
const complaintSegments = (input: unknown): string[] => {
  const v = validateScript(normalizeScriptContent(input));
  if (v.ok) return [];
  return v.error
    .split(" | ")
    .map((seg) => seg.trim())
    .filter(Boolean);
};

/**
 * Complaints present after the splice that were NOT present before it —
 * the only ones this rewrite is answerable for. Exported for tests.
 */
export const complaintsIntroduced = (before: unknown, after: unknown): string[] => {
  const baseline = new Set(complaintSegments(before));
  return complaintSegments(after).filter((seg) => !baseline.has(seg));
};

/** Parse the model's reply into a scene object, tolerating {scene:{…}} or a bare scene. */
export const parseSceneReply = (text: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const scene = (parsed.scene ?? parsed) as Record<string, unknown>;
    return scene && typeof scene === "object" && "content" in scene ? scene : null;
  } catch {
    return null;
  }
};

export const rewriteOutlinePage = async (
  script: Script,
  sceneIndex: number,
  instruction: string,
  transport: ScriptTransport = fireworksScriptTransport,
): Promise<PageRewriteResult> => {
  if (sceneIndex < 0 || sceneIndex >= script.scenes.length) {
    return { ok: false, usage: EMPTY_USAGE, error: "That page no longer exists." };
  }
  if (!instruction.trim()) {
    return { ok: false, usage: EMPTY_USAGE, error: "Say what should change on this page." };
  }

  let usage = EMPTY_USAGE;
  let lastError = "The rewrite didn't come together.";
  let user = userMessage(script, sceneIndex, instruction);

  // One attempt + one corrective round — the same convergence posture as
  // everything else tonight: a correction that repeats its complaint is not
  // going to land on round three.
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await transport([{ role: "user", content: user }]);
    usage = addUsage(usage, r.usage);

    const sceneRaw = parseSceneReply(r.text);
    if (!sceneRaw) {
      lastError = "The model's reply was not a valid page.";
      user = `${user}\n\nYour previous reply could not be parsed as JSON. ${contract(sceneIndex)}`;
      continue;
    }

    // Pin the invariants the contract asked to keep — a model that drifted
    // them is corrected silently rather than failed, because the drift is
    // mechanical and the user's instruction is about CONTENT.
    const current = script.scenes[sceneIndex];
    const pinned = {
      ...sceneRaw,
      id: current.id,
      index: current.index,
      start_seconds: current.start_seconds,
      end_seconds: current.end_seconds,
    };

    const spliced = {
      ...script,
      scenes: script.scenes.map((s, i) => (i === sceneIndex ? pinned : s)),
    };
    const normalized = normalizeScriptContent(spliced) as Script;
    // THE RULE: the rewrite must not make validation WORSE — never "the whole
    // script must be perfect". The outline gates are closed whitelists
    // (docs: outline gate arithmetic), and a user's hand-edited page 1 can
    // legitimately carry complaints; those must not hold page 3's rewrite
    // hostage. So the baseline script's complaints are computed once and only
    // NEW complaints (introduced by this splice) block.
    const newComplaints = complaintsIntroduced(script, normalized);
    if (newComplaints.length === 0) {
      const finalScript = renumberScenes(normalized);
      return {
        ok: true,
        script: finalScript,
        scene: finalScript.scenes[sceneIndex],
        usage,
      };
    }
    lastError = `The rewritten page failed the outline checks: ${newComplaints[0]}`;
    user =
      `${user}\n\nYour previous rewrite was rejected by validation:\n${newComplaints.join("\n")}\n\n` +
      `Fix ONLY those problems and reply again. ${contract(sceneIndex)}`;
  }

  return { ok: false, usage, error: lastError };
};
