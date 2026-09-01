/**
 * Apply a document's brand to the document — deterministically, 0 tokens.
 *
 * CRITICAL detail this is built around: `Composition.tsx` is an ARTIFACT, not
 * the source of truth. Every editor mutation goes through
 * `reassembleFromDisk`, which rebuilds it from `lego/manifest.json`'s
 * `preamble` (where the brand constants actually live) plus the individual
 * `lego/pieces/<id>.tsx` bodies. Re-skinning only Composition.tsx would look
 * correct until the user's very next edit, which would silently reassemble
 * from the un-skinned preamble and revert their brand. So the re-skin is
 * applied to the SOURCES and the composition is regenerated from them.
 *
 * Safety: the result is compile-verified before it replaces anything (the
 * same `commitGenDir` contract every other edit uses), an undo entry is
 * captured first, and the document is republished so the change survives a
 * redeploy.
 */
import { promises as fs } from "fs";
import path from "path";
import {
  captureUndo,
  commitUndo,
  decomposeGenDir,
  healStaleStore,
  readDecomposed,
  readManifest,
  writeManifest,
} from "../agents/lego-store";
import { commitGenDir } from "../edit/commit";
import { persistGenDir } from "../render/gen-store";
import { readDocumentBrand, type DocumentBrand } from "./document-brand";
import { reskinComposition, resolveRoleColors, type ReskinChange } from "./reskin";

export interface ApplyBrandResult {
  ok: boolean;
  changes: ReskinChange[];
  error?: string;
}

/**
 * Re-skin every source the composition is assembled from, then rebuild it.
 *
 * `brand` defaults to the document's stored brand.json, so callers that just
 * saved the brand can call this with no second argument.
 */
export const applyBrandToDocument = async (
  genDir: string,
  brandInput?: DocumentBrand,
): Promise<ApplyBrandResult> => {
  const brand = brandInput ?? (await readDocumentBrand(genDir));
  const nothingToDo =
    Object.keys(brand.palette ?? {}).length === 0 &&
    !brand.fonts?.display &&
    !brand.fonts?.body &&
    !brand.fonts?.mono &&
    !(brand.fonts?.faces ?? []).length &&
    !brand.logo;
  if (nothingToDo) return { ok: true, changes: [] };

  const undo = await captureUndo(genDir);
  const changes: ReskinChange[] = [];

  try {
    // The lego store is created LAZILY on a document's first edit, so a deck
    // that has only ever been built has no manifest yet. Decompose first, the
    // same way every other editor op implicitly relies on. If the document
    // cannot be decomposed (an older build with no <Piece> markers), fall
    // through to rewriting Composition.tsx directly — a re-skin should still
    // work there, it just will not survive a later structural edit.
    const hasLego = await fs
      .access(path.join(genDir, "lego", "manifest.json"))
      .then(() => true)
      .catch(() => false);
    if (!hasLego) await decomposeGenDir(genDir);
    const decomposable = await fs
      .access(path.join(genDir, "lego", "manifest.json"))
      .then(() => true)
      .catch(() => false);

    if (!decomposable) {
      const current0 = await fs.readFile(path.join(genDir, "Composition.tsx"), "utf8");
      const r = reskinComposition(current0, brand);
      if (r.changes.length > 0) {
        await fs.writeFile(path.join(genDir, "Composition.tsx"), r.code, "utf8");
        await commitUndo(genDir, undo, "brand");
        await persistGenDir(path.basename(genDir));
        return { ok: true, changes: r.changes };
      }
      await commitUndo(genDir, undo, "brand");
      return { ok: true, changes: [] };
    }

    // A document rehydrated from R2 can carry a store that predates its build.
    // Re-skinning through it drops every scene the store does not know about,
    // which surfaced as "brand would stop page 2..6 rendering, so it was not
    // applied" — the safety check firing on a store problem, not a brand one.
    try {
      await healStaleStore(genDir);
    } catch (err) {
      console.warn(`[apply-brand] stale-store check failed for ${genDir}:`, err);
    }

    // 1. The preamble — where PALETTE / FONT_* / BRAND_FONTS_CSS live. The
    //    role→literal mapping is derived from the CURRENT composition, which
    //    contains the preamble, so mappings resolve against real values.
    const current = await fs
      .readFile(path.join(genDir, "Composition.tsx"), "utf8")
      .catch(() => "");
    // Resolve roles ONCE, against the whole composition, and reuse that map
    // for every fragment below. Resolving per-fragment made unrelated colours
    // in different pieces all collapse into the accent.
    const roleMap = resolveRoleColors(current || (await readManifest(genDir)).preamble);

    const manifest = await readManifest(genDir);
    if (manifest.preamble) {
      const r = reskinComposition(manifest.preamble, brand, roleMap);
      if (r.changes.length > 0) {
        manifest.preamble = r.code;
        changes.push(...r.changes);
        await writeManifest(genDir, manifest);
      }
    }

    // 2. Each piece body — pieces inline literal hex values alongside the
    //    shared consts, so a colour swap has to reach them too.
    const decomposed = await readDecomposed(genDir);
    const legoDir = path.join(genDir, "lego", "pieces");
    for (const scene of decomposed.scenes ?? []) {
      for (const piece of scene.pieces ?? []) {
        const r = reskinComposition(piece.body, brand, roleMap);
        if (r.changes.length === 0) continue;
        // Re-skinning a body must never make it unparseable; skip any piece
        // the rewrite would break rather than poisoning the whole document.
        await fs.writeFile(
          path.join(legoDir, `${piece.id}.tsx`),
          r.code,
          "utf8",
        );
        for (const c of r.changes) {
          if (!changes.some((x) => x.kind === c.kind && x.from === c.from)) changes.push(c);
        }
      }
    }

    // 3. Rebuild Composition.tsx from the re-skinned sources. commitGenDir
    //    compile-verifies before writing and republishes to durable storage.
    const committed = await commitGenDir(genDir, "brand", { checkRender: true });
    if (!committed.ok) {
      // RESTORE the store, don't merely record it (founder's Deel doc,
      // 2026-08-31): a refused apply left the mutated manifest and pieces on
      // disk, divergent from the rolled-back composition — the next
      // successful reassembly would have resurrected the refused change.
      if (undo) {
        await writeManifest(genDir, undo.manifest).catch(() => {});
        const legoDir = path.join(genDir, "lego", "pieces");
        for (const [name, body] of Object.entries(undo.pieces)) {
          await fs.writeFile(path.join(legoDir, name), body, "utf8").catch(() => {});
        }
      }
      return { ok: false, changes: [], error: committed.error };
    }

    // 4. If the sources produced no change but the composition still holds old
    //    values (a document with no lego store — e.g. an older build), fall
    //    back to rewriting the artifact directly so the user still sees it.
    if (changes.length === 0 && current) {
      const r = reskinComposition(current, brand, roleMap);
      if (r.changes.length > 0) {
        await fs.writeFile(path.join(genDir, "Composition.tsx"), r.code, "utf8");
        changes.push(...r.changes);
      }
    }

    await commitUndo(genDir, undo, "brand");
    return { ok: true, changes };
  } catch (err) {
    await commitUndo(genDir, undo, "brand-error").catch(() => {});
    return {
      ok: false,
      changes: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
};
