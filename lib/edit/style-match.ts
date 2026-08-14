/**
 * Style matching for generated icons/images — "make this one look like the
 * ones I already made" (founder, 2026-08-14: users keep an icon FAMILY, not
 * a style zoo).
 *
 * Resemblance is engineered with the three levers the callable models give
 * us, applied together:
 *   1. SAME MODEL — each classic model has an unmistakable hand.
 *   2. SAME SEED — with the shared style scaffold, seed reuse rhymes the
 *      rendering (stroke weight, shading behavior) across subjects.
 *   3. A STYLE DESCRIPTOR of the reference's actual pixels — Kimi (the one
 *      vision transport, per CLAUDE.md images go ONLY through callZaiVision)
 *      reads the reference PNG once and answers with a compact style-only
 *      fragment ("bold black outlines, flat orange fill, sticker rim…")
 *      that is appended to the new prompt. Cached in the provenance sidecar,
 *      so a family of N icons costs ONE vision read, not N.
 *
 * The reference is the newest generated piece of the same kind that carries
 * genMeta — server-resolved, so the toggle in the bar is just `match: true`
 * and works across every page of the document. No reference → generate
 * unmatched; a fresh first icon is the correct degradation, not an error.
 */
import { promises as fs } from "fs";
import path from "path";
import { callZaiVision } from "../render/zai-vision";
import {
  readProvenance,
  mergeProvenance,
  type ElementProvenance,
  type ProvenanceMap,
} from "./provenance";

export interface StyleReference {
  pieceId: string;
  genMeta: NonNullable<ElementProvenance["genMeta"]>;
}

/** Newest same-kind generated piece with generation facts. Pure — testable. */
export const pickStyleReference = (
  map: ProvenanceMap,
  kind: "image" | "icon",
): StyleReference | null => {
  let best: StyleReference | null = null;
  let bestAt = "";
  for (const [pieceId, entry] of Object.entries(map)) {
    const gm = entry.genMeta;
    if (!gm || gm.kind !== kind) continue;
    if (entry.at > bestAt) {
      bestAt = entry.at;
      best = { pieceId, genMeta: gm };
    }
  }
  return best;
};

/** Append a style fragment to a prompt. Pure — testable. */
export const withStyleHint = (prompt: string, descriptor: string | undefined): string =>
  descriptor ? `${prompt}, in this exact visual family: ${descriptor}` : prompt;

const DESCRIBE_PROMPT =
  "Describe ONLY the visual style of this graphic as one compact comma-separated fragment for an image-generation prompt: line weight, fill style, corner treatment, dominant colors, shading, overall mood. Never name the subject or any object in it. Answer with the fragment only.";

/**
 * The reference's style descriptor — cached on its provenance entry; computed
 * with one vision read the first time a match asks for it. Any failure
 * (missing asset, vision error) returns undefined: matching degrades to
 * model+seed reuse, the generation itself never fails on the hint.
 */
export const styleDescriptorFor = async (
  genDir: string,
  ref: StyleReference,
): Promise<string | undefined> => {
  if (ref.genMeta.styleDescriptor) return ref.genMeta.styleDescriptor;
  try {
    const bytes = await fs.readFile(path.join(genDir, ref.genMeta.assetRef));
    const res = await callZaiVision(bytes.toString("base64"), DESCRIBE_PROMPT, {
      disableThinking: true,
      maxTokens: 160,
      stage: "style-match",
    });
    const descriptor = res.text?.trim().replace(/\s+/g, " ").slice(0, 300);
    if (!descriptor) return undefined;
    await mergeProvenance(genDir, ref.pieceId, {
      genMeta: { ...ref.genMeta, styleDescriptor: descriptor },
    });
    return descriptor;
  } catch (err) {
    console.warn(`[style-match] descriptor read failed (matching degrades to seed/model):`, err);
    return undefined;
  }
};

export interface ResolvedStyle {
  model: string;
  seed: number;
  descriptor?: string;
}

/** The whole resolution: reference → {model, seed, descriptor?} or null. */
export const resolveStyleMatch = async (
  genDir: string,
  kind: "image" | "icon",
): Promise<ResolvedStyle | null> => {
  const map = await readProvenance(genDir);
  const ref = pickStyleReference(map, kind);
  if (!ref) return null;
  const descriptor = await styleDescriptorFor(genDir, ref);
  return { model: ref.genMeta.model, seed: ref.genMeta.seed, descriptor };
};
