/**
 * ALLOCATOR DRY-RUN (2026-07-19) — offline replay of the deterministic layout
 * allocator over every stored composition, producing a visual side-by-side
 * comparison against the composition head's authored bounds.
 *
 * ZERO API CALLS. Pure file replay over `.data/dogfood/<build>/composition.json`
 * plus, where present, `script.generated.json` (register + copy) and
 * `_measure/rects-scene-N.json` (real painted sizes). Nothing here builds,
 * crawls, or calls a model.
 *
 *   node scripts/allocator-dryrun.mjs
 *
 * Writes `.data/dogfood/ALLOCATOR_DRYRUN.html` (static, NO JavaScript — a
 * JS-built page failed to render in this environment) and prints the corpus
 * metrics table to stdout.
 */
import * as esbuild from "esbuild";
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";

// ── Bundle the two TS leaves so this stays a plain-JS script ────────────────
const work = join(process.cwd(), "node_modules", ".cache", "rb-allocator");
mkdirSync(work, { recursive: true });
const bundle = await esbuild.build({
  entryPoints: [join(process.cwd(), "lib/agents/allocate-layout.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  packages: "external",
  write: false,
  logLevel: "silent",
});
const allocFile = join(work, "allocate-layout.mjs");
writeFileSync(allocFile, bundle.outputFiles[0].text);
const { allocateLayout } = await import(pathToFileURL(allocFile).href);

const mBundle = await esbuild.build({
  entryPoints: [join(process.cwd(), "lib/agents/layout-metrics.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  packages: "external",
  write: false,
  logLevel: "silent",
});
const metricsFile = join(work, "layout-metrics.mjs");
writeFileSync(metricsFile, mBundle.outputFiles[0].text);
const { scoreLayout, SAFE } = await import(pathToFileURL(metricsFile).href);

const ceBundle = await esbuild.build({
  entryPoints: [join(process.cwd(), "lib/agents/content-extent.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  packages: "external",
  write: false,
  logLevel: "silent",
});
const ceFile = join(work, "content-extent.mjs");
writeFileSync(ceFile, ceBundle.outputFiles[0].text);
const { copyExtent, measuredExtent, authoredExtent, NOMINAL_SCALE } = await import(pathToFileURL(ceFile).href);

const tsBundle = await esbuild.build({
  entryPoints: [join(process.cwd(), "lib/render/type-scale.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  packages: "external",
  write: false,
  logLevel: "silent",
});
const tsFile = join(work, "type-scale.mjs");
writeFileSync(tsFile, tsBundle.outputFiles[0].text);
const { deriveTypeScale } = await import(pathToFileURL(tsFile).href);

const piBundle = await esbuild.build({
  entryPoints: [join(process.cwd(), "lib/agents/predict-ink.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  packages: "external",
  write: false,
  logLevel: "silent",
});
const piFile = join(work, "predict-ink.mjs");
writeFileSync(piFile, piBundle.outputFiles[0].text);
const { predictInkRect, typicalSansMetrics } = await import(pathToFileURL(piFile).href);

const fmBundle = await esbuild.build({
  entryPoints: [join(process.cwd(), "lib/render/font-metrics.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  packages: "external",
  write: false,
  logLevel: "silent",
});
const fmFile = join(work, "font-metrics.mjs");
writeFileSync(fmFile, fmBundle.outputFiles[0].text);
const { metricsKey, isCalibrated } = await import(pathToFileURL(fmFile).href);

// ── Corpus discovery ────────────────────────────────────────────────────────
const ROOT = join(process.cwd(), ".data", "dogfood");
const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};

const builds = readdirSync(ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

/**
 * INK METRICS SOURCE, per build. The predictor needs an advance table; the
 * honest one is the build's OWN calibrated brand face (the flags/rappi-era
 * builds persisted genuinely-calibrated v2 tables to .data/font-metrics —
 * notioninter, pp-object-sans, nunito). First declared family with a
 * calibrated cache wins; builds whose faces never calibrated fall back to
 * `typicalSansMetrics()` (0.52em/char — the PREDICTION posture, not the 0.62em
 * budget posture). The choice is recorded per build and reported.
 */
const metricsDir = join(process.cwd(), ".data", "font-metrics");
const metricsCache = new Map();
const loadCalibrated = (family) => {
  const k = metricsKey(family, 400);
  if (metricsCache.has(k)) return metricsCache.get(k);
  const m = readJson(join(metricsDir, `${k}.json`));
  const ok = m && isCalibrated(m) ? m : null;
  metricsCache.set(k, ok);
  return ok;
};
const metricsForBuild = (script) => {
  for (const f of script?.assets?.fonts ?? []) {
    if (!f?.family) continue;
    const m = loadCalibrated(f.family);
    if (m) return { metrics: m, source: `calibrated:${f.family}` };
  }
  return { metrics: typicalSansMetrics(), source: "typical-sans(0.52em)" };
};

/** The copy fields an element can own, mirroring layout-composer.COPY_FIELDS. */
const COPY_FIELDS = ["eyebrow", "headline", "lede", "bullets", "caption", "meta", "cta", "texts"];

const charsOf = (v) => {
  if (v == null) return 0;
  if (typeof v === "string") return v.length;
  if (Array.isArray(v)) return v.reduce((s, x) => s + charsOf(x), 0);
  if (typeof v === "object") return Object.values(v).reduce((s, x) => s + charsOf(x), 0);
  return String(v).length;
};
const itemsOf = (v) => (Array.isArray(v) ? v.length : 0);

/** Flatten a scene.content field to the string that actually renders. */
const flatten = (v) => {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(flatten).filter(Boolean).join("  ");
  if (typeof v === "object") return Object.values(v).map(flatten).filter(Boolean).join(" ");
  return String(v);
};

/** Read the measured painted sizes for a scene, keyed by role. */
const measuredFor = (dir, sceneIx) => {
  const p = join(ROOT, dir, "_measure", `rects-scene-${sceneIx}.json`);
  if (!existsSync(p)) return null;
  const d = readJson(p);
  if (!d || !Array.isArray(d.pieces)) return null;
  const out = {};
  for (const piece of d.pieces) {
    const role = String(piece.id || "").split(".").slice(1).join(".");
    const box = piece.painted || piece.wrapper;
    if (role && box && box.w > 0 && box.h > 0) out[role] = { w: box.w, h: box.h };
  }
  return Object.keys(out).length > 0 ? out : null;
};

/** Disambiguate duplicate roles ("copy", "copy#2", …) exactly once, so head and
 *  allocator sides refer to the same element by the same id. */
const withIds = (elements) => {
  const seen = new Map();
  return elements.map((e) => {
    const role = String(e.role || "unknown");
    const n = (seen.get(role) ?? 0) + 1;
    seen.set(role, n);
    return { ...e, _id: n === 1 ? role : `${role}#${n}` };
  });
};

const scenes = [];
const skipped = [];

for (const dir of builds) {
  const compPath = join(ROOT, dir, "composition.json");
  if (!existsSync(compPath)) continue;
  const comp = readJson(compPath);
  if (!comp || !Array.isArray(comp)) {
    skipped.push({ build: dir, scene: "—", why: "composition.json missing or malformed (not a JSON array)" });
    continue;
  }
  const script = readJson(join(ROOT, dir, "script.generated.json"));
  const aspect = script?.config?.aspect_ratio || "16:9";
  const buildInk = metricsForBuild(script);

  for (const entry of comp) {
    const ix = typeof entry.scene === "number" ? entry.scene : comp.indexOf(entry);
    const els = entry?.composition?.elements;
    const scriptScene = script?.scenes?.[ix] ?? null;
    const register = scriptScene?.register ?? null;
    const content = scriptScene?.content ?? null;
    const frame = existsSync(join(ROOT, dir, "frames", `scene${ix}.png`)) ? `${dir}/frames/scene${ix}.png` : null;

    if (!Array.isArray(els) || els.length === 0) {
      skipped.push({ build: dir, scene: ix, why: "scene carries no composition.elements — nothing to place" });
      scenes.push({ build: dir, ix, aspect, register, frame, skipped: "no composition.elements", head: null, alloc: null });
      continue;
    }
    if (!["16:9", "9:16", "1:1"].includes(aspect)) {
      skipped.push({ build: dir, scene: ix, why: `unsupported aspect "${aspect}"` });
      scenes.push({ build: dir, ix, aspect, register, frame, skipped: `unsupported aspect "${aspect}"`, head: null, alloc: null });
      continue;
    }

    const ided = withIds(els);
    const measured = measuredFor(dir, ix);

    // ── HEAD side: the authored bounds, scored verbatim ────────────────────
    const headScored = ided
      .filter((e) => e.role !== "atmosphere")
      .map((e) => ({
        id: e._id,
        role: e.role,
        focalRank: typeof e.focalRank === "number" ? e.focalRank : null,
        bounds: e.bounds && e.bounds.w > 0 && e.bounds.h > 0 ? { x: e.bounds.x, y: e.bounds.y, w: e.bounds.w, h: e.bounds.h } : null,
        allowedOverlaps: [],
      }));
    const headPlaced = headScored.filter((e) => e.bounds);
    const headScore = headPlaced.length > 0 ? scoreLayout(headPlaced, aspect) : null;

    // ── ALLOCATOR side ────────────────────────────────────────────────────
    //
    // THE TWO INPUTS ROUND 1 LACKED, both extracted from what is already on
    // disk.
    //
    // (1) HERO TREATMENT — bleed vs placed. Round 1 inferred it from the
    //     register and destroyed the razorpay control. The head's OWN authored
    //     hero area states it exactly (≥85% of the frame is the same threshold
    //     every other module uses for a canvas treatment). Keyword-matching the
    //     visual_concept was tried and measured first: it agrees with the
    //     authored geometry on only 14 of 31 candidate scenes, because the
    //     literal phrase "Full-bleed" appears in the register label echoed into
    //     the concept text and "whole canvas" shows up in atmosphere prose. The
    //     authored area is the honest signal. Absent → null → PLACED.
    //
    // (2) CONTENT EXTENT — a measured painted rect where one exists, otherwise
    //     a capacity-derived extent from the REAL copy strings, otherwise the
    //     head's authored box as a scale anchor for a hero (see
    //     content-extent.ts for why a hero's need is not derivable at all).
    const heroAuthored = ided.find((e) => e.role === "hero" && e.bounds)?.bounds ?? null;
    const heroTreatment = heroAuthored
      ? heroAuthored.w * heroAuthored.h >= 0.85 * 1920 * 1080
        ? "bleed"
        : "placed"
      : null;

    /**
     * Which element (if any) the head deliberately EMBEDDED this one inside.
     *
     * Narrow on purpose. A first pass tested bare containment and it was wrong:
     * a full-bleed hero contains the copy and the motif and everything else, so
     * every bleed scene collapsed to a single body and the copy became a child
     * of the canvas. Copy over a canvas treatment is DECLARED LAYERING, not
     * embedding. The relation the 2026-07-18 throughline work actually
     * identified is a small MOTIF sitting inside a larger visual — "the
     * spinning Pending status ring embedded in the card mid-section" — so that
     * is what this matches: motif-ish roles only, and small relative to their
     * parent (checkr's ring is 0.2% of its hero, razorpay's button 12%,
     * notion's chip 0.5%).
     */
    const EMBEDDABLE_ROLES = new Set(["throughline", "connector"]);
    const MAX_CHILD_AREA_FRAC = 0.5;
    const parentOf = (e) => {
      if (!e.bounds || !EMBEDDABLE_ROLES.has(e.role)) return null;
      let best = null;
      for (const other of ided) {
        if (other === e || !other.bounds || other.role === "atmosphere") continue;
        const o = other.bounds;
        const b = e.bounds;
        const contained = b.x >= o.x && b.y >= o.y && b.x + b.w <= o.x + o.w && b.y + b.h <= o.y + o.h;
        if (!contained) continue;
        if (b.w * b.h > MAX_CHILD_AREA_FRAC * o.w * o.h) continue;
        // Smallest containing element wins — the tightest real parent.
        if (!best || o.w * o.h < best.bounds.w * best.bounds.h) best = other;
      }
      return best;
    };

    const sizeSources = [];
    const allocInput = {
      aspect,
      register: register ?? undefined,
      heroTreatment,
      elements: ided.map((e) => {
        const owns = Array.isArray(e.ownsCopy) ? e.ownsCopy : [];

        /** Measured > derived > authored > prior, and the choice is recorded.
         *  Atmosphere and chrome are not content-sized (full-bleed base layer,
         *  fixed bar) and are excluded from the accounting. */
        const extentFor = (el, ownedFields) => {
          if (el.role === "atmosphere" || el.role === "chrome") return null;
          const m = measured?.[el._id];
          if (m && el.role === "copy") {
            sizeSources.push("measured");
            return measuredExtent(m);
          }
          if (el.role === "copy" && content) {
            const fields = ownedFields
              .filter((f) => COPY_FIELDS.includes(f))
              .map((f) => ({ name: f, text: flatten(content[f]) }))
              .filter((f) => f.text.trim().length > 0);
            if (fields.length > 0) {
              sizeSources.push("derived");
              // Ground the extent in the scale the emitter would really use.
              // deriveTypeScale walks DOWN the ramp until the box can carry it,
              // so a fixed nominal scale over-estimates small boxes badly
              // (razorpay s2's 320×200 corner measured 4.83× its own area at
              // the nominal step, and 1.0× at its derived step).
              const scale = el.bounds
                ? deriveTypeScale({ role: "copy", box: { w: el.bounds.w, h: el.bounds.h }, canvas: { w: 1920, h: 1080 } })
                : NOMINAL_SCALE;
              return copyExtent(fields, { w: 1920, h: 1080 }, { headlinePx: scale.headlinePx, bodyPx: scale.bodyPx });
            }
          }
          if (el.bounds && el.bounds.w > 0 && el.bounds.h > 0) {
            sizeSources.push("authored");
            return authoredExtent(el.bounds);
          }
          sizeSources.push("prior");
          return null;
        };

        // EMBEDDED CHILD: the head placed this fully inside a larger element.
        const parent = parentOf(e);
        const embed = parent
          ? {
              parentId: parent._id,
              rect: {
                fx: (e.bounds.x - parent.bounds.x) / parent.bounds.w,
                fy: (e.bounds.y - parent.bounds.y) / parent.bounds.h,
                fw: e.bounds.w / parent.bounds.w,
                fh: e.bounds.h / parent.bounds.h,
              },
            }
          : null;

        let textChars = 0;
        let itemCount = 0;
        if (content) {
          for (const f of owns) {
            if (!COPY_FIELDS.includes(f)) continue;
            textChars += charsOf(content[f]);
            itemCount += itemsOf(content[f]);
          }
        }
        return {
          id: e._id,
          role: String(e.role || "unknown"),
          focalRank: typeof e.focalRank === "number" ? e.focalRank : null,
          textChars: textChars || undefined,
          itemCount: itemCount || undefined,
          interiorCount: Array.isArray(e.interior) ? e.interior.length : undefined,
          measured: measured?.[e._id] ?? null,
          authoredSize: e.bounds && e.bounds.w > 0 && e.bounds.h > 0 ? { w: e.bounds.w, h: e.bounds.h } : null,
          contentExtent: extentFor(e, owns),
          embeddedIn: embed?.parentId ?? null,
          embeddedRect: embed?.rect ?? null,
        };
      }),
    };

    /** Score one arm's slots through the SAME scorer the head goes through. */
    const scoreArm = (a) =>
      scoreLayout(
        a.slots
          .filter((s) => s.layer !== "chrome" && s.role !== "atmosphere")
          .map((s) => ({
            id: s.id,
            role: s.role,
            focalRank: allocInput.elements.find((e) => e.id === s.id)?.focalRank ?? null,
            bounds: s.bounds,
            allowedOverlaps: s.allowedOverlaps,
          })),
        aspect,
      );

    /**
     * READING-ORDER COST. choreograph.ts derives entrance stagger from
     * top-to-bottom reading order, so permuting positions desynchronises the
     * animation from how the frame reads. Compare the head's copy sequence
     * (sorted top-to-bottom, then left-to-right) with the arm's; a mismatch is
     * a COST that has to be counted, not a free move.
     */
    const readingSeq = (boxesById) =>
      Object.entries(boxesById)
        .filter(([id]) => id.startsWith("copy"))
        .sort((a, b) => a[1].y - b[1].y || a[1].x - b[1].x)
        .map(([id]) => id)
        .join(">");
    const headSeqMap = {};
    for (const e of headPlaced) headSeqMap[e.id] = e.bounds;
    const headSeq = readingSeq(headSeqMap);
    const armSeq = (a) => {
      const m = {};
      for (const s of a.slots) if (s.layer === "content") m[s.id] = s.bounds;
      return readingSeq(m);
    };

    let alloc = null;
    let allocRepo = null;
    let allocError = null;
    try {
      alloc = allocateLayout(allocInput);
      alloc.score = scoreArm(alloc);
      alloc.readingOrderKept = headSeq.length === 0 || armSeq(alloc) === headSeq;
    } catch (err) {
      allocError = err instanceof Error ? err.message : String(err);
      skipped.push({ build: dir, scene: ix, why: `allocator (resize) threw: ${allocError}` });
    }
    try {
      if (headPlaced.length > 0) {
        allocRepo = allocateLayout({ ...allocInput, mode: "reposition" });
        allocRepo.score = scoreArm(allocRepo);
        allocRepo.readingOrderKept = headSeq.length === 0 || armSeq(allocRepo) === headSeq;
      }
    } catch (err) {
      skipped.push({ build: dir, scene: ix, why: `allocator (reposition) threw: ${err instanceof Error ? err.message : String(err)}` });
    }

    // ── INK RE-SCORE ─────────────────────────────────────────────────────
    //
    // Everything above scores DECLARED boxes. The measured truth (10 scenes):
    // a diegetic piece paints its box pixel-exact (21/21), a text piece NEVER
    // does (0/10 — the box runs 1.04–2.09× its ink). So the ink view keeps
    // every non-text box verbatim and replaces each copy box with its
    // PREDICTED ink: the element's own verbatim strings wrapped through the
    // calibrated stack at the type scale the pipeline declares for that box,
    // anchored top-left (block flow), full measure. Same scorer, same
    // held-out rules — only the rectangles change.
    const inkFieldsById = new Map();
    let inkUnpredictable = null;
    for (const e of ided) {
      if (e.role !== "copy") continue;
      const owns = (Array.isArray(e.ownsCopy) ? e.ownsCopy : []).filter((f) => COPY_FIELDS.includes(f));
      const fields = content
        ? owns.map((name) => ({ name, value: content[name] })).filter((f) => f.value !== null && f.value !== undefined)
        : [];
      if (fields.length > 0) inkFieldsById.set(e._id, fields);
      else if (!inkUnpredictable) inkUnpredictable = content ? `copy "${e._id}" owns no copy fields` : "no script.generated.json (no strings on disk)";
    }
    // `hScale` exists for the SENSITIVITY check: the predictor's measured mean
    // |height error| is ~10–14%, so the gate is re-evaluated with every
    // prediction uniformly biased ±15% (both sides share one predictor, so a
    // systematic model error moves both sides together — that is the realistic
    // failure mode, and the one the verdict must be robust to).
    const inkView = (entries, hScale = 1) =>
      entries.map((e) => {
        const fields = inkFieldsById.get(e.id);
        if (e.role !== "copy" || !fields) return e;
        const { rect, prediction } = predictInkRect(e.bounds, fields, { w: 1920, h: 1080 }, buildInk.metrics);
        if (hScale === 1 || prediction.blocks === 0) return { ...e, bounds: rect };
        return { ...e, bounds: { ...rect, h: Math.max(1, Math.round(rect.h * hScale)) } };
      });
    const inkScoreOf = (entries, hScale = 1) => (entries.length > 0 ? scoreLayout(inkView(entries, hScale), aspect) : null);
    const armEntries = (a) =>
      a.slots
        .filter((s) => s.layer !== "chrome" && s.role !== "atmosphere")
        .map((s) => ({
          id: s.id,
          role: s.role,
          focalRank: allocInput.elements.find((e) => e.id === s.id)?.focalRank ?? null,
          bounds: s.bounds,
          allowedOverlaps: s.allowedOverlaps,
        }));
    let headInkScore = null;
    let allocInkScore = null;
    let repoInkScore = null;
    let inkSensitivity = null;
    try {
      headInkScore = headPlaced.length > 0 ? inkScoreOf(headPlaced) : null;
      allocInkScore = alloc ? inkScoreOf(armEntries(alloc)) : null;
      repoInkScore = allocRepo ? inkScoreOf(armEntries(allocRepo)) : null;
      if (headInkScore && allocInkScore) {
        inkSensitivity = {
          headLo: inkScoreOf(headPlaced, 0.85),
          headHi: inkScoreOf(headPlaced, 1.15),
          allocLo: inkScoreOf(armEntries(alloc), 0.85),
          allocHi: inkScoreOf(armEntries(alloc), 1.15),
        };
      }
    } catch (err) {
      inkUnpredictable = `ink scoring threw: ${err instanceof Error ? err.message : String(err)}`;
    }

    scenes.push({
      build: dir,
      ix,
      aspect,
      register,
      frame,
      skipped: null,
      usedMeasured: !!measured,
      sizeSources,
      heroTreatment,
      embeddedCount: allocInput.elements.filter((e) => e.embeddedIn).length,
      unplacedByHead: headScored.filter((e) => !e.bounds).map((e) => e.id),
      head: { elements: headScored, score: headScore },
      alloc: alloc ? { shape: alloc.shape, slots: alloc.slots, score: alloc.score, repicked: alloc.repicked, readingOrderKept: alloc.readingOrderKept } : null,
      repo: allocRepo ? { shape: allocRepo.shape, slots: allocRepo.slots, score: allocRepo.score, readingOrderKept: allocRepo.readingOrderKept } : null,
      allocError,
      inkMetricsSource: buildInk.source,
      inkUnpredictable,
      headInk: headInkScore,
      allocInk: allocInkScore,
      repoInk: repoInkScore,
      inkSensitivity,
      copyFields: Object.fromEntries(inkFieldsById),
      _inkMetrics: buildInk.metrics,
    });
  }
}

// ── Priority ordering ───────────────────────────────────────────────────────
const FAILURES = [
  ["flags-notion", 0],
  ["flags-notion", 3],
  ["flags-notion", 4],
  ["flags-on-rappi", 1],
  ["flags-on-rappi", 3],
];
const CONTROLS = [
  ["flags-notion", 2],
  ["p3-cycle8-razorpay", 2],
  ["final-checkr", 2],
];
const key = (s) => `${s.build}#${s.ix}`;
const pick = (list) => list.map(([b, i]) => scenes.find((s) => s.build === b && s.ix === i)).filter(Boolean);
const failureScenes = pick(FAILURES);
const controlScenes = pick(CONTROLS);
const prioritySet = new Set([...failureScenes, ...controlScenes].map(key));

// ── Corpus aggregates ───────────────────────────────────────────────────────
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const median = (xs) => {
  if (!xs.length) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const paired = scenes.filter((s) => s.head?.score && s.alloc?.score);
/**
 * CANVAS-TREATMENT SCENES ARE NOT COMPARABLE ON VOID OR CENTROID and are held
 * out of the headline aggregate. The scorer drops any rect ≥85% of the frame
 * (counting it would drive every void to zero and measure nothing), which means
 * a full-bleed frame is scored on its small overlaid insets alone. `final-checkr
 * s2` — a REFERENCE-GRADE frame — scores 55.6% void purely because its
 * 1840×1000 dashboard is excluded. Aggregating that would be measuring the
 * instrument, not the layout.
 */
for (const s of paired) {
  s.treatment = (s.head.score.canvasTreatments ?? 0) > 0 || (s.alloc.score.canvasTreatments ?? 0) > 0;
}
const placeable = paired.filter((s) => !s.treatment);
const treatmentScenes = paired.filter((s) => s.treatment);
const agg = (side, f) => placeable.map((s) => s[side]?.score && f(s[side].score)).filter((v) => typeof v === "number" && Number.isFinite(v));
/** Scenes where BOTH allocator arms ran, so the resize-vs-reposition split is
 *  like-for-like. Reposition needs an authored size, so it only exists where
 *  the head placed something. */
const threeWay = placeable.filter((s) => s.repo?.score);

const summary = {
  builds: new Set(scenes.map((s) => s.build)).size,
  scenes: scenes.length,
  paired: paired.length,
  placeable: placeable.length,
  treatments: treatmentScenes.length,
  headOnly: scenes.filter((s) => s.head?.score && !s.alloc?.score).length,
  allocOnly: scenes.filter((s) => !s.head?.score && s.alloc?.score).length,
  neither: scenes.filter((s) => !s.head?.score && !s.alloc?.score).length,
  measured: scenes.filter((s) => s.usedMeasured).length,
  sizeSources: (() => {
    const c = { measured: 0, derived: 0, authored: 0, prior: 0 };
    for (const sc of scenes) for (const k of sc.sizeSources ?? []) c[k] = (c[k] ?? 0) + 1;
    return c;
  })(),
  heroTreatments: (() => {
    const c = { bleed: 0, placed: 0, unknown: 0 };
    for (const sc of scenes) c[sc.heroTreatment ?? "unknown"]++;
    return c;
  })(),
  embedded: scenes.reduce((a, sc) => a + (sc.embeddedCount ?? 0), 0),
  embeddedScenes: scenes.filter((sc) => (sc.embeddedCount ?? 0) > 0).length,
  void: {
    headMean: mean(agg("head", (x) => x.largestVoid)),
    allocMean: mean(agg("alloc", (x) => x.largestVoid)),
    repoMean: mean(agg("repo", (x) => x.largestVoid)),
    headMedian: median(agg("head", (x) => x.largestVoid)),
    allocMedian: median(agg("alloc", (x) => x.largestVoid)),
    repoMedian: median(agg("repo", (x) => x.largestVoid)),
    headWorst: Math.max(...agg("head", (x) => x.largestVoid)),
    allocWorst: Math.max(...agg("alloc", (x) => x.largestVoid)),
    repoWorst: Math.max(...agg("repo", (x) => x.largestVoid)),
    headOver25: agg("head", (x) => x.largestVoid).filter((v) => v > 0.25).length,
    allocOver25: agg("alloc", (x) => x.largestVoid).filter((v) => v > 0.25).length,
    repoOver25: agg("repo", (x) => x.largestVoid).filter((v) => v > 0.25).length,
  },
  focal: {
    headOk: placeable.filter((s) => s.head.score.focalIsLargest === true).length,
    allocOk: placeable.filter((s) => s.alloc.score.focalIsLargest === true).length,
    repoOk: placeable.filter((s) => s.repo?.score?.focalIsLargest === true).length,
    headNone: placeable.filter((s) => s.head.score.focalIsLargest === null).length,
    allocNone: placeable.filter((s) => s.alloc.score.focalIsLargest === null).length,
    headMargin: median(agg("head", (x) => x.focalMargin)),
    allocMargin: median(agg("alloc", (x) => x.focalMargin)),
    repoMargin: median(agg("repo", (x) => x.focalMargin)),
  },
  centroid: {
    headMean: mean(agg("head", (x) => x.centroidOffset)),
    allocMean: mean(agg("alloc", (x) => x.centroidOffset)),
    repoMean: mean(agg("repo", (x) => x.centroidOffset)),
    headWorst: Math.max(...agg("head", (x) => x.centroidOffset)),
    allocWorst: Math.max(...agg("alloc", (x) => x.centroidOffset)),
    repoWorst: Math.max(...agg("repo", (x) => x.centroidOffset)),
  },
  // Overlaps are scored over ALL paired scenes (a canvas treatment does not
  // distort an overlap count the way it distorts a void).
  overlaps: {
    head: paired.reduce((a, s) => a + s.head.score.overlaps, 0),
    alloc: paired.reduce((a, s) => a + s.alloc.score.overlaps, 0),
    headEx: paired.reduce((a, s) => a + s.head.score.overlapsExEmbedded, 0),
    allocEx: paired.reduce((a, s) => a + s.alloc.score.overlapsExEmbedded, 0),
    headScenes: paired.filter((s) => s.head.score.overlaps > 0).length,
    allocScenes: paired.filter((s) => s.alloc.score.overlaps > 0).length,
    headScenesEx: paired.filter((s) => s.head.score.overlapsExEmbedded > 0).length,
    repo: paired.reduce((a, s) => a + (s.repo?.score?.overlaps ?? 0), 0),
    repoScenes: paired.filter((s) => (s.repo?.score?.overlaps ?? 0) > 0).length,
  },
  readingOrder: {
    allocKept: paired.filter((s) => s.alloc?.readingOrderKept).length,
    repoKept: paired.filter((s) => s.repo?.readingOrderKept).length,
    total: paired.length,
  },
  repicked: scenes.filter((s) => s.alloc?.repicked).length,
  threeWay: threeWay.length,
  coverage: {
    headMean: mean(agg("head", (x) => x.coverage)),
    allocMean: mean(agg("alloc", (x) => x.coverage)),
    repoMean: mean(agg("repo", (x) => x.coverage)),
  },
};

// ── INK aggregates + THE GATE ───────────────────────────────────────────────
//
// Scored over the placeable scenes whose every copy element has verbatim
// strings on disk (script.generated.json). A scene with a string-less copy is
// excluded from BOTH sides' ink aggregate — like-for-like or not at all.
const inkScored = placeable.filter((s) => !s.inkUnpredictable && s.headInk && s.allocInk);
const inkExcluded = placeable.filter((s) => s.inkUnpredictable || !s.headInk || !s.allocInk);
const aggInk = (key, f) => inkScored.map((s) => s[key] && f(s[key])).filter((v) => typeof v === "number" && Number.isFinite(v));
const inkSummary = {
  scored: inkScored.length,
  excluded: inkExcluded.length,
  excludedWhy: inkExcluded.map((s) => `${s.build} s${s.ix}: ${s.inkUnpredictable ?? "no ink score"}`),
  void: {
    headMean: mean(aggInk("headInk", (x) => x.largestVoid)),
    allocMean: mean(aggInk("allocInk", (x) => x.largestVoid)),
    repoMean: mean(aggInk("repoInk", (x) => x.largestVoid)),
    headMedian: median(aggInk("headInk", (x) => x.largestVoid)),
    allocMedian: median(aggInk("allocInk", (x) => x.largestVoid)),
    repoMedian: median(aggInk("repoInk", (x) => x.largestVoid)),
    headWorst: Math.max(...aggInk("headInk", (x) => x.largestVoid)),
    allocWorst: Math.max(...aggInk("allocInk", (x) => x.largestVoid)),
    repoWorst: Math.max(...aggInk("repoInk", (x) => x.largestVoid)),
    headOver25: aggInk("headInk", (x) => x.largestVoid).filter((v) => v > 0.25).length,
    allocOver25: aggInk("allocInk", (x) => x.largestVoid).filter((v) => v > 0.25).length,
    repoOver25: aggInk("repoInk", (x) => x.largestVoid).filter((v) => v > 0.25).length,
  },
  focal: {
    headOk: inkScored.filter((s) => s.headInk.focalIsLargest === true).length,
    allocOk: inkScored.filter((s) => s.allocInk.focalIsLargest === true).length,
    repoOk: inkScored.filter((s) => s.repoInk?.focalIsLargest === true).length,
    headMargin: median(aggInk("headInk", (x) => x.focalMargin)),
    allocMargin: median(aggInk("allocInk", (x) => x.focalMargin)),
  },
  centroid: {
    headMean: mean(aggInk("headInk", (x) => x.centroidOffset)),
    allocMean: mean(aggInk("allocInk", (x) => x.centroidOffset)),
    repoMean: mean(aggInk("repoInk", (x) => x.centroidOffset)),
    headWorst: Math.max(...aggInk("headInk", (x) => x.centroidOffset)),
    allocWorst: Math.max(...aggInk("allocInk", (x) => x.centroidOffset)),
  },
  metricsSources: (() => {
    const c = {};
    for (const s of inkScored) c[s.inkMetricsSource] = (c[s.inkMetricsSource] ?? 0) + 1;
    return c;
  })(),
};

/**
 * THE GATE — pre-registered before the numbers were read, so the verdict is
 * computed, not narrated. The allocator's box-space advantage was: mean void
 * −3.0pp, >25%-void count 14→1, focal dominance +22 scenes. "Materially
 * better on INK" is defined as ALL of:
 *   (a) ink >25%-void count: allocator ≤ half the head's (rounded up);
 *   (b) ink mean largest-void: allocator at least 2.0pp below the head;
 *   (c) ink focal dominance: allocator ≥ the head.
 * Anything less means the box-space win was substantially an artefact of
 * scoring reserved rectangles, and Stage B does not proceed.
 */
const gate = {
  a: { pass: inkSummary.void.allocOver25 <= Math.ceil(inkSummary.void.headOver25 / 2), detail: `>25% ink-void: alloc ${inkSummary.void.allocOver25} vs head ${inkSummary.void.headOver25} (need ≤ ${Math.ceil(inkSummary.void.headOver25 / 2)})` },
  b: { pass: inkSummary.void.headMean - inkSummary.void.allocMean >= 0.02, detail: `mean ink-void: head ${(inkSummary.void.headMean * 100).toFixed(1)}% − alloc ${(inkSummary.void.allocMean * 100).toFixed(1)}% = ${((inkSummary.void.headMean - inkSummary.void.allocMean) * 100).toFixed(1)}pp (need ≥ 2.0pp)` },
  c: { pass: inkSummary.focal.allocOk >= inkSummary.focal.headOk, detail: `ink focal-1 largest: alloc ${inkSummary.focal.allocOk}/${inkSummary.scored} vs head ${inkSummary.focal.headOk}/${inkSummary.scored}` },
};
gate.pass = gate.a.pass && gate.b.pass && gate.c.pass;

// SENSITIVITY: the same three criteria with every prediction uniformly biased
// −15% and +15% (see inkView's hScale). The verdict is only trustworthy if it
// is the same at both extremes.
const gateAt = (headKey, allocKey) => {
  const withSens = inkScored.filter((s) => s.inkSensitivity?.[headKey] && s.inkSensitivity?.[allocKey]);
  const hv = withSens.map((s) => s.inkSensitivity[headKey].largestVoid);
  const av = withSens.map((s) => s.inkSensitivity[allocKey].largestVoid);
  const hOver = hv.filter((v) => v > 0.25).length;
  const aOver = av.filter((v) => v > 0.25).length;
  const hMean = mean(hv);
  const aMean = mean(av);
  const hFocal = withSens.filter((s) => s.inkSensitivity[headKey].focalIsLargest === true).length;
  const aFocal = withSens.filter((s) => s.inkSensitivity[allocKey].focalIsLargest === true).length;
  return {
    n: withSens.length,
    pass: aOver <= Math.ceil(hOver / 2) && hMean - aMean >= 0.02 && aFocal >= hFocal,
    detail: `>25%: ${aOver} vs ${hOver} · mean: ${(hMean * 100).toFixed(1)}% vs ${(aMean * 100).toFixed(1)}% · focal: ${aFocal} vs ${hFocal}`,
  };
};
gate.sensitivity = { lo: gateAt("headLo", "allocLo"), hi: gateAt("headHi", "allocHi") };
gate.robust = gate.sensitivity.lo.pass === gate.pass && gate.sensitivity.hi.pass === gate.pass;

const shapeCounts = {};
for (const s of scenes) if (s.alloc) shapeCounts[s.alloc.shape] = (shapeCounts[s.alloc.shape] ?? 0) + 1;
const shapesByRegister = {};
for (const s of scenes) {
  if (!s.alloc) continue;
  const r = s.register ?? "(none)";
  (shapesByRegister[r] ??= new Set()).add(s.alloc.shape);
}

// ── Console report ──────────────────────────────────────────────────────────
const pct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : "—");
const num = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "—");
console.log(`\ncorpus: ${summary.builds} builds / ${summary.scenes} scenes · ${summary.paired} scored on BOTH sides`);
console.log(`        ${summary.allocOnly} allocator-only (head authored no bounds) · ${summary.measured} with REAL measured rects`);
console.log(`        void/focal/centroid aggregated over ${summary.placeable} PLACEABLE scenes;`);
console.log(`        ${summary.treatments} held out (a ≥85% canvas treatment makes those numbers an artefact)`);
console.log(`\n| metric                     | HEAD      | REPOSITION | REPOS+RESIZE |`);
console.log(`|----------------------------|-----------|------------|--------------|`);
const row = (label, a, b, c) => console.log(`| ${label.padEnd(26)} | ${String(a).padEnd(9)} | ${String(b).padEnd(10)} | ${String(c).padEnd(12)} |`);
row("largest void — mean", pct(summary.void.headMean), pct(summary.void.repoMean), pct(summary.void.allocMean));
row("largest void — median", pct(summary.void.headMedian), pct(summary.void.repoMedian), pct(summary.void.allocMedian));
row("largest void — worst", pct(summary.void.headWorst), pct(summary.void.repoWorst), pct(summary.void.allocWorst));
row("scenes with void > 25%", summary.void.headOver25, summary.void.repoOver25, summary.void.allocOver25);
row("focal-1 is largest", `${summary.focal.headOk}/${summary.placeable}`, `${summary.focal.repoOk}/${summary.placeable}`, `${summary.focal.allocOk}/${summary.placeable}`);
row("focal margin (median x)", num(summary.focal.headMargin), num(summary.focal.repoMargin), num(summary.focal.allocMargin));
row("centroid offset — mean", num(summary.centroid.headMean, 3), num(summary.centroid.repoMean, 3), num(summary.centroid.allocMean, 3));
row("centroid offset — worst", num(summary.centroid.headWorst, 3), num(summary.centroid.repoWorst, 3), num(summary.centroid.allocWorst, 3));
row("overlaps (raw)", summary.overlaps.head, summary.overlaps.repo, summary.overlaps.alloc);
row("overlaps ex-embedded motif", summary.overlaps.headEx, "—", summary.overlaps.allocEx);
row("…scenes affected", `${summary.overlaps.headScenes}/${summary.overlaps.headScenesEx}`, summary.overlaps.repoScenes, summary.overlaps.allocScenes);
row("reading order preserved", "n/a", `${summary.readingOrder.repoKept}/${summary.readingOrder.total}`, `${summary.readingOrder.allocKept}/${summary.readingOrder.total}`);
row("coverage (context only)", pct(summary.coverage.headMean), pct(summary.coverage.repoMean), pct(summary.coverage.allocMean));
console.log(`\n── INK RE-SCORE ── same scorer, copy boxes replaced by PREDICTED INK (${inkSummary.scored} scenes; ${inkSummary.excluded} excluded for missing strings)`);
console.log(`| metric                     | HEAD      | REPOSITION | REPOS+RESIZE |`);
console.log(`|----------------------------|-----------|------------|--------------|`);
row("largest ink-void — mean", pct(inkSummary.void.headMean), pct(inkSummary.void.repoMean), pct(inkSummary.void.allocMean));
row("largest ink-void — median", pct(inkSummary.void.headMedian), pct(inkSummary.void.repoMedian), pct(inkSummary.void.allocMedian));
row("largest ink-void — worst", pct(inkSummary.void.headWorst), pct(inkSummary.void.repoWorst), pct(inkSummary.void.allocWorst));
row("scenes with ink-void > 25%", inkSummary.void.headOver25, inkSummary.void.repoOver25, inkSummary.void.allocOver25);
row("focal-1 largest (ink area)", `${inkSummary.focal.headOk}/${inkSummary.scored}`, `${inkSummary.focal.repoOk}/${inkSummary.scored}`, `${inkSummary.focal.allocOk}/${inkSummary.scored}`);
row("ink focal margin (median x)", num(inkSummary.focal.headMargin), "—", num(inkSummary.focal.allocMargin));
row("ink-centroid offset — mean", num(inkSummary.centroid.headMean, 3), num(inkSummary.centroid.repoMean, 3), num(inkSummary.centroid.allocMean, 3));
row("ink-centroid offset — worst", num(inkSummary.centroid.headWorst, 3), "—", num(inkSummary.centroid.allocWorst, 3));
console.log(`ink metrics sources: ${Object.entries(inkSummary.metricsSources).map(([k, v]) => `${k}×${v}`).join(" · ")}`);
console.log(`\nTHE GATE (pre-registered): ${gate.pass ? "PASS — the allocator's advantage SURVIVES ink scoring" : "STOP — the allocator's box-space win does not survive ink scoring"}`);
for (const k of ["a", "b", "c"]) console.log(`  (${k}) ${gate[k].pass ? "✓" : "✗"} ${gate[k].detail}`);
console.log(
  `  sensitivity (uniform predictor bias): −15% → ${gate.sensitivity.lo.pass ? "PASS" : "STOP"} (${gate.sensitivity.lo.detail}) · +15% → ${gate.sensitivity.hi.pass ? "PASS" : "STOP"} (${gate.sensitivity.hi.detail}) — verdict ${gate.robust ? "STABLE" : "NOT STABLE — do not trust it"}`,
);

console.log(`\nshape re-picked (structural void): ${summary.repicked} scenes · both arms ran on ${summary.threeWay} placeable scenes`);
console.log(
  `size sources (per element): measured ${summary.sizeSources.measured} · derived ${summary.sizeSources.derived} · ` +
    `authored-anchor ${summary.sizeSources.authored} · role prior ${summary.sizeSources.prior}`,
);
console.log(
  `hero treatment: bleed ${summary.heroTreatments.bleed} · placed ${summary.heroTreatments.placed} · unknown ${summary.heroTreatments.unknown}   ` +
    `embedded children preserved: ${summary.embedded} across ${summary.embeddedScenes} scenes`,
);
console.log(`\ndistribution diversity: ${Object.keys(shapeCounts).length} distinct shapes emitted`);
for (const [k, v] of Object.entries(shapeCounts).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
console.log(`\nby register:`);
for (const [r, set] of Object.entries(shapesByRegister).sort()) console.log(`  ${r.padEnd(12)} ${set.size} shape(s): ${[...set].sort().join(", ")}`);
console.log(`\ncontrols:`);
for (const s of controlScenes) {
  if (!s.head?.score || !s.alloc?.score) continue;
  const f = (x) => (x == null ? "—" : x.focalIsLargest === null ? "none" : x.focalIsLargest ? "yes" : "NO");
  console.log(
    `  ${s.build} s${s.ix} [${s.register}] shape=${s.alloc.shape}\n` +
      `      void      ${pct(s.head.score.largestVoid)} → repo ${pct(s.repo?.score?.largestVoid)} → resize ${pct(s.alloc.score.largestVoid)}\n` +
      `      focal     ${f(s.head.score)} → repo ${f(s.repo?.score)} → resize ${f(s.alloc.score)}\n` +
      `      centroid  ${num(s.head.score.centroidOffset, 3)} → repo ${num(s.repo?.score?.centroidOffset, 3)} → resize ${num(s.alloc.score.centroidOffset, 3)}\n` +
      `      overlaps  ${s.head.score.overlaps} (${s.head.score.overlapsExEmbedded} ex-motif) → repo ${s.repo?.score?.overlaps ?? "—"} → resize ${s.alloc.score.overlaps}\n` +
      `      artefact  ${s.treatment ? "YES — a canvas treatment is excluded, so void/centroid here are instrument artefacts" : "no"}`,
  );
  for (const e of s.head.elements) {
    if (!e.bounds) continue;
    const a = s.alloc.slots.find((x) => x.id === e.id);
    if (!a) continue;
    const ha = e.bounds.w * e.bounds.h;
    const aa = a.bounds.w * a.bounds.h;
    console.log(
      `      ${e.id.padEnd(12)} ${`${e.bounds.w}x${e.bounds.h}@${e.bounds.x},${e.bounds.y}`.padEnd(22)} -> ` +
        `${`${a.bounds.w}x${a.bounds.h}@${a.bounds.x},${a.bounds.y}`.padEnd(22)} ${(aa / ha).toFixed(2)}x  ${a.slot}`,
    );
  }
}
// ── MEASURED-TRUTH CHECK ────────────────────────────────────────────────────
//
// Everything above scores DECLARED rects. The 10 scenes with a real
// `rects-scene-N.json` let us ask what the same metrics say about what actually
// PAINTED — and the answer materially changes the comparison, so it is computed
// and reported rather than left as a caveat.
const truth = [];
for (const s of scenes) {
  if (!s.usedMeasured || !s.head?.score || !s.alloc?.score) continue;
  const p = join(ROOT, s.build, "_measure", `rects-scene-${s.ix}.json`);
  const d = readJson(p);
  if (!d?.pieces) continue;
  const painted = [];
  for (const e of s.head.elements) {
    if (!e.bounds) continue;
    const pc = d.pieces.find((x) => String(x.id).split(".").slice(1).join(".") === e.id);
    if (pc?.painted?.w > 0) painted.push({ id: e.id, role: e.role, focalRank: e.focalRank, bounds: pc.painted });
  }
  if (painted.length === 0) continue;
  const paintedScore = scoreLayout(painted, s.aspect);
  // How much bigger is a DECLARED text box than the ink it holds? The head's
  // ratio is the over-declaration; the allocator's is what the content-bounded
  // sizing yields against that same measured ink.
  const ratios = { head: [], alloc: [] };
  // PREDICTOR CALIBRATION: predicted ink height (at the render's own declared
  // wrapper box, from the rects file) vs the height that actually painted.
  const calib = [];
  for (const e of s.head.elements) {
    if (e.role !== "copy" || !e.bounds) continue;
    const pc = d.pieces.find((x) => String(x.id).split(".").slice(1).join(".") === e.id);
    const ink = pc?.painted;
    if (!(ink?.w > 0)) continue;
    ratios.head.push((e.bounds.w * e.bounds.h) / (ink.w * ink.h));
    const a = s.alloc.slots.find((x) => x.id === e.id);
    if (a) ratios.alloc.push((a.bounds.w * a.bounds.h) / (ink.w * ink.h));
    const fields = s.copyFields?.[e.id];
    const wrapper = pc.declared ?? pc.wrapper;
    if (fields && wrapper?.w > 0) {
      const { prediction } = predictInkRect({ x: wrapper.x, y: wrapper.y, w: wrapper.w, h: wrapper.h }, fields, { w: 1920, h: 1080 }, s._inkMetrics);
      calib.push({ id: e.id, declaredH: wrapper.h, paintedH: ink.h, predictedH: prediction.h, hErr: (prediction.h - ink.h) / ink.h });
    }
  }
  truth.push({ build: s.build, ix: s.ix, declared: s.head.score, painted: paintedScore, alloc: s.alloc.score, ratios, calib, inkMetricsSource: s.inkMetricsSource });
}
const calibAll = truth.flatMap((t) => t.calib.map((c) => ({ ...c, build: t.build, ix: t.ix, src: t.inkMetricsSource })));
const meanOf = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
/** The error of treating the DECLARED box as ink, on the same pieces — the
 *  benchmark the predictor must beat for ink scoring to mean anything. */
const declaredAsInkErrPct = (meanOf(calibAll.map((c) => Math.abs(c.declaredH - c.paintedH) / c.paintedH)) * 100).toFixed(0);
if (truth.length > 0) {
  const m = meanOf;
  console.log(`\nMEASURED-TRUTH CHECK — ${truth.length} scenes with real painted rects`);
  console.log(`  the head's DECLARED boxes flatter it; here is the same scorer on what PAINTED:`);
  for (const t of truth) {
    console.log(
      `  ${(t.build + " s" + t.ix).padEnd(24)} centroid ${num(t.declared.centroidOffset, 3)} declared -> ${num(t.painted.centroidOffset, 3)} PAINTED   ` +
        `void ${pct(t.declared.largestVoid)} -> ${pct(t.painted.largestVoid)}`,
    );
  }
  console.log(
    `  MEAN  centroid ${num(m(truth.map((t) => t.declared.centroidOffset)), 3)} declared -> ${num(m(truth.map((t) => t.painted.centroidOffset)), 3)} painted` +
      `   void ${pct(m(truth.map((t) => t.declared.largestVoid)))} -> ${pct(m(truth.map((t) => t.painted.largestVoid)))}`,
  );
  console.log(
    `  copy box vs its own ink:  HEAD ${num(m(truth.flatMap((t) => t.ratios.head)), 2)}x   ALLOCATOR ${num(m(truth.flatMap((t) => t.ratios.alloc)), 2)}x`,
  );
  const calibs = calibAll;
  if (calibs.length > 0) {
    console.log(`\nPREDICTOR CALIBRATION — predicted ink vs painted, per measured text piece:`);
    for (const c of calibs) {
      console.log(
        `  ${(c.build + " s" + c.ix + "." + c.id).padEnd(30)} declared h ${String(c.declaredH).padStart(4)} → painted h ${String(c.paintedH).padStart(4)} → predicted h ${String(c.predictedH).padStart(4)}  (${(c.hErr * 100).toFixed(1)}%)  [${c.src}]`,
      );
    }
    console.log(
      `  mean |hErr| ${(m(calibs.map((c) => Math.abs(c.hErr))) * 100).toFixed(1)}%  bias ${(m(calibs.map((c) => c.hErr)) * 100).toFixed(1)}%  worst ${(Math.max(...calibs.map((c) => Math.abs(c.hErr))) * 100).toFixed(1)}%`,
    );
  }
}

{
  const worst = placeable
    .filter((s) => s.alloc?.score)
    .sort((a, b) => b.alloc.score.centroidOffset - a.alloc.score.centroidOffset)
    .slice(0, 8);
  console.log(`\nworst allocator centroid offsets:`);
  for (const s of worst) {
    console.log(
      `  ${(s.build + " s" + s.ix).padEnd(34)} head ${num(s.head.score.centroidOffset, 3)} -> alloc ${num(s.alloc.score.centroidOffset, 3)}  shape ${s.alloc.shape}  n=${s.alloc.score.counted}`,
    );
  }
}
if (skipped.length) {
  console.log(`\nskipped/degraded (${skipped.length}):`);
  for (const s of skipped) console.log(`  ${s.build} s${s.scene}: ${s.why}`);
}

// ── HTML (static, no JavaScript) ────────────────────────────────────────────
const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const ROLE_FILL = {
  hero: "rgba(37,99,235,.14)",
  copy: "rgba(5,150,105,.14)",
  throughline: "rgba(217,119,6,.18)",
  connector: "rgba(147,51,234,.14)",
  atmosphere: "rgba(120,120,120,.06)",
  chrome: "rgba(120,120,120,.10)",
};
const ROLE_STROKE = {
  hero: "#2563eb",
  copy: "#059669",
  throughline: "#d97706",
  connector: "#9333ea",
  atmosphere: "#9ca3af",
  chrome: "#9ca3af",
};

const panel = (title, aspect, boxes, score, note) => {
  const dims = aspect === "9:16" ? [1080, 1920] : aspect === "1:1" ? [1080, 1080] : [1920, 1080];
  const safe = SAFE[aspect] ?? SAFE["16:9"];
  const parts = [];
  parts.push(`<svg viewBox="0 0 ${dims[0]} ${dims[1]}" class="panel" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(title)}">`);
  parts.push(`<rect x="0" y="0" width="${dims[0]}" height="${dims[1]}" fill="#fbfbfa" stroke="#111" stroke-width="4"/>`);
  parts.push(`<rect x="${safe.x}" y="${safe.y}" width="${safe.w}" height="${safe.h}" fill="none" stroke="#c9c9c4" stroke-width="3" stroke-dasharray="14 10"/>`);
  if (score?.voidRect && score.largestVoid > 0.01) {
    const v = score.voidRect;
    parts.push(`<rect x="${v.x}" y="${v.y}" width="${v.w}" height="${v.h}" fill="rgba(220,38,38,.10)" stroke="#dc2626" stroke-width="3" stroke-dasharray="8 8"/>`);
    parts.push(`<text x="${v.x + v.w / 2}" y="${v.y + v.h / 2 + 20}" fill="#dc2626" font-size="58" font-weight="700" text-anchor="middle" font-family="monospace">VOID ${(score.largestVoid * 100).toFixed(0)}%</text>`);
  }
  for (const b of boxes) {
    const fill = ROLE_FILL[b.role] ?? "rgba(80,80,80,.12)";
    const stroke = ROLE_STROKE[b.role] ?? "#4b5563";
    const dash = b.role === "atmosphere" ? ' stroke-dasharray="10 8"' : "";
    parts.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="${fill}" stroke="${stroke}" stroke-width="5"${dash}/>`);
    const label = b.focal === 1 ? `★ ${b.label}` : b.label;
    // Panels render ~400–500px wide, so viewBox type must be large to survive
    // the downscale. A short box gets its label OUTSIDE, above its top edge.
    const size = 56;
    const inside = b.h >= size * 1.6;
    const ty = inside ? b.y + size + 10 : Math.max(size, b.y - 10);
    parts.push(`<text x="${b.x + 16}" y="${ty}" fill="${stroke}" font-size="${size}" font-weight="600" font-family="monospace">${esc(label)}</text>`);
  }
  parts.push(`</svg>`);
  const artefact =
    score && score.canvasTreatments > 0
      ? `<div class="stat"><span class="warnnote">⚠ ${score.canvasTreatments} canvas treatment (≥85% of frame) excluded from scoring — the void and centroid numbers above are an ARTEFACT of that exclusion, not a defect.</span></div>`
      : "";
  const stat = score
    ? `<div class="stat"><span>void <b>${(score.largestVoid * 100).toFixed(1)}%</b></span><span>focal ${score.focalIsLargest === null ? "<b class=na>none</b>" : score.focalIsLargest ? `<b class=ok>yes</b> ×${score.focalMargin ? score.focalMargin.toFixed(2) : "—"}` : "<b class=bad>NO</b>"}</span><span>centroid <b>${score.centroidOffset.toFixed(3)}</b></span><span>overlaps <b class="${score.overlaps > 0 ? "bad" : "ok"}">${score.overlaps}</b>${score.overlaps !== score.overlapsExEmbedded ? ` <span class="na">(${score.overlapsExEmbedded} ex-motif)</span>` : ""}</span></div>${artefact}`
    : `<div class="stat"><span class="na">${esc(note ?? "not scored")}</span></div>`;
  return `<figure><figcaption>${esc(title)}</figcaption>${parts.join("")}${stat}</figure>`;
};

const sceneBlock = (s, tag) => {
  const headBoxes = (s.head?.elements ?? [])
    .filter((e) => e.bounds)
    .map((e) => ({ ...e.bounds, role: e.role, label: e.id, focal: e.focalRank }));
  const armBoxes = (arm) =>
    (arm?.slots ?? [])
      .filter((x) => x.role !== "atmosphere" && x.layer !== "chrome")
      .map((x) => ({
        ...x.bounds,
        role: x.role,
        label: x.id,
        focal: s.head?.elements.find((e) => e.id === x.id)?.focalRank ?? null,
      }));
  const allocBoxes = armBoxes(s.alloc);
  const repoBoxes = armBoxes(s.repo);

  const badges = [];
  if (tag) badges.push(`<span class="badge ${tag.cls}">${esc(tag.text)}</span>`);
  badges.push(`<span class="badge muted">${esc(s.register ?? "register unknown")}</span>`);
  if (s.alloc) badges.push(`<span class="badge shape">${esc(s.alloc.shape)}</span>`);
  badges.push(`<span class="badge ${s.usedMeasured ? "ok" : "muted"}">${s.usedMeasured ? "measured rects" : "size prior"}</span>`);
  if (s.unplacedByHead?.length) badges.push(`<span class="badge warn">head left ${s.unplacedByHead.length} unplaced</span>`);
  if (s.alloc && s.alloc.readingOrderKept === false) badges.push(`<span class="badge warn">reading order PERMUTED</span>`);
  if (s.treatment) badges.push(`<span class="badge warn">canvas treatment — void/centroid are artefacts</span>`);

  let body;
  if (s.skipped) {
    body = `<p class="skipnote">SKIPPED — ${esc(s.skipped)}. No head panel and no allocator panel could be produced for this scene.</p>`;
  } else {
    const headPanel = headBoxes.length
      ? panel("HEAD — authored bounds", s.aspect, headBoxes, s.head.score)
      : panel("HEAD — authored bounds", s.aspect, [], null, "head authored NO bounds (pre-frame-authoring build)");
    const repoPanel = s.repo
      ? panel("REPOSITION ONLY — head's sizes kept", s.aspect, repoBoxes, s.repo.score)
      : panel("REPOSITION ONLY", s.aspect, [], null, "no authored sizes to keep");
    const allocPanel = s.alloc
      ? panel(`REPOSITION + RESIZE — ${s.alloc.shape}${s.alloc.repicked ? " (re-picked)" : ""}`, s.aspect, allocBoxes, s.alloc.score)
      : panel("REPOSITION + RESIZE", s.aspect, [], null, `allocator error: ${s.allocError ?? "unknown"}`);
    const framePanel = s.frame
      ? `<figure><figcaption>RENDERED FRAME</figcaption><img loading="lazy" src="${esc(s.frame)}" alt="rendered frame ${esc(s.build)} scene ${s.ix}"/></figure>`
      : `<figure><figcaption>RENDERED FRAME</figcaption><div class="noframe">no frame on disk</div></figure>`;
    body = `<div class="panels">${headPanel}${repoPanel}${allocPanel}${framePanel}</div>`;
  }
  return `<section class="scene"><h3>${esc(s.build)} · scene ${s.ix} ${badges.join(" ")}</h3>${body}</section>`;
};

const rowFor = (s) => {
  const h = s.head?.score;
  const a = s.alloc?.score;
  const arrow = (x, y, fmt, lowerBetter = true) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return `<td class="na">—</td>`;
    const better = lowerBetter ? y < x : y > x;
    return `<td>${fmt(x)} → <b class="${better ? "ok" : y === x ? "" : "bad"}">${fmt(y)}</b></td>`;
  };
  const focalCell = (sc) => (sc == null ? "—" : sc.focalIsLargest === null ? "none" : sc.focalIsLargest ? "yes" : "NO");
  return `<tr>
<td><a href="#s-${esc(s.build)}-${s.ix}">${esc(s.build)}</a></td>
<td>${s.ix}</td>
<td class="muted">${esc(s.register ?? "—")}</td>
<td class="muted">${esc(s.alloc?.shape ?? "—")}</td>
${arrow(h?.largestVoid, a?.largestVoid, (v) => `${(v * 100).toFixed(0)}%`)}
<td>${focalCell(h)} → <b class="${a?.focalIsLargest ? "ok" : "bad"}">${focalCell(a)}</b></td>
${arrow(h?.centroidOffset, a?.centroidOffset, (v) => v.toFixed(2))}
${arrow(h?.overlapsExEmbedded, a?.overlapsExEmbedded, (v) => String(v))}
<td class="muted">${s.skipped ? esc(s.skipped) : s.head?.score ? (s.usedMeasured ? "measured" : "prior") : "no head bounds"}${s.treatment ? ' <b class="bad">artefact</b>' : ""}</td>
</tr>`;
};

const byBuild = new Map();
for (const s of scenes) {
  if (!byBuild.has(s.build)) byBuild.set(s.build, []);
  byBuild.get(s.build).push(s);
}

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Allocator dry-run — head vs deterministic allocator</title>
<style>
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; padding: 32px 28px 96px; background: #fafaf9; color: #18181b;
  font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif; }
h1 { font-size: 26px; margin: 0 0 6px; letter-spacing: -.02em; }
h2 { font-size: 19px; margin: 44px 0 8px; padding-top: 14px; border-top: 2px solid #e4e4e7; letter-spacing: -.01em; }
h3 { font-size: 14px; margin: 26px 0 8px; font-weight: 600; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
p.sub { color: #52525b; max-width: 78ch; margin: 0 0 10px; }
.panels { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; align-items: start; }
@media (max-width: 1500px) { .panels { grid-template-columns: repeat(2, minmax(0,1fr)); } }
@media (max-width: 780px) { .panels { grid-template-columns: 1fr; } }
figure { margin: 0; background: #fff; border: 1px solid #e4e4e7; border-radius: 8px; padding: 8px; }
figcaption { font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: #71717a;
  text-transform: uppercase; letter-spacing: .06em; margin-bottom: 6px; }
svg.panel, figure img { display: block; width: 100%; height: auto; border-radius: 4px; }
figure img { border: 1px solid #e4e4e7; aspect-ratio: 16 / 9; object-fit: contain; background: #f4f4f5; }
.noframe { display: flex; align-items: center; justify-content: center; aspect-ratio: 16/9;
  color: #a1a1aa; font: 12px ui-monospace, monospace; background: #f4f4f5; border-radius: 4px; }
.stat { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 6px;
  font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; color: #52525b; }
.stat b { color: #18181b; } b.ok { color: #059669; } b.bad { color: #dc2626; } b.na, .na { color: #a1a1aa; }
.badge { display: inline-block; font: 10px/1.6 ui-monospace, monospace; padding: 1px 7px; border-radius: 999px;
  border: 1px solid #d4d4d8; color: #52525b; background: #fff; vertical-align: middle; text-transform: none; letter-spacing: 0; }
.badge.fail { background: #fef2f2; border-color: #fecaca; color: #b91c1c; font-weight: 700; }
.badge.control { background: #eff6ff; border-color: #bfdbfe; color: #1d4ed8; font-weight: 700; }
.badge.shape { background: #f5f3ff; border-color: #ddd6fe; color: #6d28d9; }
.badge.ok { background: #ecfdf5; border-color: #a7f3d0; color: #047857; }
.badge.warn { background: #fffbeb; border-color: #fde68a; color: #b45309; }
.badge.muted { color: #71717a; }
table { border-collapse: collapse; width: 100%; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; margin: 10px 0 8px; }
th, td { border: 1px solid #e4e4e7; padding: 3px 7px; text-align: left; white-space: nowrap; }
th { background: #f4f4f5; font-weight: 600; position: sticky; top: 0; }
td.muted, .muted { color: #71717a; }
td a { color: #1d4ed8; text-decoration: none; }
.scene { scroll-margin-top: 20px; }
.skipnote { background: #fffbeb; border: 1px solid #fde68a; color: #92400e; padding: 10px 12px; border-radius: 6px;
  font: 12px ui-monospace, monospace; }
.warnnote { color: #b45309; background:#fffbeb; border:1px solid #fde68a; border-radius:5px; padding:4px 7px; line-height:1.5; }
.legend { display: flex; flex-wrap: wrap; gap: 14px; font: 11px ui-monospace, monospace; color: #52525b; margin: 8px 0 4px; }
.sw { display: inline-block; width: 11px; height: 11px; border-radius: 2px; vertical-align: -1px; margin-right: 4px; border: 2px solid; }
.kpi { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px,1fr)); gap: 10px; margin: 12px 0 4px; }
.kpi div { background: #fff; border: 1px solid #e4e4e7; border-radius: 8px; padding: 10px 12px; }
.kpi span { display: block; font: 10px ui-monospace, monospace; color: #71717a; text-transform: uppercase; letter-spacing: .06em; }
.kpi strong { font-size: 17px; font-weight: 650; }
</style></head><body>

<h1>Allocator dry-run — composition head vs deterministic allocator</h1>
<p class="sub">Offline replay over <b>${summary.builds} stored builds / ${summary.scenes} scenes</b>. Zero API calls: every box on this page
comes from <code>composition.json</code> already on disk, or from <code>lib/agents/allocate-layout.ts</code> run locally.
Left panel = the head's authored bounds. Middle = what the allocator would have produced from the same element list.
Right = the frame that actually rendered, where one exists on disk. The dashed grey rect is SMPTE title-safe;
the dashed red rect is the largest contiguous dead region, the defect this experiment is about.</p>

<div class="legend">
<span><i class="sw" style="border-color:#2563eb;background:rgba(37,99,235,.14)"></i>hero</span>
<span><i class="sw" style="border-color:#059669;background:rgba(5,150,105,.14)"></i>copy</span>
<span><i class="sw" style="border-color:#d97706;background:rgba(217,119,6,.18)"></i>throughline</span>
<span><i class="sw" style="border-color:#9333ea;background:rgba(147,51,234,.14)"></i>connector</span>
<span><i class="sw" style="border-color:#dc2626;background:rgba(220,38,38,.10)"></i>largest void</span>
<span>★ = focalRank 1</span>
</div>

<div class="kpi">
<div><span>largest void (mean)</span><strong>${pct(summary.void.headMean)} → ${pct(summary.void.allocMean)}</strong></div>
<div><span>focal-1 is largest</span><strong>${summary.focal.headOk}/${summary.placeable} → ${summary.focal.allocOk}/${summary.placeable}</strong></div>
<div><span>centroid offset (mean)</span><strong>${num(summary.centroid.headMean, 3)} → ${num(summary.centroid.allocMean, 3)}</strong></div>
<div><span>overlaps, ex-embedded motif</span><strong>${summary.overlaps.headEx} → ${summary.overlaps.allocEx}</strong></div>
<div><span>distinct shapes emitted</span><strong>${Object.keys(shapeCounts).length}</strong></div>
<div><span>scenes with real measured rects</span><strong>${summary.measured} / ${summary.scenes}</strong></div>
</div>

<p class="sub"><b>Read the numbers with these caveats.</b> (1) The allocator's <b>0 overlaps</b> is a TAUTOLOGY, not a
result — disjointness is a construction invariant it asserts on every call, so the only informative overlap number is
the head's. Of the head's ${summary.overlaps.head} raw overlaps, only <b>${summary.overlaps.headEx}</b> survive once a
throughline motif fully embedded inside another element is treated as the deliberate layering the 2026-07-18 work
showed it to be. (2) Void and centroid are aggregated over the <b>${summary.placeable} placeable</b> scenes only.
<b>${summary.treatments}</b> scenes carry a canvas treatment (an element ≥85% of the frame); the scorer excludes those
rects, so those scenes are scored on their small overlaid insets alone and report enormous voids that are artefacts of
the instrument. (3) Every number here scores DECLARED rects — see the measured-truth check below, where both sides'
defects turn out to be about twice as bad as the plans suggest.</p>

<h2>Inputs the allocator is given</h2>
<p class="sub">Round 1 sized every element from a role name and inferred bleed-vs-placed from the register. Both were
wrong, and both were MISSING INPUTS rather than design flaws. This run supplies them from what is already on disk.</p>
<table><thead><tr><th>input</th><th>count</th><th>what it is</th></tr></thead><tbody>
<tr><td>size — measured</td><td>${summary.sizeSources.measured}</td><td>a real painted rect from <code>_measure/rects-scene-N.json</code>. Ground truth for text.</td></tr>
<tr><td>size — derived</td><td>${summary.sizeSources.derived}</td><td>capacity-computed from the REAL copy strings, at the type scale <code>deriveTypeScale</code> picks for that box.</td></tr>
<tr><td>size — authored anchor</td><td>${summary.sizeSources.authored}</td><td>the head's own box, used as a BOUNDED scale anchor. The only honest hero signal — see below.</td></tr>
<tr><td>size — role prior</td><td>${summary.sizeSources.prior}</td><td>role name only. What round 1 used for everything.</td></tr>
<tr><td>hero treatment</td><td>${summary.heroTreatments.bleed} bleed / ${summary.heroTreatments.placed} placed / ${summary.heroTreatments.unknown} unknown</td><td>from the head's authored hero area (≥85% of frame = a canvas treatment). Unknown resolves to PLACED — never inflate on an absent signal.</td></tr>
<tr><td>embedded children</td><td>${summary.embedded} across ${summary.embeddedScenes} scenes</td><td>a motif the head placed INSIDE another element, kept there at the same relative rect instead of re-placed as a floating badge.</td></tr>
</tbody></table>
<p class="sub"><b>A hero's content size is NOT derivable, and more measuring will not change that.</b> In all 10 measured
scenes the hero's painted area equals its authored area to the pixel — a diegetic element is mounted into its declared
box and fills it, so the measurement returns the box, never the content's need. Interior-item count does not stand in
for it either: 8 interior items appears at 0.093 of canvas AND at 0.408. That is why the allocator takes the head's
hero SCALE as a bounded anchor rather than inventing one, and it is the sharpest limit on how much authority a solver
can take here.</p>

<h2>Metrics — head vs reposition-only vs reposition+resize</h2>
<p class="sub">Two allocator arms. <b>REPOSITION</b> keeps the head's authored SIZE for every element and changes only where the
box sits. <b>REPOSITION + RESIZE</b> takes both authorities. The gap between the two columns is the answer to
"is it the head's placement or the head's sizing that is wrong".</p>
<table><thead><tr><th>metric</th><th>HEAD</th><th>REPOSITION ONLY</th><th>REPOSITION + RESIZE</th></tr></thead><tbody>
<tr><td>largest void — mean</td><td>${pct(summary.void.headMean)}</td><td>${pct(summary.void.repoMean)}</td><td>${pct(summary.void.allocMean)}</td></tr>
<tr><td>largest void — median</td><td>${pct(summary.void.headMedian)}</td><td>${pct(summary.void.repoMedian)}</td><td>${pct(summary.void.allocMedian)}</td></tr>
<tr><td>largest void — worst</td><td>${pct(summary.void.headWorst)}</td><td>${pct(summary.void.repoWorst)}</td><td>${pct(summary.void.allocWorst)}</td></tr>
<tr><td>scenes with void &gt; 25%</td><td>${summary.void.headOver25}</td><td>${summary.void.repoOver25}</td><td>${summary.void.allocOver25}</td></tr>
<tr><td>focal-1 holds the largest area</td><td>${summary.focal.headOk}/${summary.placeable}</td><td>${summary.focal.repoOk}/${summary.placeable}</td><td>${summary.focal.allocOk}/${summary.placeable}</td></tr>
<tr><td>focal margin (median ×)</td><td>${num(summary.focal.headMargin)}</td><td>${num(summary.focal.repoMargin)}</td><td>${num(summary.focal.allocMargin)}</td></tr>
<tr><td>centroid offset — mean</td><td>${num(summary.centroid.headMean, 3)}</td><td>${num(summary.centroid.repoMean, 3)}</td><td>${num(summary.centroid.allocMean, 3)}</td></tr>
<tr><td>centroid offset — worst</td><td>${num(summary.centroid.headWorst, 3)}</td><td>${num(summary.centroid.repoWorst, 3)}</td><td>${num(summary.centroid.allocWorst, 3)}</td></tr>
<tr><td>overlaps (raw)</td><td>${summary.overlaps.head}</td><td>${summary.overlaps.repo}</td><td>${summary.overlaps.alloc}</td></tr>
<tr><td>overlaps ex-embedded motif</td><td>${summary.overlaps.headEx}</td><td class="muted">—</td><td>${summary.overlaps.allocEx}</td></tr>
<tr><td>reading order preserved</td><td class="muted">n/a</td><td>${summary.readingOrder.repoKept}/${summary.readingOrder.total}</td><td>${summary.readingOrder.allocKept}/${summary.readingOrder.total}</td></tr>
<tr><td>coverage (context only, not a target)</td><td>${pct(summary.coverage.headMean)}</td><td>${pct(summary.coverage.repoMean)}</td><td>${pct(summary.coverage.allocMean)}</td></tr>
</tbody></table>
<p class="sub"><b>Reposition-only is WORSE than the head on void and centroid.</b> Every gain in the third column comes from
RESIZING. That is the load-bearing result of this dry run: the head's coordinates are broadly fine, its SIZES are not.
Note also that the shape re-pick (structural dead space → change the distribution) fired on
<b>${summary.repicked}</b> scenes — the local grow-the-neighbour repair handled every void in the corpus, so the
re-pick ladder is currently unexercised code.</p>

<h2>Ink re-score — the same metrics on PREDICTED INK, not declared boxes</h2>
<p class="sub"><b>Why.</b> The measured rects split the corpus cleanly: a diegetic piece paints its declared box pixel-exact
(21/21), a text piece never does (0/10 — the declared box runs 1.04–2.09× its own ink, mean ≈1.5×). Every number in the
box-space table above therefore overstates how full a frame is. Here every copy box is replaced by its <b>predicted
ink</b> — the element's own verbatim strings wrapped through the calibrated capacity stack (<code>lib/agents/predict-ink.ts</code>)
at the type scale the pipeline declares for that box — anchored <b>top-left</b> (block flow) at the <b>full measure</b>
(both stated assumptions; 8/10 measured text pieces paint exactly their declared width and all 10 paint from the top edge).
Diegetic boxes are unchanged (declared = painted, measured). Same scorer, same held-out rules.
Scored over <b>${inkSummary.scored}</b> placeable scenes; <b>${inkSummary.excluded}</b> excluded because a copy element
has no strings on disk. Metrics: ${esc(Object.entries(inkSummary.metricsSources).map(([k, v]) => `${k}×${v}`).join(" · "))}.</p>
<table><thead><tr><th>metric (INK space)</th><th>HEAD</th><th>REPOSITION ONLY</th><th>REPOSITION + RESIZE</th></tr></thead><tbody>
<tr><td>largest ink-void — mean</td><td>${pct(inkSummary.void.headMean)}</td><td>${pct(inkSummary.void.repoMean)}</td><td>${pct(inkSummary.void.allocMean)}</td></tr>
<tr><td>largest ink-void — median</td><td>${pct(inkSummary.void.headMedian)}</td><td>${pct(inkSummary.void.repoMedian)}</td><td>${pct(inkSummary.void.allocMedian)}</td></tr>
<tr><td>largest ink-void — worst</td><td>${pct(inkSummary.void.headWorst)}</td><td>${pct(inkSummary.void.repoWorst)}</td><td>${pct(inkSummary.void.allocWorst)}</td></tr>
<tr><td>scenes with ink-void &gt; 25%</td><td>${inkSummary.void.headOver25}</td><td>${inkSummary.void.repoOver25}</td><td>${inkSummary.void.allocOver25}</td></tr>
<tr><td>focal-1 holds the largest INK area</td><td>${inkSummary.focal.headOk}/${inkSummary.scored}</td><td>${inkSummary.focal.repoOk}/${inkSummary.scored}</td><td>${inkSummary.focal.allocOk}/${inkSummary.scored}</td></tr>
<tr><td>ink focal margin (median ×)</td><td>${num(inkSummary.focal.headMargin)}</td><td class="muted">—</td><td>${num(inkSummary.focal.allocMargin)}</td></tr>
<tr><td>ink-centroid offset — mean</td><td>${num(inkSummary.centroid.headMean, 3)}</td><td>${num(inkSummary.centroid.repoMean, 3)}</td><td>${num(inkSummary.centroid.allocMean, 3)}</td></tr>
<tr><td>ink-centroid offset — worst</td><td>${num(inkSummary.centroid.headWorst, 3)}</td><td class="muted">—</td><td>${num(inkSummary.centroid.allocWorst, 3)}</td></tr>
</tbody></table>
<p class="sub"><b>THE GATE — ${gate.pass ? '<b class="ok">PASS</b>: the allocator&#39;s advantage survives ink scoring' : '<b class="bad">STOP</b>: the allocator&#39;s box-space win does not survive ink scoring'}.</b>
Pre-registered before the numbers were read: (a) allocator must at most halve the head&#39;s &gt;25% ink-void count —
${gate.a.pass ? "✓" : "✗"} ${esc(gate.a.detail)}; (b) mean ink-void at least 2.0pp below the head — ${gate.b.pass ? "✓" : "✗"}
${esc(gate.b.detail)}; (c) ink focal dominance not worse — ${gate.c.pass ? "✓" : "✗"} ${esc(gate.c.detail)}.
Sensitivity to predictor error (every prediction uniformly biased): −15% → ${gate.sensitivity.lo.pass ? "PASS" : "STOP"}
(${esc(gate.sensitivity.lo.detail)}); +15% → ${gate.sensitivity.hi.pass ? "PASS" : "STOP"} (${esc(gate.sensitivity.hi.detail)}).
The verdict is ${gate.robust ? "STABLE under the predictor&#39;s measured error band" : "NOT STABLE — do not trust it"}.</p>
${
  calibAll.length > 0
    ? `<h2>Predictor calibration — predicted ink vs what actually painted</h2>
<p class="sub">The ink re-score is only as good as the predictor. On the ${calibAll.length} measured text pieces
(the only pieces with painted ground truth), predicted height vs painted height, at the render&#39;s own wrapper box,
using each build&#39;s own calibrated brand face:</p>
<table><thead><tr><th>piece</th><th>declared h</th><th>painted h</th><th>predicted h</th><th>height error</th><th>metrics</th></tr></thead><tbody>
${calibAll.map((c) => `<tr><td>${esc(c.build)} s${c.ix}.${esc(c.id)}</td><td>${c.declaredH}</td><td>${c.paintedH}</td><td>${c.predictedH}</td><td class="${Math.abs(c.hErr) > 0.2 ? "bad" : ""}">${(c.hErr * 100).toFixed(1)}%</td><td class="muted">${esc(c.src)}</td></tr>`).join("\n")}
<tr><td><b>MEAN |err| / bias</b></td><td></td><td></td><td></td><td><b>${(meanOf(calibAll.map((c) => Math.abs(c.hErr))) * 100).toFixed(1)}% / ${(meanOf(calibAll.map((c) => c.hErr)) * 100).toFixed(1)}%</b></td><td></td></tr>
</tbody></table>
<p class="sub">Two of the ten scenes are emission-contract violations, not predictor error (flags-notion s4&#39;s render
DROPPED its owned headline; flags-on-rappi s3&#39;s copy leaf DUPLICATED the hero-owned stat + chips into its own box —
both verified in the measured element walk). Excluding those two, the predictor&#39;s mean |height error| is ~10%
(worst ~19%) — the golden test <code>predict-ink.test.ts</code> pins both numbers. For comparison, scoring the DECLARED
box as if it were ink errs by the full over-declaration: mean ≈ +${declaredAsInkErrPct}% on the same pieces.</p>`
    : ""
}

<h2>Structural preservation on the three controls</h2>
<p class="sub">The main way this experiment can produce a MISLEADING pass: eliminate voids and overlaps while scrambling
what the regions mean. Metrics cannot see that, so it is stated here in words, with the boxes. Round 1's verdicts were
DESTROYED / DEGRADED / MOSTLY PRESERVED; with the two missing inputs supplied, all three are preserved.</p>
<table><thead><tr><th>control</th><th>head</th><th>allocator</th><th>round 1</th><th>now</th></tr></thead><tbody>
<tr><td>flags-notion s2<br><span class="muted">split · placed</span></td>
<td>hero 920×920@60,80 · motif 130×34 as a chip inside the card header · copy 800×666@1040,214</td>
<td>hero 950×807@96,110 (<b>0.91×</b>) · motif 134×30 <b>still embedded in the hero</b> (0.91×) · copy 708×582@1116,213 (0.77×)</td>
<td><b class="ok">mostly preserved</b> — motif became a corner badge at 8.9× its area</td>
<td><b class="ok">PRESERVED</b></td></tr>
<tr><td>p3-cycle8-razorpay s2<br><span class="muted">full-bleed · placed</span></td>
<td>a checkout modal 1080×920@420,80 dead-centre · the payment-button motif embedded inside it · 320×200 of copy in the lower-left</td>
<td>hero 1234×769@442,54 (<b>0.96×</b>, still centred on the frame axis) · motif 503×234 <b>still embedded</b> (0.96×) · copy 311×319 (1.55×)</td>
<td><b class="bad">DESTROYED</b> — hero became the whole canvas, copy 8×</td>
<td><b class="ok">PRESERVED</b></td></tr>
<tr><td>final-checkr s2<br><span class="muted">full-bleed · bleed</span></td>
<td>dashboard inset 40px from every edge (1840×1000@40,40) · a 64×64 status ring inside it · copy 720×180@280,820</td>
<td>hero 1840×1000@40,40 (<b>1.00× — the inset margin survives exactly</b>) · ring 64×64@940,210 (<b>1.00×, identical</b>) · copy 710×335@138,618 (1.84×)</td>
<td><b class="bad">DEGRADED</b> — bled to the edge, ring became a badge, copy 3.98×</td>
<td><b class="ok">PRESERVED</b> <span class="muted">(copy still 1.8×)</span></td></tr>
</tbody></table>
<p class="sub"><b>What fixed them.</b> The embedded-child relation (a motif inside a hero stays inside that hero at the
same relative rect) and the explicit bleed-vs-placed signal, plus a content-derived ceiling on text boxes. The one
residual is checkr's copy at 1.84× — inside the 2.0× ceiling, and the derived extent says the
head's own 720×180 box is in fact 1.29× TIGHTER than its strings need, so some of that growth is a correction rather
than an inflation. It is still a change to a frame nobody complained about, and it is the honest residual.</p>

<h2>Measured-truth check — declared rects flatter BOTH sides</h2>
<p class="sub">Every metric above scores DECLARED rects. On the ${truth.length} scenes with a real
<code>rects-scene-N.json</code>, the same scorer over what actually PAINTED says the defects are roughly twice as
severe as the plans suggest.</p>
<table><thead><tr><th>scene</th><th>centroid declared → painted</th><th>largest void declared → painted</th></tr></thead><tbody>
${truth
  .map(
    (t) =>
      `<tr><td>${esc(t.build)} s${t.ix}</td><td>${num(t.declared.centroidOffset, 3)} → <b class="bad">${num(t.painted.centroidOffset, 3)}</b></td><td>${pct(t.declared.largestVoid)} → <b class="bad">${pct(t.painted.largestVoid)}</b></td></tr>`,
  )
  .join("\n")}
<tr><td><b>MEAN</b></td><td><b>${num(truth.reduce((a, t) => a + t.declared.centroidOffset, 0) / Math.max(1, truth.length), 3)} → ${num(truth.reduce((a, t) => a + t.painted.centroidOffset, 0) / Math.max(1, truth.length), 3)}</b></td><td><b>${pct(truth.reduce((a, t) => a + t.declared.largestVoid, 0) / Math.max(1, truth.length))} → ${pct(truth.reduce((a, t) => a + t.painted.largestVoid, 0) / Math.max(1, truth.length))}</b></td></tr>
</tbody></table>
<p class="sub"><b>This does NOT hand the allocator a win, and it is reported because it cuts against a tidy story.</b>
A declared copy box measures <b>1.42×</b> its own painted ink for the head and <b>1.48×</b> for the allocator — the
same. So the over-declaration is not something the allocator fixes, and the RELATIVE comparison in the table above
survives. What it establishes is that the real defect is about twice what the declared numbers say, for both sides,
which raises the value of a better distribution rather than lowering it. Confirming that would need a render, and no
render was run.</p>

<h2>Index — every scene</h2>
<p class="sub">Ordered failure-cases first, then the must-not-wreck controls, then the rest alphabetically by build.
Every scene in the corpus has a row here and a panel below, including the ones that could not be scored.</p>
<table>
<thead><tr><th>build</th><th>s</th><th>register</th><th>allocator shape</th><th>largest void</th><th>focal-1 largest</th><th>centroid</th><th>overlaps (ex-motif)</th><th>size source</th></tr></thead>
<tbody>
${[...failureScenes, ...controlScenes, ...scenes.filter((s) => !prioritySet.has(key(s)))].map(rowFor).join("\n")}
</tbody></table>

<h2>Distribution diversity</h2>
<p class="sub">Variety is a hard requirement — if the allocator emitted one balanced grid for everything it has failed
even if the metrics improved. Shapes actually emitted across the corpus:</p>
<table><thead><tr><th>shape</th><th>scenes</th></tr></thead><tbody>
${Object.entries(shapeCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join("\n")}
</tbody></table>
<table><thead><tr><th>register</th><th>distinct shapes</th><th>which</th></tr></thead><tbody>
${Object.entries(shapesByRegister).sort().map(([r, set]) => `<tr><td>${esc(r)}</td><td>${set.size}</td><td>${esc([...set].sort().join(", "))}</td></tr>`).join("\n")}
</tbody></table>

<h2>1 · Failure cases — the voids this experiment exists to fix</h2>
${failureScenes.map((s) => `<a id="p-${esc(s.build)}-${s.ix}"></a>` + sceneBlock(s, { cls: "fail", text: "FAILURE CASE" })).join("\n")}

<h2>2 · Controls — the three best frames we have. These must not get worse.</h2>
${controlScenes.map((s) => `<a id="p-${esc(s.build)}-${s.ix}"></a>` + sceneBlock(s, { cls: "control", text: "CONTROL — MUST NOT WRECK" })).join("\n")}

<h2>3 · The full corpus, grouped by build</h2>
<p class="sub">All ${summary.scenes} scenes, including the eight above (repeated here so each build reads as a whole video).</p>
${[...byBuild.entries()]
  .map(
    ([b, list]) =>
      `<h2 id="b-${esc(b)}">${esc(b)} <span class="badge muted">${list.length} scenes</span></h2>` +
      list
        .map((s) => {
          const t = prioritySet.has(key(s))
            ? failureScenes.includes(s)
              ? { cls: "fail", text: "FAILURE CASE" }
              : { cls: "control", text: "CONTROL" }
            : null;
          return `<a id="s-${esc(s.build)}-${s.ix}"></a>` + sceneBlock(s, t);
        })
        .join("\n"),
  )
  .join("\n")}

${
  skipped.length
    ? `<h2>Scenes that could not be processed</h2><table><thead><tr><th>build</th><th>scene</th><th>why</th></tr></thead><tbody>${skipped
        .map((s) => `<tr><td>${esc(s.build)}</td><td>${esc(s.scene)}</td><td>${esc(s.why)}</td></tr>`)
        .join("")}</tbody></table>`
    : `<h2>Scenes that could not be processed</h2><p class="sub">None — every scene in the corpus produced both panels.</p>`
}

</body></html>`;

const outPath = join(ROOT, "ALLOCATOR_DRYRUN.html");
writeFileSync(outPath, html);
console.log(`\nwrote ${outPath} (${(html.length / 1024).toFixed(0)} KB, ${scenes.length} scenes)\n`);

writeFileSync(
  join(ROOT, "ALLOCATOR_DRYRUN.json"),
  JSON.stringify({ summary, ink: inkSummary, gate, calibration: calibAll, shapeCounts, shapesByRegister: Object.fromEntries(Object.entries(shapesByRegister).map(([k, v]) => [k, [...v].sort()])), skipped }, null, 2),
);

// ── ALLOCATOR_INK_RESCORE.md — the standalone comparison the gate reads ─────
const mdRow = (label, h, r, a) => `| ${label} | ${h} | ${r} | ${a} |`;
const md = `# Allocator ink re-score — ${new Date().toISOString().slice(0, 10)}

Re-scores the round-2 allocator dry run on **predicted ink** instead of declared
boxes. ZERO API calls — pure replay over stored artifacts plus
\`lib/agents/predict-ink.ts\` run locally.

## Why ink

From the persisted \`rects-scene-N.json\` (10 measured scenes):
- **Diegetic pieces: declared box = painted ink, pixel-exact (21/21).**
- **Text pieces: 0/10 match** — painted ink is always smaller than the declared
  box (the box runs 1.04–2.09× its ink, mean ≈1.5×). A declared text box is a
  ceiling, not a fill.
Every box-space metric therefore overstates how full a frame is. Ink is the
unit of account.

## Assumptions (stated, per the brief)

- Text ink = the element's own verbatim strings (from \`script.generated.json\`)
  wrapped through the calibrated capacity stack at the type scale
  \`deriveTypeScale\` picks for the box — the same scale the pipeline declares
  to the emitter.
- The ink rect is anchored **top-left** in the declared box (block flow) at the
  **full measure** (ink w = box w). Measured support: all 10 text pieces paint
  from the box's top edge (offsets 2–48px); 8/10 paint exactly their declared
  width. Over-stating ink width under-states voids for BOTH sides symmetrically.
- Diegetic/mock boxes are ink verbatim (measured exact).
- Metrics: each build's own calibrated brand face where one exists on disk
  (${Object.entries(inkSummary.metricsSources).map(([k, v]) => `${k}×${v}`).join(" · ")});
  otherwise a 0.52em/char typical-sans prediction posture.
- Scenes where a copy element has no strings on disk are EXCLUDED from ink
  aggregates on both sides (${inkSummary.excluded} scenes: ${inkExcluded.map((s) => `${s.build} s${s.ix}`).join(", ") || "none"}).

## Box-space vs ink-space, head vs allocator (${summary.placeable} / ${inkSummary.scored} placeable scenes)

| metric (BOX space) | HEAD | REPOSITION | REPOS+RESIZE |
|---|---|---|---|
${mdRow("largest void — mean", pct(summary.void.headMean), pct(summary.void.repoMean), pct(summary.void.allocMean))}
${mdRow("largest void — median", pct(summary.void.headMedian), pct(summary.void.repoMedian), pct(summary.void.allocMedian))}
${mdRow("largest void — worst", pct(summary.void.headWorst), pct(summary.void.repoWorst), pct(summary.void.allocWorst))}
${mdRow("scenes with void > 25%", summary.void.headOver25, summary.void.repoOver25, summary.void.allocOver25)}
${mdRow("focal-1 holds largest area", `${summary.focal.headOk}/${summary.placeable}`, `${summary.focal.repoOk}/${summary.placeable}`, `${summary.focal.allocOk}/${summary.placeable}`)}
${mdRow("centroid offset — mean", num(summary.centroid.headMean, 3), num(summary.centroid.repoMean, 3), num(summary.centroid.allocMean, 3))}

| metric (INK space) | HEAD | REPOSITION | REPOS+RESIZE |
|---|---|---|---|
${mdRow("largest ink-void — mean", pct(inkSummary.void.headMean), pct(inkSummary.void.repoMean), pct(inkSummary.void.allocMean))}
${mdRow("largest ink-void — median", pct(inkSummary.void.headMedian), pct(inkSummary.void.repoMedian), pct(inkSummary.void.allocMedian))}
${mdRow("largest ink-void — worst", pct(inkSummary.void.headWorst), pct(inkSummary.void.repoWorst), pct(inkSummary.void.allocWorst))}
${mdRow("scenes with ink-void > 25%", inkSummary.void.headOver25, inkSummary.void.repoOver25, inkSummary.void.allocOver25)}
${mdRow("focal-1 holds largest INK area", `${inkSummary.focal.headOk}/${inkSummary.scored}`, `${inkSummary.focal.repoOk}/${inkSummary.scored}`, `${inkSummary.focal.allocOk}/${inkSummary.scored}`)}
${mdRow("ink focal margin (median ×)", num(inkSummary.focal.headMargin), "—", num(inkSummary.focal.allocMargin))}
${mdRow("ink-centroid offset — mean", num(inkSummary.centroid.headMean, 3), num(inkSummary.centroid.repoMean, 3), num(inkSummary.centroid.allocMean, 3))}
${mdRow("ink-centroid offset — worst", num(inkSummary.centroid.headWorst, 3), "—", num(inkSummary.centroid.allocWorst, 3))}

## THE GATE — ${gate.pass ? "PASS" : "STOP"}

Pre-registered criteria ("materially better on ink" = ALL of):

- (a) ${gate.a.pass ? "✓" : "✗"} ${gate.a.detail}
- (b) ${gate.b.pass ? "✓" : "✗"} ${gate.b.detail}
- (c) ${gate.c.pass ? "✓" : "✗"} ${gate.c.detail}

Sensitivity (the predictor's measured error is ~10–14%, so the verdict is
re-evaluated with every prediction uniformly biased ±15% — both sides share the
predictor, so systematic error moves them together):

- −15%: ${gate.sensitivity.lo.pass ? "PASS" : "STOP"} (${gate.sensitivity.lo.detail})
- +15%: ${gate.sensitivity.hi.pass ? "PASS" : "STOP"} (${gate.sensitivity.hi.detail})
- verdict is ${gate.robust ? "**STABLE** under predictor error" : "**NOT STABLE** — do not trust it"}

${gate.pass ? "The allocator's advantage survives ink scoring; Stage B (pipeline wiring, flag-gated off) proceeds." : "The allocator's box-space advantage was substantially an artefact of scoring reserved rectangles. Stage B does NOT proceed; only this re-score lands."}

## Predictor calibration — predicted ink vs painted (${calibAll.length} measured text pieces)

| piece | declared h | painted h | predicted h | height error | metrics |
|---|---|---|---|---|---|
${calibAll.map((c) => `| ${c.build} s${c.ix}.${c.id} | ${c.declaredH} | ${c.paintedH} | ${c.predictedH} | ${(c.hErr * 100).toFixed(1)}% | ${c.src} |`).join("\n")}
| **mean abs / bias** | | | | **${(meanOf(calibAll.map((c) => Math.abs(c.hErr))) * 100).toFixed(1)}% / ${(meanOf(calibAll.map((c) => c.hErr)) * 100).toFixed(1)}%** | |

Two of the ten are emission-contract violations, not predictor error
(flags-notion s4's render dropped its owned headline; flags-on-rappi s3's copy
leaf duplicated the hero-owned stat + chips into its own box — both verified in
the measured element walk). Excluding those two: mean |height error| ≈ 10%,
worst ≈ 19% (pinned by \`predict-ink.test.ts\`). Scoring the DECLARED box as if
it were ink errs by the full over-declaration (mean ≈ +${declaredAsInkErrPct}% on the same
pieces), so even an imperfect predictor is ~3–4× closer to the truth than
box-space scoring.
`;
writeFileSync(join(ROOT, "ALLOCATOR_INK_RESCORE.md"), md);
console.log(`wrote ${join(ROOT, "ALLOCATOR_INK_RESCORE.md")}`);
