/**
 * Scene attribution for scoped retries (#1).
 *
 * When a quality gate fails, the pipeline can either regenerate the WHOLE
 * composition (every scene, full output — the dominant build cost) or, when the
 * failure is confined to specific scenes, regenerate ONLY those scenes and
 * splice them back (section-splice.ts). This module decides which: it maps the
 * cleanly-localizable design-pass gate failures — sparse density, off-canvas
 * crop, baked-in (unbound) copy — to the scene index they belong to, and bundles
 * them into one fix instruction per scene.
 *
 * Gates that can't be tied to a single scene (contrast, throughline, invented
 * claims, logo defects, font coverage, …) are NOT handled here; the caller
 * treats their presence as a signal to fall back to a whole-composition retry.
 * Every scoped result is re-gated + re-compiled before it can ship, so an
 * imprecise attribution costs at most a wasted scene regen, never a bad render.
 *
 * Density localization is the reason this needs section-splice: the file-level
 * `assessDesignDensity` deliberately doesn't scope per-section ("the agent's
 * component naming varies"). With reliable Section{N} ranges, we CAN scope it —
 * and per-scene density is strictly sharper than the file total (a rich scene
 * can no longer mask a sparse one).
 */
import {
  findOverflowingElements,
  findUnboundCopy,
  assessVerticalFill,
  type AspectRatio,
} from "./quality-gates";
import { sectionRange, sceneIndexAt, listSectionIndices } from "./section-splice";

export interface ScopedFailure {
  scene: number;
  message: string;
}

/** Defensive read of a scene's structured content (mirrors assessDesignDensity). */
const contentOf = (scene: unknown): Record<string, unknown> =>
  ((scene as { content?: Record<string, unknown> })?.content ?? {}) as Record<
    string,
    unknown
  >;

const countTag = (block: string, rx: RegExp): number =>
  (block.match(rx) ?? []).length;

/**
 * Per-scene density deficits. For each scene with a Section{i} block, count the
 * rendered content elements inside that block and compare to what the scene's
 * content asked for. Returns one ScopedFailure per under-rendered scene.
 *
 * Only fires for scenes whose Section{i} block is locatable — a scene with no
 * resolvable block is left to the file-level gate (and the whole-comp fallback).
 */
export const densityFailuresByScene = (
  code: string,
  scenes: unknown[],
): ScopedFailure[] => {
  const out: ScopedFailure[] = [];
  for (let i = 0; i < scenes.length; i++) {
    const range = sectionRange(code, i);
    if (!range) continue; // unlocatable section → file-level gate owns it
    const block = code.slice(range.start, range.end);
    const c = contentOf(scenes[i]);

    const want = {
      headline: typeof c.headline === "string" && c.headline ? 1 : 0,
      lede: typeof c.lede === "string" && c.lede ? 1 : 0,
      bullets: Array.isArray(c.bullets) ? c.bullets.length : 0,
      svg: typeof c.illustration === "string" && c.illustration ? 1 : 0,
      img: Array.isArray(c.asset_ids) ? c.asset_ids.length : 0,
    };
    const have = {
      headline: countTag(block, /<h[123]\b/gi),
      lede: countTag(block, /<p\b/gi),
      bullets: countTag(block, /<li\b/gi),
      svg: countTag(block, /<svg\b/gi),
      img: countTag(block, /<Img\b/gi),
    };

    const deficits: string[] = [];
    if (want.headline && have.headline < want.headline)
      deficits.push(`headline (need an <h1>/<h2>/<h3>, found ${have.headline})`);
    if (want.lede && have.lede < want.lede)
      deficits.push(`lede paragraph (need a <p>, found ${have.lede})`);
    if (want.bullets && have.bullets < want.bullets)
      deficits.push(`${want.bullets} bullet(s) as <li> (found ${have.bullets})`);
    if (want.svg && have.svg < want.svg)
      deficits.push(`an inline <svg> illustration (found ${have.svg})`);
    if (want.img && have.img < want.img)
      deficits.push(`${want.img} <Img> mount(s) (found ${have.img})`);

    if (deficits.length > 0) {
      out.push({
        scene: i,
        message: `Sparse scene — render every content field: ${deficits.join(
          ", ",
        )}. Bind each from the script (const c = script.scenes[${i}].content) and render it: headline → <h1>/<h2>, lede → <p>, bullets → a real <ul> with one <li> each, illustration → an inline <svg>.`,
      });
    }
  }
  return out;
};

/**
 * Per-scene overflow. Reuses the canonical geometry-aware detector for the
 * DECISION (which widths crop), then attributes each offending width to the
 * scene whose Section{i} block contains it. A width that can't be located
 * inside any section (it lives in the chrome/preamble) is dropped here and left
 * to the file-level structural gate + whole-comp fallback.
 */
export const overflowFailuresByScene = (
  code: string,
  aspect: AspectRatio,
): ScopedFailure[] => {
  const widths = findOverflowingElements(code, aspect);
  if (widths.length === 0) return [];
  const byScene = new Map<number, Set<number>>();
  for (const w of widths) {
    // Locate each occurrence of this width in an inline style and attribute it.
    const rx = new RegExp(`\\bwidth:\\s*["']?${w}(?:px)?["']?`, "g");
    for (let m = rx.exec(code); m; m = rx.exec(code)) {
      const scene = sceneIndexAt(code, m.index);
      if (scene === null) continue;
      if (!byScene.has(scene)) byScene.set(scene, new Set());
      byScene.get(scene)!.add(w);
    }
  }
  const out: ScopedFailure[] = [];
  for (const [scene, ws] of byScene) {
    const list = [...ws].sort((a, b) => b - a);
    out.push({
      scene,
      message: `Off-canvas crop — element width(s) ${list.join(
        ", ",
      )}px cross the ${aspect} canvas edge in this scene, so they get cropped. Cap every primary element (cards, UI mocks, content blocks) inside the safe width and keep left+width within the frame; only decorative/atmosphere layers may bleed past.`,
    });
  }
  return out;
};

/**
 * Per-scene vertical under-fill. The file-level `assessVerticalFill` judges the
 * WHOLE composition, so a single height-filling scene MASKS every other scene's
 * empty lower band (the PayPal build: scene 0 filled the frame and hid the empty
 * bottoms of scenes 1/2/4 — the gate passed and nobody fixed them). Run the SAME
 * check scoped to each Section block so each scene is judged on its own. It's
 * false-negative-biased (assessVerticalFill skips a section with too few
 * positioned elements), so it never over-fires on a deliberately-minimal scene.
 */
export const fillFailuresByScene = (
  code: string,
  scenes: unknown[],
  aspect: AspectRatio,
): ScopedFailure[] => {
  const out: ScopedFailure[] = [];
  for (let i = 0; i < scenes.length; i++) {
    const range = sectionRange(code, i);
    if (!range) continue;
    const miss = assessVerticalFill(code.slice(range.start, range.end), aspect);
    if (miss) out.push({ scene: i, message: miss });
  }
  return out;
};

/**
 * Per-scene unbound (baked-as-literal) copy. Wraps findUnboundCopy (which
 * already carries a scene index) and bundles a scene's offending fields into one
 * instruction.
 */
export const unboundFailuresByScene = (
  code: string,
  scenes: unknown[],
): ScopedFailure[] => {
  // findUnboundCopy is typed against the project's Scene[]; the attribution is
  // index-based, so the structural shape is all we rely on.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const unbound = findUnboundCopy(code, scenes as any);
  const byScene = new Map<number, string[]>();
  for (const u of unbound) {
    if (!byScene.has(u.scene)) byScene.set(u.scene, []);
    // Quote the literal AS FOUND — the model must be able to locate the
    // defect. The old message quoted the SCRIPT's casing; for a case-variant
    // echo ("The Pilot" for THE PILOT) the model searched, found nothing,
    // saw the field bound, and correctly changed nothing — every retry
    // futile by construction (root-caused 2026-08-16).
    byScene
      .get(u.scene)!
      .push(
        `${u.field}: the script says "${u.excerpt}" and the code carries ${
          u.found ? `${u.site === "attribute" ? `it in an attribute (…="${u.found}")` : `the literal "${u.found}"`}` : "it split across elements"
        }`,
      );
  }
  const out: ScopedFailure[] = [];
  for (const [scene, fields] of byScene) {
    out.push({
      scene,
      message: `Script copy echoed as literal JSX — ${fields.join(
        "; ",
      )}. The scene's PRIMARY mount may already be bound — the flagged text is then a SECOND echo (a caption, badge, or chrome label repeating the same words). Fix each occurrence: bind it ({c.<field>}, styling via CSS on the wrapper — textTransform for casing, never retype), or if it is chrome (e.g. a category badge echoing the eyebrow) REPLACE it with a stable context label or omit it — the design contract forbids chrome echoing the scene's eyebrow.`,
    });
  }
  return out;
};

/**
 * Per-scene throughline ABSENCE (audit 2026-07-12). The presence gate
 * (assessThroughlinePresence) fires when the motif is tagged in fewer than
 * ceil(60%) of scenes — and, being "non-localizable", used to force a
 * WHOLE-composition re-emit (~260k tokens, ~12-15 min) to add a tag to one or
 * two scenes. It IS localizable: this maps exactly which scenes lack the
 * `data-throughline` tag and returns a scoped fix for just enough of them to
 * reach the bar (the CHEAPEST scenes to fix, first). Returns [] when the gate
 * wouldn't fire, or when there aren't enough LOCATABLE missing scenes to reach
 * the bar (→ caller keeps the whole-comp fallback, which is safe).
 */
export const throughlineAbsentByScene = (
  code: string,
  scenes: unknown[],
  ctx: { throughline: string; slug: string; anchor: { left: number; top: number } },
): ScopedFailure[] => {
  const n = scenes.length;
  if (!ctx.throughline || n < 3) return [];
  const bar = Math.max(2, Math.ceil(n * 0.6));

  const missing: number[] = [];
  let have = 0;
  for (let i = 0; i < n; i++) {
    const range = sectionRange(code, i);
    if (!range) continue; // unlocatable section → can't scope it; leave to fallback
    const block = code.slice(range.start, range.end);
    if (/\bdata-throughline\s*=/.test(block)) have++;
    else missing.push(i);
  }
  if (have >= bar) return []; // presence gate wouldn't fire
  const need = bar - have;
  if (missing.length < need) return []; // can't reach the bar by scoping → fallback

  return missing.slice(0, need).map((scene) => ({
    scene,
    message:
      `THROUGHLINE MISSING from this scene — the story's connective motif is: "${ctx.throughline}". ` +
      `Instantiate it as ONE concrete recurring visual element (a shape/object/motif you can draw), evolved to fit THIS beat (it transforms/progresses along the story — never a reset copy), ` +
      `and wrap it in \`<div data-throughline="${ctx.slug}">\` (this EXACT slug) anchored near (left ${ctx.anchor.left}px, top ${ctx.anchor.top}px) so it reads continuous with the other scenes. Keep all the scene's existing content.`,
  }));
};

/**
 * Combine several ScopedFailure lists into one ordered instruction bundle per
 * scene. The pipeline feeds these straight into the per-scene regen prompt.
 */
export const groupByScene = (
  ...lists: ScopedFailure[][]
): { scene: number; messages: string[] }[] => {
  const byScene = new Map<number, string[]>();
  for (const list of lists) {
    for (const f of list) {
      if (!byScene.has(f.scene)) byScene.set(f.scene, []);
      byScene.get(f.scene)!.push(f.message);
    }
  }
  return [...byScene.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([scene, messages]) => ({ scene, messages }));
};

/**
 * Guard: scoped splicing is only safe when the file's sections are exactly the
 * contiguous run 0..sceneCount-1. A mismatch (a missing/renamed section, an
 * extra one) means our positional splice could graft into the wrong place — so
 * the caller must fall back to a whole-composition retry instead.
 */
export const sectionsAreSpliceable = (
  code: string,
  sceneCount: number,
): boolean => {
  const indices = listSectionIndices(code);
  if (indices.length !== sceneCount) return false;
  return indices.every((idx, i) => idx === i);
};
