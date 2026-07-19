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
    const allocInput = {
      aspect,
      register: register ?? undefined,
      elements: ided.map((e) => {
        const owns = Array.isArray(e.ownsCopy) ? e.ownsCopy : [];
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

    scenes.push({
      build: dir,
      ix,
      aspect,
      register,
      frame,
      skipped: null,
      usedMeasured: !!measured,
      unplacedByHead: headScored.filter((e) => !e.bounds).map((e) => e.id),
      head: { elements: headScored, score: headScore },
      alloc: alloc ? { shape: alloc.shape, slots: alloc.slots, score: alloc.score, repicked: alloc.repicked, readingOrderKept: alloc.readingOrderKept } : null,
      repo: allocRepo ? { shape: allocRepo.shape, slots: allocRepo.slots, score: allocRepo.score, readingOrderKept: allocRepo.readingOrderKept } : null,
      allocError,
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
console.log(`\nshape re-picked (structural void): ${summary.repicked} scenes · both arms ran on ${summary.threeWay} placeable scenes`);
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

<h2>Structural preservation on the three controls</h2>
<p class="sub">The main way this experiment can produce a MISLEADING pass: eliminate voids and overlaps while scrambling
what the regions mean in sequence. Metrics cannot see that, so it is stated here in words, with the boxes.</p>
<table><thead><tr><th>control</th><th>head's structure</th><th>allocator's structure</th><th>verdict</th></tr></thead><tbody>
<tr><td>flags-notion s2<br><span class="muted">split</span></td>
<td>hero 920×920 left, copy 800×666 right; the throughline is a <b>130×34 status chip INSIDE the workspace card header</b>.</td>
<td>hero 950×807 left, copy 708×647 right — the asymmetric split and the reading order survive. But the motif becomes a
free-standing <b>200×200 badge in the top-right corner</b>, 8.9× its authored area.</td>
<td><b class="ok">MOSTLY PRESERVED</b> — the split survives; the embedded motif does not.</td></tr>
<tr><td>p3-cycle8-razorpay s2<br><span class="muted">full-bleed</span></td>
<td>a checkout modal <b>1080×920 floating dead-centre</b> (47.9% of frame) with the payment-button motif embedded inside
it and a whisper of copy, 320×200, in the lower-left corner.</td>
<td>hero becomes the <b>whole canvas</b>; copy becomes a <b>795×648 panel</b> — 8× its authored area — parked mid-left;
the motif becomes a floating 200×200 square.</td>
<td><b class="bad">DESTROYED</b> — "a modal floating in space" became "a full-bleed wash with a big text panel".</td></tr>
<tr><td>final-checkr s2<br><span class="muted">full-bleed</span></td>
<td>the dashboard is <b>inset 40px from every edge</b> (88.7%) — a single app shell sitting IN the frame; copy 720×180 in
the quiet lower-left margin; the motif is a <b>64×64 status ring inside the dashboard</b>.</td>
<td>the dashboard <b>bleeds to the edge</b> (the deliberate inset margin is gone); copy grows to 795×648, <b>3.2×</b>;
the status ring becomes a 200×200 floating badge.</td>
<td><b class="bad">DEGRADED</b> — the inset margin and the embedded ring were the composition.</td></tr>
</tbody></table>
<p class="sub"><b>The common failure across all three controls is the same two moves:</b> the allocator turns an
<b>embedded motif into a floating badge</b>, and it <b>inflates the copy panel far past its content</b>. Both fall
directly out of "size from role, not from the head's judgment" — and the second one is dangerous, because a box enlarged
without a matching capacity budget (<code>capacity.ts</code> / <code>describeCapacity</code>, P4b) yields a large box
with sparse content: the hollow-hero defect, strictly worse than the small-but-full box it replaced. This dry run does
not emit content and therefore cannot demonstrate that half — but any allocator that ships must emit a NEW capacity
budget with every resize.</p>

<p class="sub"><b>Read the numbers with these two caveats.</b> (1) The allocator's <b>0 overlaps</b> is a TAUTOLOGY, not a
result — disjointness is a construction invariant it asserts on every call, so the only informative overlap number is
the head's. Of the head's ${summary.overlaps.head} raw overlaps, only <b>${summary.overlaps.headEx}</b> survive once a
throughline motif fully embedded inside another element is treated as the deliberate layering the 2026-07-18 work showed
it to be. (2) Void and centroid are aggregated over the <b>${summary.placeable} placeable</b> scenes only.
<b>${summary.treatments}</b> scenes carry a canvas treatment (an element ≥85% of the frame); the scorer excludes those
rects, so those scenes are scored on their small overlaid insets alone and report enormous voids that are artefacts of
the instrument. <code>final-checkr s2</code> — a reference-grade frame — scores 55.6% void for exactly this reason.</p>

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
  JSON.stringify({ summary, shapeCounts, shapesByRegister: Object.fromEntries(Object.entries(shapesByRegister).map(([k, v]) => [k, [...v].sort()])), skipped }, null, 2),
);
