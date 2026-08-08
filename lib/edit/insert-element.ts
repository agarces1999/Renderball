//
// Insert a NEW element into a rendered scene — the editor's "add" path. Three modes:
//
//   primitive:       a text box / image / icon built from a deterministic code
//                    template, NO LLM, positioned at the marquee box. Free.
//   generate:        the marquee killer feature — an LLM (generatePiece) creates
//                    the element's inner JSX from a prompt; we wrap it at the box.
//   generate-image:  the marquee's Image mode — a diffusion model (image-provider)
//                    turns the prompt into a PNG, stored as a document asset and
//                    wrapped as an <Img> at the box. Billed per image.
//
// Both build the positioned wrapper DETERMINISTICALLY (the LLM never controls
// bounds), insert via lego-store.insertPiece, then reassemble → finalize →
// compile-check → write Composition.tsx, exactly like edit-layout.ts. On any
// failure the manifest + orphan body file are rolled back, so the store and render
// source never desync.
//
import { promises as fs } from "fs";
import { readDocumentBrand } from "../brand/document-brand";
import { brandPromptBlock } from "../brand/brand-prompt";
import path from "path";
import {
  readManifest,
  writeManifest,
  readDecomposed,
  insertPiece,
  nextPieceId,
  captureUndo,
  commitUndo,
} from "../agents/lego-store";
import { generatePiece } from "../agents/generate-piece";
import { lucideIconNameSet } from "../agents/finalize-refs";
import { commitGenDir } from "./commit";
import { withGenDirLock } from "./gendir-lock";
import { emitFreetextSpan, DEFAULT_FORMAT } from "./freetext";
import { saveImageAsset } from "./image-assets";
import { imageCall, ImageProviderError } from "../llm/image-provider";
import { recordUsage, EMPTY_USAGE, type Usage } from "../usage";
import { withSpend } from "../spend/context";
import { MODELS } from "../anthropic";

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A 1×1 transparent PNG — the swap-me placeholder for an inserted image. */
const PLACEHOLDER_IMG =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect width="200" height="120" fill="#e1e5eb"/><rect width="100" height="60" fill="#f5f7f9"/><rect x="100" y="60" width="100" height="60" fill="#f5f7f9"/><text x="100" y="66" font-family="sans-serif" font-size="12" fill="#69707e" text-anchor="middle">image</text></svg>`,
  );

const DEFAULT_ICON = "Sparkles";

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type InsertMode =
  | { mode: "primitive"; primitive: "text"; text?: string }
  | { mode: "primitive"; primitive: "image"; src?: string }
  | { mode: "primitive"; primitive: "icon"; icon?: string }
  | { mode: "generate"; prompt: string; kind?: string }
  | { mode: "generate-image"; prompt: string };

export interface InsertElementInput {
  genDir: string;
  scriptId: string;
  sceneIndex: number;
  bounds: Bounds;
  spec: InsertMode;
}

export type ParsedInsertBody =
  | { ok: true; scriptId: string; sceneIndex: number; bounds: Bounds; spec: InsertMode }
  | { ok: false; error: string };

/** Validate + normalize a raw insert-element request body (shared by the preview +
 *  dev routes). Pure — no fs; the orchestrator does the work. */
export const parseInsertBody = (raw: unknown): ParsedInsertBody => {
  const b = (raw ?? {}) as Record<string, unknown>;
  if (typeof b.scriptId !== "string" || !b.scriptId) return { ok: false, error: "scriptId required" };
  if (typeof b.sceneIndex !== "number" || b.sceneIndex < 0 || !Number.isInteger(b.sceneIndex)) {
    return { ok: false, error: "sceneIndex must be a non-negative integer" };
  }
  const rb = (b.bounds ?? {}) as Record<string, unknown>;
  const nums = [rb.x, rb.y, rb.w, rb.h];
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) {
    return { ok: false, error: "bounds must have finite numeric x, y, w, h" };
  }
  const bounds: Bounds = { x: rb.x as number, y: rb.y as number, w: rb.w as number, h: rb.h as number };
  if (bounds.w <= 0 || bounds.h <= 0) return { ok: false, error: "bounds width and height must be positive" };
  if (bounds.w > 20000 || bounds.h > 20000) return { ok: false, error: "bounds are out of range" };

  let spec: InsertMode;
  if (b.mode === "generate") {
    if (typeof b.prompt !== "string" || !b.prompt.trim()) {
      return { ok: false, error: "Say what to create — generation needs a prompt." };
    }
    spec = { mode: "generate", prompt: b.prompt, ...(typeof b.kind === "string" ? { kind: b.kind } : {}) };
  } else if (b.mode === "generate-image") {
    if (typeof b.prompt !== "string" || !b.prompt.trim()) {
      return { ok: false, error: "Describe the image — generation needs a prompt." };
    }
    spec = { mode: "generate-image", prompt: b.prompt };
  } else if (b.mode === "primitive") {
    if (b.primitive === "text") spec = { mode: "primitive", primitive: "text", ...(typeof b.text === "string" ? { text: b.text } : {}) };
    else if (b.primitive === "image") spec = { mode: "primitive", primitive: "image", ...(typeof b.src === "string" ? { src: b.src } : {}) };
    else if (b.primitive === "icon") spec = { mode: "primitive", primitive: "icon", ...(typeof b.icon === "string" ? { icon: b.icon } : {}) };
    else return { ok: false, error: 'primitive must be "text", "image", or "icon"' };
  } else {
    return { ok: false, error: 'mode must be "primitive", "generate", or "generate-image"' };
  }

  return { ok: true, scriptId: b.scriptId, sceneIndex: b.sceneIndex, bounds, spec };
};
export interface InsertElementResult {
  ok: boolean;
  pieceId?: string;
  code?: string;
  usage?: Usage;
  error?: string;
}

/** The shared reassemble → finalize → compile-check → write barrier (lib/edit/commit.ts). */
const commit = (genDir: string) => commitGenDir(genDir, "inserted element", { checkRender: true });

/** Highest zIndex among a scene's piece bodies (excluding chrome), so a new piece
 *  sits above content. Chrome is not offset-wrapped and keeps its DOM-last paint. */
const maxContentZ = async (genDir: string, sceneIndex: number): Promise<number> => {
  const d = await readDecomposed(genDir);
  const scene = d.scenes.find((s) => s.sceneIndex === sceneIndex);
  let max = 0;
  for (const p of scene?.pieces ?? []) {
    if (p.kind === "chrome") continue;
    for (const m of p.body.matchAll(/zIndex:\s*(\d+)/g)) max = Math.max(max, Number(m[1]));
  }
  return max;
};

/** Whether the frozen design system defines a given const. Const names vary by build
 *  path (a PALETTE object vs bare INK), so a primitive references a const only if present. */
const preambleHas = async (genDir: string, name: string): Promise<boolean> => {
  const m = await readManifest(genDir);
  return m.preamble.includes(name);
};

/** Build the deterministic positioned wrapper. The box owns placement + size; the
 *  inner content only fills it. Text kind flows height (maxWidth) so a wrapped label
 *  is never clipped. NB: the `<Piece>` shim (openTag) already renders data-piece /
 *  data-kind on a display:contents wrapper — so this inner box must NOT repeat them,
 *  or the piece would expose two [data-piece] nodes with the same id (duplicate key
 *  in the x-ray, double hit-test). Design-agent bodies carry no data-piece for the
 *  same reason; we match that. */
const wrap = (kind: string, b: Bounds, z: number, inner: string): string => {
  const x = Math.round(b.x);
  const y = Math.round(b.y);
  const w = Math.round(b.w);
  const h = Math.round(b.h);
  const sizing = kind === "text" ? `width: ${w}, maxWidth: ${w}` : `width: ${w}, height: ${h}, overflow: "hidden"`;
  return `<div style={{ position: "absolute", left: ${x}, top: ${y}, ${sizing}, zIndex: ${z} }}>${inner}</div>`;
};

/** Build a deterministic primitive's inner JSX. References NO palette const (color
 *  inherits / currentColor); references FONT_BODY only when the preamble defines it. */
const primitiveInner = async (genDir: string, spec: InsertMode): Promise<{ inner: string; kind: string }> => {
  if (spec.mode !== "primitive") throw new Error("primitiveInner called for a non-primitive");
  if (spec.primitive === "text") {
    const text = spec.text?.trim() || "Your text";
    // One shared emitter with the format-edit path (lib/edit/freetext.ts) so the
    // span's shape can never drift between insert and edit. The font const is
    // referenced only when the preamble actually declares it.
    const font = (await preambleHas(genDir, "FONT_BODY")) ? "FONT_BODY" : "";
    const inner = emitFreetextSpan(text, { ...DEFAULT_FORMAT, font });
    return { inner, kind: "text" };
  }
  if (spec.primitive === "image") {
    const src = spec.src?.trim() || PLACEHOLDER_IMG;
    const inner = `<Img src={${JSON.stringify(src)}} style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 8 }} />`;
    return { inner, kind: "image" };
  }
  // icon
  const requested = spec.icon?.trim();
  let icon = DEFAULT_ICON;
  if (requested) {
    const valid = await lucideIconNameSet();
    if (valid.has(requested)) icon = requested;
  }
  const inner = `<${icon} style={{ width: "100%", height: "100%" }} strokeWidth={1.5} />`;
  return { inner, kind: "diegetic" };
};

export const insertElement = async (input: InsertElementInput): Promise<InsertElementResult> => {
  const { genDir, scriptId, sceneIndex, bounds, spec } = input;
  if (![bounds.x, bounds.y, bounds.w, bounds.h].every(Number.isFinite) || bounds.w <= 0 || bounds.h <= 0) {
    return { ok: false, error: "bounds must be finite with positive width and height" };
  }

  // Attributes both doors this path opens — the coding-agent text call AND the
  // per-image SDXL call, which bills separately and bypasses castCall entirely.
  return withSpend({ stage: "edit.insert", scriptId }, () =>
  withGenDirLock(genDir, async () => {
    const snapshot = await readManifest(genDir);
    if (!snapshot.scenes.some((s) => s.sceneIndex === sceneIndex)) {
      return { ok: false, error: `scene ${sceneIndex} not found` };
    }

    // Build inner JSX + kind. Generate modes are billed (LLM tokens / per image);
    // primitives are free.
    let inner: string;
    let kind: string;
    let usage: Usage | undefined;
    let imageModel: string | undefined;
    if (spec.mode === "generate-image") {
      try {
        const img = await imageCall({ prompt: spec.prompt, width: bounds.w, height: bounds.h });
        const ref = await saveImageAsset(genDir, img.png, "png");
        imageModel = img.model;
        // Same shape as the primitive-image inner: the box owns the crop.
        inner = `<Img src=${JSON.stringify(ref)} style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 8 }} />`;
        kind = "image";
      } catch (e) {
        // Nothing was delivered, so nothing is billed — no ledger row.
        const friendly =
          e instanceof ImageProviderError && e.status === 401
            ? "Image generation isn't enabled for this account yet — ask us to switch it on."
            : `image generation failed: ${msg(e)}`;
        return { ok: false, error: friendly };
      }
    } else if (spec.mode === "generate") {
      const d = await readDecomposed(genDir);
      const scene = d.scenes.find((s) => s.sceneIndex === sceneIndex)!;
      const gen = await generatePiece({
        preamble: d.preamble,
        siblings: scene.pieces,
        sceneIndex,
        bounds,
        prompt: spec.prompt,
      });
      usage = gen.usage;
      if (!gen.ok || !gen.body) {
        if (usage) void recordUsage({ op: "insert-element", model: MODELS.codingAgentBuild, scriptId, usage, failed: true });
        return { ok: false, usage, error: gen.error || "generation failed" };
      }
      inner = gen.body;
      kind = spec.kind || "diegetic";
    } else {
      const p = await primitiveInner(genDir, spec);
      inner = p.inner;
      kind = p.kind;
    }

    const id = await nextPieceId(genDir, sceneIndex);
    const z = (await maxContentZ(genDir, sceneIndex)) + 1;
    const openTag = `<Piece id=${JSON.stringify(id)} kind=${JSON.stringify(kind)}>`;
    const body = wrap(kind, bounds, z, inner);

    // A post-generation failure still spent the tokens / billed the image.
    const logGenFail = () => {
      if (usage) void recordUsage({ op: "insert-element", model: MODELS.codingAgentBuild, scriptId, usage, failed: true });
      if (imageModel) void recordUsage({ op: "generate-image", model: imageModel, scriptId, usage: EMPTY_USAGE, images: 1, failed: true });
    };

    const undo = await captureUndo(genDir);
    try {
      const inserted = await insertPiece(genDir, { sceneIndex, id, kind, openTag, body });
      if (!inserted) {
        logGenFail();
        return { ok: false, usage, error: "insert failed — scene missing or id collision" };
      }
      const res = await commit(genDir);
      // The slot must have landed in the template — otherwise reassemble silently
      // dropped the piece. Assert the marker is present; roll back if not.
      if (!res.ok || !res.code || !res.code.includes(openTag)) {
        await writeManifest(genDir, snapshot);
        await fs.rm(path.join(genDir, "lego", "pieces", `${id}.tsx`), { force: true });
        logGenFail();
        return { ok: false, usage, error: res.error || "inserted element did not materialize in the composition" };
      }
      if (usage) void recordUsage({ op: "insert-element", model: MODELS.codingAgentBuild, scriptId, usage });
      if (imageModel) void recordUsage({ op: "generate-image", model: imageModel, scriptId, usage: EMPTY_USAGE, images: 1 });
      await commitUndo(genDir, undo, spec.mode === "primitive" ? "add" : spec.mode);
      return { ok: true, pieceId: id, code: res.code, usage };
    } catch (e) {
      await writeManifest(genDir, snapshot).catch(() => {});
      await fs.rm(path.join(genDir, "lego", "pieces", `${id}.tsx`), { force: true }).catch(() => {});
      logGenFail();
      return { ok: false, usage, error: `insert failed: ${msg(e)}` };
    }
  }),
  );
};
