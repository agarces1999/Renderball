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
  at: string;
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

/** Merge one entry in (read-modify-write; last writer wins per pieceId). */
export const recordProvenance = async (
  genDir: string,
  pieceId: string,
  entry: Omit<ElementProvenance, "at">,
): Promise<void> => {
  try {
    if (!pieceId) return;
    const map = await readProvenance(genDir);
    map[pieceId] = { ...entry, at: new Date().toISOString() };
    await fs.writeFile(fileOf(genDir), JSON.stringify(map, null, 2), "utf8");
  } catch (err) {
    console.warn(`[provenance] write for ${pieceId} failed — the edit itself is unaffected:`, err);
  }
};
