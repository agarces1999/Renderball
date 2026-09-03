/**
 * Element provenance — the instruction that created each element, kept.
 *
 * Founder ask (2026-08-14, from the Gamma comparison): click an element and
 * see the prompt behind it, edit that prompt, regenerate. Until now the
 * product THREW AWAY every creation instruction the moment it was fulfilled —
 * the marquee ask, the regen instruction — so the panel had nothing to show.
 * This sidecar remembers them.
 *
 * Storage: `provenance.json` next to the composition, exactly like
 * brand.json (lib/brand/document-brand.ts) — travels with the document
 * through the R2 bundle, survives redeploys, owner-scoped by the same
 * genDir resolution every editor route already performs.
 *
 * Coverage is deliberately partial: only elements a USER instruction touched
 * (marquee-generate, per-element regen, hand-adds) get entries. Elements born
 * in the original build share their page's visual_concept as context — the
 * panel reads that from the script directly, so absence here is not a gap in
 * the UI, just a different honest label ("born with this page").
 *
 * Best-effort by doctrine: a provenance write must never fail the edit it
 * annotates. A lost entry costs a label, not a document.
 */
import { promises as fs } from "fs";
import path from "path";

export type ProvenanceOrigin = "marquee" | "regen" | "added";

export interface ElementProvenance {
  origin: ProvenanceOrigin;
  /** The user's words, verbatim. Absent for deterministic hand-adds. */
  prompt?: string;
  /** The last MOTION instruction ("fade up from below", "draw the line in").
   *  Its own field, not `prompt`: animating an element must not overwrite the
   *  instruction that made it, or the panel's "Edit the prompt" box would
   *  re-seed with a motion ask and a regenerate would rebuild the element
   *  from it. */
  motion?: string;
  at: string;
  /**
   * Generation facts for diffusion-made pieces (image/icon), kept so a later
   * generation can RESEMBLE this one (founder, 2026-08-14: "keep using the
   * same icon family"): same model + same seed + a cached style description
   * of the actual pixels. styleDescriptor is written lazily by the first
   * match that needs it (one vision read, then cached forever).
   */
  genMeta?: {
    kind: "image" | "icon";
    model: string;
    seed: number;
    /** The `assets/…` ref of the delivered PNG — what the vision read opens. */
    assetRef: string;
    styleDescriptor?: string;
  };
}

export type ProvenanceMap = Record<string, ElementProvenance>;

const fileOf = (genDir: string): string => path.join(genDir, "provenance.json");

export const readProvenance = async (genDir: string): Promise<ProvenanceMap> => {
  try {
    const raw = await fs.readFile(fileOf(genDir), "utf8");
    const parsed = JSON.parse(raw) as ProvenanceMap;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

/**
 * THE writer. Patches one entry, preserving what is already there.
 *
 * There used to be a second writer, `recordProvenance`, which replaced the
 * whole entry. The insert route called record-then-merge, so the merge put the
 * generation facts straight back and nothing was lost. The regenerate route
 * called only record — so regenerating a generated icon or image DELETED its
 * `genMeta`, and `pickStyleReference` (style-match.ts) skips any entry without
 * one. "Match my existing icons" therefore lost the family the first time you
 * regenerated a member of it, silently, which is exactly what this function's
 * preservation was written to prevent.
 *
 * Keeping `at` from the previous entry is deliberate: it means "when this
 * element was created", which is the ordering `pickStyleReference` wants. The
 * replacing writer reset it to now, so which icon became the style reference
 * depended on which one you had touched most recently rather than which one you
 * had made most recently.
 */
export const mergeProvenance = async (
  genDir: string,
  pieceId: string,
  patch: Partial<Omit<ElementProvenance, "at">>,
): Promise<void> => {
  try {
    if (!pieceId) return;
    const map = await readProvenance(genDir);
    const prev = map[pieceId];
    const merged: ElementProvenance = {
      ...(prev ?? { origin: "added" as const, at: new Date().toISOString() }),
      ...patch,
      origin: patch.origin ?? prev?.origin ?? "added",
      at: prev?.at ?? new Date().toISOString(),
    };
    if (patch.genMeta || prev?.genMeta) {
      // A styleDescriptor describes SPECIFIC pixels: when the patch points at
      // a different asset, the old description must not ride along onto
      // pixels it has never seen.
      const sameAsset =
        !patch.genMeta?.assetRef ||
        !prev?.genMeta?.assetRef ||
        patch.genMeta.assetRef === prev.genMeta.assetRef;
      const carried = sameAsset ? prev?.genMeta : { ...prev?.genMeta, styleDescriptor: undefined };
      merged.genMeta = { ...(carried ?? {}), ...(patch.genMeta ?? {}) } as ElementProvenance["genMeta"];
      if (merged.genMeta && merged.genMeta.styleDescriptor === undefined) delete merged.genMeta.styleDescriptor;
    }
    map[pieceId] = merged;
    await fs.writeFile(fileOf(genDir), JSON.stringify(map, null, 2), "utf8");
  } catch (err) {
    console.warn(`[provenance] merge for ${pieceId} failed — the edit itself is unaffected:`, err);
  }
};

