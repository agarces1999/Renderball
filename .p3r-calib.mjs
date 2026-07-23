// ../../../private/tmp/claude-501/-Users-alfonsogarces-VIDEO-GEN/8e5a1e8e-9206-4aec-b903-15b4bf81622b/scratchpad/void-calib.ts
import { readdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import sharp from "sharp";

// lib/agents/choreograph.ts
var CHOREO_KEYFRAMES = `
@keyframes choreoFadeRise { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
@keyframes choreoScaleIn { 0% { opacity: 0; transform: scale(0.85); } 60% { opacity: 1; transform: scale(1.04); } 100% { opacity: 1; transform: scale(1); } }
@keyframes choreoFadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes choreoAmbient { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.006); } }
@keyframes choreoBreathe { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.02); } }
@keyframes choreoExitUp { to { opacity: 0; transform: translateY(-14px); } }`.trim();
var throughlineAnchorFor = (aspect2) => {
  if (aspect2 === "9:16") return { left: 540, top: 1280 };
  if (aspect2 === "1:1") return { left: 620, top: 600 };
  return { left: 1360, top: 540 };
};

// lib/agents/layout-composer.ts
var CANVAS = {
  "16:9": { w: 1920, h: 1080 },
  "9:16": { w: 1080, h: 1920 },
  "1:1": { w: 1080, h: 1080 }
};
var SPLIT_HERO_MIN_W_FRAC = 0.3;
var SPLIT_HERO_VCENTER_FRAC = 0.25;
var THROUGHLINE_SIZE = 200;
var BOTTOM_SAFE_FRAC = 0.965;
var COPY_FIELDS = ["eyebrow", "headline", "lede", "bullets", "caption", "meta", "cta", "texts"];
var VISUAL_FIELDS = ["illustration", "asset_ids"];
var isPresent = (v) => {
  if (v === null || v === void 0) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
};
var presentOf = (content, fields) => fields.filter((f) => isPresent(content?.[f]));
var REGISTERS = ["stat", "quote", "full-bleed", "split", "list", "centered"];
var normalizeRegister = (r) => REGISTERS.includes(r ?? "") ? r : "centered";
var GEOMETRY = {
  centered: {
    "16:9": { copy: { x: 360, y: 160, w: 960, h: 480 }, hero: { x: 560, y: 700, w: 800, h: 280 } },
    "9:16": { copy: { x: 90, y: 260, w: 900, h: 800 }, hero: { x: 190, y: 1160, w: 700, h: 600 } },
    "1:1": { copy: { x: 140, y: 160, w: 800, h: 400 }, hero: { x: 240, y: 620, w: 600, h: 340 } }
  },
  stat: {
    // Hero cy = H/2 exactly — a stat's support viz reads as a peer column.
    "16:9": { copy: { x: 120, y: 280, w: 780, h: 520 }, hero: { x: 1020, y: 280, w: 780, h: 520 } },
    "9:16": { copy: { x: 90, y: 260, w: 900, h: 640 }, hero: { x: 190, y: 1e3, w: 700, h: 700 } },
    "1:1": { copy: { x: 100, y: 160, w: 880, h: 360 }, hero: { x: 240, y: 580, w: 600, h: 380 } }
  },
  quote: {
    // Copy sits HIGH (ends above the throughline band at every aspect) so the
    // pull-quote never collides with the motif. Hero is emitted only when the
    // scene carries visual fields (see composeSceneLayout).
    "16:9": { copy: { x: 260, y: 180, w: 1400, h: 340 }, hero: { x: 360, y: 600, w: 800, h: 240 } },
    "9:16": { copy: { x: 90, y: 400, w: 900, h: 600 }, hero: { x: 240, y: 1080, w: 600, h: 180 } },
    "1:1": { copy: { x: 120, y: 180, w: 840, h: 380 }, hero: { x: 240, y: 640, w: 600, h: 280 } }
  },
  "full-bleed": {
    // Hero = the whole canvas (100% ≥ the gate's 85% "canvas treatment"
    // threshold, so findStrandedHero's split/corner rules don't apply). The
    // copy rect is the overlaid text block — overlap is DECLARED by the hero.
    "16:9": { copy: { x: 120, y: 560, w: 900, h: 380 }, hero: { x: 0, y: 0, w: 1920, h: 1080 } },
    "9:16": { copy: { x: 80, y: 360, w: 920, h: 800 }, hero: { x: 0, y: 0, w: 1080, h: 1920 } },
    "1:1": { copy: { x: 80, y: 560, w: 520, h: 380 }, hero: { x: 0, y: 0, w: 1080, h: 1080 } }
  },
  split: {
    // THE GATE CONTRACT, solved forward (constants above):
    //   16:9 hero w=768 = 0.40·1920 ≥ 0.30·1920=576; cy = 220+320 = 540 = H/2;
    //        hero centroid x=1440 (right half) vs copy centroid x=480 (left).
    //   9:16 hero w=450 ≥ 0.30·1080=324; cy = 610+350 = 960 = H/2;
    //        centroids 795 vs 285 — opposite halves of 540.
    //   1:1  hero w=440 ≥ 324; cy = 260+280 = 540 = H/2; centroids 780 vs 290.
    "16:9": { copy: { x: 120, y: 240, w: 720, h: 600 }, hero: { x: 1056, y: 220, w: 768, h: 640 } },
    "9:16": { copy: { x: 60, y: 460, w: 450, h: 1e3 }, hero: { x: 570, y: 610, w: 450, h: 700 } },
    "1:1": { copy: { x: 80, y: 260, w: 420, h: 560 }, hero: { x: 560, y: 260, w: 440, h: 560 } }
  },
  list: {
    "16:9": { copy: { x: 120, y: 140, w: 780, h: 800 }, hero: { x: 1020, y: 270, w: 780, h: 540 } },
    "9:16": { copy: { x: 90, y: 200, w: 900, h: 920 }, hero: { x: 240, y: 1180, w: 600, h: 600 } },
    "1:1": { copy: { x: 80, y: 140, w: 480, h: 800 }, hero: { x: 620, y: 300, w: 380, h: 480 } }
  }
};
var chromeRect = (aspect2) => {
  const { w, h } = CANVAS[aspect2];
  const barH = aspect2 === "9:16" ? 80 : 72;
  return { x: 0, y: h - barH, w, h: barH };
};
var rectsOverlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
var assertPlanInvariants = (plan, aspect2, content) => {
  const { w: W, h: H } = CANVAS[aspect2];
  const els = plan.elements;
  for (const el of els) {
    const { x, y, w, h } = el.bounds;
    if (w <= 0 || h <= 0 || x < 0 || y < 0 || x + w > W || y + h > H) {
      throw new Error(`layout-composer: "${el.id}" bounds ${JSON.stringify(el.bounds)} escape the ${W}\xD7${H} canvas`);
    }
  }
  for (const el of els) {
    if (el.kind === "atmosphere" || el.kind === "chrome") continue;
    const { w, h, y } = el.bounds;
    if (w >= W && h >= H) continue;
    if (y + h > BOTTOM_SAFE_FRAC * H) {
      throw new Error(
        `layout-composer: "${el.id}" bottom edge ${y + h} crosses the bottom reserve (${Math.floor(BOTTOM_SAFE_FRAC * H)} = ${BOTTOM_SAFE_FRAC}\xB7${H}) \u2014 content slots keep a reserved bottom margin`
      );
    }
  }
  for (let i = 0; i < els.length; i++) {
    for (let j = i + 1; j < els.length; j++) {
      const a = els[i];
      const b = els[j];
      if (!rectsOverlap(a.bounds, b.bounds)) continue;
      const declared = a.allowedOverlaps.includes(b.id) || b.allowedOverlaps.includes(a.id);
      if (!declared) {
        throw new Error(`layout-composer: UNDECLARED overlap between "${a.id}" and "${b.id}" (${plan.register}@${aspect2})`);
      }
    }
  }
  if (plan.register === "split") {
    const hero = els.find((e) => e.id === "hero");
    const copy = els.find((e) => e.id === "copy");
    if (!hero || !copy) throw new Error("layout-composer: split plan must carry hero + copy");
    if (hero.bounds.w < SPLIT_HERO_MIN_W_FRAC * W) {
      throw new Error(`layout-composer: split hero w=${hero.bounds.w} < ${SPLIT_HERO_MIN_W_FRAC * W}`);
    }
    const heroCy = hero.bounds.y + hero.bounds.h / 2;
    if (Math.abs(heroCy - H / 2) > SPLIT_HERO_VCENTER_FRAC * H) {
      throw new Error(`layout-composer: split hero cy=${heroCy} outside the \xB1${SPLIT_HERO_VCENTER_FRAC * H}px band`);
    }
    const heroOff = hero.bounds.x + hero.bounds.w / 2 - W / 2;
    const copyOff = copy.bounds.x + copy.bounds.w / 2 - W / 2;
    if (heroOff * copyOff >= 0) {
      throw new Error("layout-composer: split hero and copy centroids must sit on OPPOSITE horizontal halves");
    }
  }
  const present = presentOf(content, [...COPY_FIELDS, ...VISUAL_FIELDS]);
  const owners = /* @__PURE__ */ new Map();
  for (const el of els) {
    for (const f of el.contentFields) owners.set(f, [...owners.get(f) ?? [], el.id]);
  }
  for (const f of present) {
    const who = owners.get(f) ?? [];
    if (who.length !== 1) {
      throw new Error(`layout-composer: content field "${f}" owned by [${who.join(", ")}] \u2014 must be exactly one element`);
    }
  }
};
var isFullBleedRect = (b, W, H) => b.w * b.h >= 0.85 * W * H;
var clampBounds = (b, W, H) => {
  let { x, y, w, h } = b;
  w = Math.max(1, Math.min(w, W));
  h = Math.max(1, Math.min(h, H));
  x = Math.max(0, Math.min(x, W - w));
  y = Math.max(0, Math.min(y, H - h));
  return { x, y, w, h };
};
var headBoundsFor = (composition, role, z, W, H) => {
  const b = composition?.elements?.find((e) => e.role === role)?.bounds;
  if (!b) return null;
  const ok = [b.x, b.y, b.w, b.h].every((n) => typeof n === "number" && Number.isFinite(n)) && b.w > 0 && b.h > 0;
  if (!ok) return null;
  return { ...clampBounds(b, W, H), z };
};
var readHeadBounds = (composition, role, aspect2) => {
  const { w: W, h: H } = CANVAS[aspect2];
  const b = headBoundsFor(composition, role, 0, W, H);
  return b ? { x: b.x, y: b.y, w: b.w, h: b.h } : null;
};
var validateScenePlan = (plan, aspect2, opts) => {
  const { w: W, h: H } = CANVAS[aspect2];
  const out = [];
  const els = plan.elements;
  for (const el of els) {
    if (el.kind === "atmosphere" || el.kind === "chrome") continue;
    const { x, y, w, h } = el.bounds;
    if (w >= W && h >= H) continue;
    if (x < 0 || y < 0 || x + w > W || y + h > H) {
      out.push({ pieceId: el.id, kind: "containment", message: `"${el.id}" bounds ${JSON.stringify({ x, y, w, h })} escape the ${W}\xD7${H} canvas \u2014 keep it fully on-canvas.` });
    } else if (y + h > BOTTOM_SAFE_FRAC * H) {
      out.push({ pieceId: el.id, kind: "containment", message: `"${el.id}" bottom edge ${y + h} crosses the bottom reserve (${Math.floor(BOTTOM_SAFE_FRAC * H)}px) \u2014 lift it into the safe frame.` });
    }
  }
  for (let i = 0; i < els.length; i++) {
    for (let j = i + 1; j < els.length; j++) {
      const a = els[i];
      const b = els[j];
      if (a.kind === "atmosphere" || b.kind === "atmosphere") continue;
      if (!rectsOverlap(a.bounds, b.bounds)) continue;
      if (a.allowedOverlaps.includes(b.id) || b.allowedOverlaps.includes(a.id)) continue;
      if (isFullBleedRect(a.bounds, W, H) || isFullBleedRect(b.bounds, W, H)) continue;
      out.push({ pieceId: b.id, kind: "disjointness", message: `"${a.id}" and "${b.id}" bounds overlap with no declared allowance \u2014 content elements must sit in disjoint territory.` });
    }
  }
  if (plan.register === "split") {
    const hero = els.find((e) => e.id === "hero");
    const copy = els.find((e) => e.id === "copy");
    if (hero && copy) {
      if (hero.bounds.w < SPLIT_HERO_MIN_W_FRAC * W) {
        out.push({ pieceId: "hero", kind: "stranded-hero", message: `split hero w=${hero.bounds.w} < ${Math.round(SPLIT_HERO_MIN_W_FRAC * W)} \u2014 the hero must command \u2265${Math.round(SPLIT_HERO_MIN_W_FRAC * 100)}% of the frame width.` });
      }
      const heroCy = hero.bounds.y + hero.bounds.h / 2;
      if (Math.abs(heroCy - H / 2) > SPLIT_HERO_VCENTER_FRAC * H) {
        out.push({ pieceId: "hero", kind: "stranded-hero", message: `split hero cy=${heroCy} is not vertically centered (\xB1${Math.round(SPLIT_HERO_VCENTER_FRAC * H)}px of ${H / 2}).` });
      }
    }
  }
  const budget = opts?.composition?.budget;
  if (budget) {
    const ids = new Set(els.map((e) => e.id));
    const ownerOk = (v) => typeof v === "string" && (v === "chrome" || v === "none" || ids.has(v));
    if (!ownerOk(budget.brandMark)) out.push({ pieceId: "chrome", kind: "budget", message: `budget.brandMark "${String(budget.brandMark)}" names no element in the plan \u2014 one element owns the single brand mark.` });
    if (!ownerOk(budget.cta)) out.push({ pieceId: "copy", kind: "budget", message: `budget.cta "${String(budget.cta)}" names no element in the plan \u2014 one element owns the single CTA.` });
  }
  return out;
};
var composeSceneLayout = (scene, aspect2, opts) => {
  const register = normalizeRegister(scene.register);
  const { w: W, h: H } = CANVAS[aspect2];
  const geo = GEOMETRY[register][aspect2];
  const composition = scene.composition;
  const copyFields = presentOf(scene.content, COPY_FIELDS);
  const visualFields = presentOf(scene.content, VISUAL_FIELDS);
  const wantsHero = register === "quote" ? visualFields.length > 0 : geo.hero !== null;
  const isCanvasTreatment = register === "full-bleed";
  let heroHead = wantsHero && geo.hero ? headBoundsFor(composition, "hero", 1, W, H) : null;
  let copyHead = headBoundsFor(composition, "copy", 2, W, H);
  if (heroHead && copyHead && !isCanvasTreatment && !isFullBleedRect(heroHead, W, H) && rectsOverlap(heroHead, copyHead)) {
    heroHead = null;
    copyHead = null;
  }
  const usedHeadBounds = !!(heroHead || copyHead);
  const elements = [];
  elements.push({
    id: "atmosphere",
    kind: "atmosphere",
    bounds: { x: 0, y: 0, w: W, h: H, z: 0 },
    contentFields: [],
    // Glow/grain may carry accent at low alpha — the declared accent surface.
    paletteRoles: ["canvas", "accent"],
    // The base layer declares nothing; every other slot declares IT (symmetric).
    allowedOverlaps: []
  });
  if (wantsHero && geo.hero) {
    const heroIsFullBleed = isCanvasTreatment || (heroHead ? isFullBleedRect(heroHead, W, H) : false);
    elements.push({
      id: "hero",
      kind: "diegetic",
      bounds: heroHead ?? { ...geo.hero, z: 1 },
      contentFields: visualFields,
      // Diegetic UI: surfaces + hairlines + ink, accent for the data moments.
      paletteRoles: ["panelBg", "hairline", "ink", "accent"],
      allowedOverlaps: heroIsFullBleed ? ["atmosphere", "copy", "chrome", "throughline"] : ["atmosphere"]
    });
  }
  elements.push({
    id: "copy",
    kind: "text",
    // z2 keeps overlaid copy above a full-bleed hero; harmless elsewhere
    // (copy is disjoint from everything else by table construction).
    bounds: copyHead ?? { ...geo.copy, z: 2 },
    contentFields: copyFields,
    // Accent only where the register declares emphasis: the stat metric and
    // the quote's highlighted line. Everything else sets copy in pure ink.
    paletteRoles: register === "stat" || register === "quote" ? ["ink", "accent"] : ["ink"],
    allowedOverlaps: ["atmosphere"]
  });
  if (opts?.hasThroughline) {
    const anchor = throughlineAnchorFor(aspect2);
    elements.push({
      id: "throughline",
      kind: "diegetic",
      // Pinned EXACTLY to the choreographer's anchor (16:9 → 1360,540) so the
      // cross-scene drift gate (SEVERE_DRIFT_PX) passes by construction.
      bounds: { x: anchor.left, y: anchor.top, w: THROUGHLINE_SIZE, h: THROUGHLINE_SIZE, z: 2 },
      contentFields: [],
      // The motif IS the accent thread — its one palette role.
      paletteRoles: ["accent"],
      // May sit over the hero (visual-on-visual, declared) — never over copy
      // or chrome; the geometry tables keep those rects clear of the anchor box.
      allowedOverlaps: ["atmosphere", "hero"]
    });
  }
  elements.push({
    id: "chrome",
    kind: "chrome",
    bounds: { ...chromeRect(aspect2), z: 3 },
    contentFields: [],
    paletteRoles: ["ink"],
    allowedOverlaps: ["atmosphere"]
  });
  const plan = { register, elements };
  if (!usedHeadBounds) {
    assertPlanInvariants(plan, aspect2, scene.content);
  }
  return plan;
};

// lib/agents/plan-validate.ts
var MIN_LEGIBLE_W_FRAC = 0.14;
var MIN_LEGIBLE_H_FRAC = 0.11;
var GUTTER_FRAC = 0.0125;
var MAX_REPAIR_PASSES = 3;
var HEAD_OWNED_ROLES = /* @__PURE__ */ new Set(["hero", "copy"]);
var GEOMETRY_KINDS = /* @__PURE__ */ new Set(["containment", "disjointness", "stranded-hero"]);
var rectsOverlap2 = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
var area = (r) => Math.max(0, r.w) * Math.max(0, r.h);
var sameRect = (a, b) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
var isLegible = (r, W, H) => r.w >= MIN_LEGIBLE_W_FRAC * W && r.h >= MIN_LEGIBLE_H_FRAC * H;
var isFullBleedRect2 = (r, W, H) => r.w * r.h >= 0.85 * W * H;
var clampIntoSafe = (r, W, H, bottomLimit) => {
  const bottom = Math.min(Math.floor(BOTTOM_SAFE_FRAC * H), bottomLimit ?? Infinity);
  const w = Math.max(1, Math.min(r.w, W));
  const h = Math.max(1, Math.min(r.h, bottom));
  const x = Math.max(0, Math.min(Math.round(r.x), W - w));
  const y = Math.max(0, Math.min(Math.round(r.y), bottom - h));
  return { x, y, w, h };
};
var safeBottomOf = (plan) => plan.elements.find((e) => e.kind === "chrome")?.bounds.y;
var shrinkOut = (victim, keeper, gutter) => {
  const candidates = [
    { x: victim.x, y: victim.y, w: keeper.x - gutter - victim.x, h: victim.h },
    { x: keeper.x + keeper.w + gutter, y: victim.y, w: victim.x + victim.w - (keeper.x + keeper.w + gutter), h: victim.h },
    { x: victim.x, y: victim.y, w: victim.w, h: keeper.y - gutter - victim.y },
    { x: victim.x, y: keeper.y + keeper.h + gutter, w: victim.w, h: victim.y + victim.h - (keeper.y + keeper.h + gutter) }
  ].map((c) => ({ x: Math.round(c.x), y: Math.round(c.y), w: Math.round(c.w), h: Math.round(c.h) })).filter((c) => c.w > 0 && c.h > 0 && !rectsOverlap2(c, keeper));
  if (candidates.length === 0) return null;
  return candidates.reduce((best, c) => area(c) > area(best) ? c : best);
};
var elementsOf = (comp) => comp && Array.isArray(comp.elements) ? comp.elements : [];
var specFor = (comp, role) => elementsOf(comp).find((e) => e?.role === role);
var focalRankOf = (comp, role) => {
  const r = Number(specFor(comp, role)?.focalRank);
  return Number.isFinite(r) && r > 0 ? r : 99;
};
var writeBounds = (comp, role, rect) => {
  const spec = specFor(comp, role);
  if (!spec) return false;
  spec.bounds = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
  return true;
};
var netFiredViolations = (comp, register, aspect2) => {
  if (register === "full-bleed") return [];
  const { w: W, h: H } = CANVAS[aspect2];
  const hero = readHeadBounds(comp, "hero", aspect2);
  const copy = readHeadBounds(comp, "copy", aspect2);
  if (!hero || !copy) return [];
  if (isFullBleedRect2(hero, W, H)) return [];
  if (!rectsOverlap2(hero, copy)) return [];
  return [
    {
      pieceId: "copy",
      kind: "disjointness",
      message: `"hero" and "copy" bounds overlap with no declared allowance \u2014 content elements must sit in disjoint territory.`
    }
  ];
};
var overlapPartner = (plan, pieceId) => {
  const self = plan.elements.find((e) => e.id === pieceId);
  if (!self) return null;
  for (const other of plan.elements) {
    if (other.id === pieceId) continue;
    if (self.kind === "atmosphere" || other.kind === "atmosphere") continue;
    if (!rectsOverlap2(self.bounds, other.bounds)) continue;
    if (self.allowedOverlaps.includes(other.id) || other.allowedOverlaps.includes(self.id)) continue;
    return other.id;
  }
  return null;
};
var rectFor = (plan, comp, id, aspect2) => {
  if (HEAD_OWNED_ROLES.has(id)) {
    const head = readHeadBounds(comp, id, aspect2);
    if (head) return head;
  }
  const slot = plan.elements.find((e) => e.id === id);
  return slot ? { x: slot.bounds.x, y: slot.bounds.y, w: slot.bounds.w, h: slot.bounds.h } : null;
};
var applyLadder = (violations, plan, comp, aspect2, sceneIndex, events) => {
  const { w: W, h: H } = CANVAS[aspect2];
  const gutter = Math.round(GUTTER_FRAC * Math.min(W, H));
  const bottomLimit = safeBottomOf(plan);
  const out = { repaired: false, blocked: [] };
  const rungOrder = (v) => v.kind === "containment" ? 0 : v.kind === "disjointness" ? 1 : 2;
  const ordered = [...violations].sort(
    (a, b) => rungOrder(a) - rungOrder(b) || focalRankOf(comp, b.pieceId) - focalRankOf(comp, a.pieceId)
  );
  for (const v of ordered) {
    if (v.kind === "stranded-hero" || v.kind === "budget") {
      out.blocked.push({
        violation: v,
        detail: v.pieceId,
        reason: v.kind === "budget" ? "budget ownership is the head's to assign" : "growing a hero would invent composition"
      });
      continue;
    }
    if (v.kind === "containment") {
      const role = v.pieceId;
      if (!HEAD_OWNED_ROLES.has(role)) {
        out.blocked.push({ violation: v, detail: role, reason: `"${role}" is a deterministic slot, not head-authored` });
        continue;
      }
      const cur = readHeadBounds(comp, role, aspect2);
      if (!cur) {
        out.blocked.push({ violation: v, detail: role, reason: `"${role}" carries no head bounds to clamp` });
        continue;
      }
      const fixed2 = clampIntoSafe(cur, W, H, bottomLimit);
      if (sameRect(fixed2, cur)) continue;
      if (!isLegible(fixed2, W, H)) {
        out.blocked.push({
          violation: v,
          detail: role,
          reason: `clamping "${role}" to the safe area leaves ${fixed2.w}\xD7${fixed2.h}px, below the ${Math.round(MIN_LEGIBLE_W_FRAC * W)}\xD7${Math.round(MIN_LEGIBLE_H_FRAC * H)}px legible floor`
        });
        continue;
      }
      if (!writeBounds(comp, role, fixed2)) {
        out.blocked.push({ violation: v, detail: role, reason: `"${role}" has no composition element to write back to` });
        continue;
      }
      out.repaired = true;
      events.push({ scene: sceneIndex, kind: "containment", detail: role, outcome: "repaired" });
      continue;
    }
    const partner = overlapPartner(plan, v.pieceId);
    let pair = partner ? [v.pieceId, partner] : null;
    if (!pair) {
      const hero = readHeadBounds(comp, "hero", aspect2);
      const copy = readHeadBounds(comp, "copy", aspect2);
      if (hero && copy && rectsOverlap2(hero, copy)) pair = ["hero", "copy"];
    }
    if (!pair) {
      out.blocked.push({ violation: v, detail: v.pieceId, reason: "could not resolve the colliding pair" });
      continue;
    }
    const detail = pair.join(",");
    const movable = pair.filter((id) => HEAD_OWNED_ROLES.has(id) && readHeadBounds(comp, id, aspect2)).sort((a, b) => {
      const dr = focalRankOf(comp, b) - focalRankOf(comp, a);
      if (dr !== 0) return dr;
      return area(readHeadBounds(comp, a, aspect2)) - area(readHeadBounds(comp, b, aspect2));
    });
    if (movable.length === 0) {
      out.blocked.push({ violation: v, detail, reason: "neither element is head-authored \u2014 nothing to move" });
      continue;
    }
    const victimId = movable[0];
    const keeperId = pair[0] === victimId ? pair[1] : pair[0];
    const victim = readHeadBounds(comp, victimId, aspect2);
    const keeper = rectFor(plan, comp, keeperId, aspect2);
    if (!keeper) {
      out.blocked.push({ violation: v, detail, reason: `no rect for "${keeperId}"` });
      continue;
    }
    if (!rectsOverlap2(victim, keeper)) continue;
    const withGutter = shrinkOut(victim, keeper, gutter);
    const flush = shrinkOut(victim, keeper, 0);
    const candidate = withGutter && isLegible(clampIntoSafe(withGutter, W, H, bottomLimit), W, H) ? withGutter : flush;
    if (!candidate) {
      out.blocked.push({
        violation: v,
        detail,
        reason: `"${keeperId}" leaves no clear territory for "${victimId}" \u2014 the boxes are nested, not merely adjacent`
      });
      continue;
    }
    const fixed = clampIntoSafe(candidate, W, H, bottomLimit);
    if (!isLegible(fixed, W, H)) {
      out.blocked.push({
        violation: v,
        detail,
        reason: `shrinking "${victimId}" clear of "${keeperId}" leaves ${fixed.w}\xD7${fixed.h}px, below the ${Math.round(MIN_LEGIBLE_W_FRAC * W)}\xD7${Math.round(MIN_LEGIBLE_H_FRAC * H)}px legible floor`
      });
      continue;
    }
    if (rectsOverlap2(fixed, keeper) || sameRect(fixed, victim) || !writeBounds(comp, victimId, fixed)) {
      out.blocked.push({ violation: v, detail, reason: `shrinking "${victimId}" made no progress` });
      continue;
    }
    out.repaired = true;
    events.push({ scene: sceneIndex, kind: "disjointness", detail, outcome: "repaired" });
  }
  return out;
};
var runScene = (scene, index, opts, errors, events) => {
  const comp = scene?.composition;
  if (!comp || typeof comp !== "object" || elementsOf(comp).length === 0) return;
  const { aspect: aspect2 } = opts;
  const content = scene.content ?? {};
  let residual = [];
  let blocked = [];
  for (let pass = 0; pass <= MAX_REPAIR_PASSES; pass++) {
    const plan = composeSceneLayout(
      { register: scene.register, content, composition: comp },
      aspect2,
      { hasThroughline: opts.hasThroughline }
    );
    residual = [
      ...netFiredViolations(comp, scene.register, aspect2),
      ...validateScenePlan(plan, aspect2, { composition: comp, content })
    ];
    if (residual.length === 0) return;
    if (pass === MAX_REPAIR_PASSES) {
      blocked = residual.map((violation) => ({ violation, detail: violation.pieceId, reason: `unresolved after ${MAX_REPAIR_PASSES} repair passes` }));
      break;
    }
    const outcome = applyLadder(residual, plan, comp, aspect2, index, events);
    blocked = outcome.blocked;
    if (!outcome.repaired) break;
  }
  const seen = /* @__PURE__ */ new Set();
  for (const v of residual) {
    if (seen.has(v.message)) continue;
    seen.add(v.message);
    const why = blocked.find((b) => b.violation.message === v.message);
    errors.push(`Scene ${index}: ${v.message}`);
    events.push({
      scene: index,
      kind: v.kind,
      detail: why?.detail ?? v.pieceId,
      outcome: "escalated",
      reason: why?.reason
    });
    if (why) {
      console.warn(`[plan-validate] s${index} ${v.kind}(${why.detail}) NOT repairable \u2014 ${why.reason}`);
    }
  }
  if (opts.terminal && residual.some((v) => GEOMETRY_KINDS.has(v.kind))) {
    let dropped = false;
    for (const role of HEAD_OWNED_ROLES) {
      const spec = specFor(comp, role);
      if (spec?.bounds) {
        delete spec.bounds;
        dropped = true;
      }
    }
    if (dropped) {
      events.push({ scene: index, kind: "containment", detail: "hero,copy", outcome: "fallback", reason: "reverted to the deterministic geometry table" });
      console.warn(`[plan-validate] s${index} head bounds DROPPED \u2014 falling back to the deterministic ${scene.register ?? "centered"} geometry table`);
    }
  }
};
var summarize = (events) => {
  const acted = events.filter((e) => e.outcome !== "fallback");
  if (acted.length === 0) return "plan-validate: 0 violation(s)";
  const repaired = acted.filter((e) => e.outcome === "repaired").length;
  const escalated = acted.filter((e) => e.outcome === "escalated").length;
  const fallbacks = events.filter((e) => e.outcome === "fallback").length;
  const list = acted.map((e) => `s${e.scene}:${e.kind}(${e.detail})`).join(", ");
  return [
    `plan-validate: ${acted.length} violation(s) [${list}]`,
    `${repaired} repaired`,
    `${escalated} escalated`,
    ...fallbacks > 0 ? [`${fallbacks} table-fallback`] : []
  ].join(" \xB7 ");
};
var validateAndRepairPlans = (scenes, opts) => {
  const errors = [];
  const events = [];
  scenes.forEach((scene, i) => runScene(scene, i, opts, errors, events));
  return { errors, events, summary: summarize(events) };
};

// lib/agents/void-metric.ts
var SAFE = {
  "16:9": { x: 96, y: 54, w: 1728, h: 972 },
  "9:16": { x: 54, y: 96, w: 972, h: 1728 },
  "1:1": { x: 54, y: 54, w: 972, h: 972 }
};
var CELL = 54;
var GRID = {
  "16:9": { cols: 32, rows: 18 },
  "9:16": { cols: 18, rows: 32 },
  "1:1": { cols: 18, rows: 18 }
};
var largestVoidCells = (occupied, cols, rows2, outRect) => {
  const heights = new Array(cols).fill(0);
  let best = 0;
  for (let r = 0; r < rows2; r++) {
    for (let c = 0; c < cols; c++) {
      heights[c] = occupied[r][c] ? 0 : heights[c] + 1;
    }
    const stack = [];
    for (let i = 0; i <= cols; i++) {
      const h = i === cols ? 0 : heights[i];
      while (stack.length > 0 && heights[stack[stack.length - 1]] >= h) {
        const top = stack.pop();
        const left = stack.length === 0 ? -1 : stack[stack.length - 1];
        const height = heights[top];
        const width = i - left - 1;
        const areaCells = height * width;
        if (areaCells > best) {
          best = areaCells;
          if (outRect) {
            outRect.c0 = left + 1;
            outRect.c1 = i - 1;
            outRect.r0 = r - height + 1;
            outRect.r1 = r;
          }
        }
      }
      stack.push(i);
    }
  }
  return best;
};
var measureVoid = (rects, aspect2) => {
  const { cols, rows: rows2 } = GRID[aspect2];
  const safe = SAFE[aspect2];
  const occupied = Array.from({ length: rows2 }, () => new Array(cols).fill(false));
  for (let r = 0; r < rows2; r++) {
    const cy = safe.y + r * CELL + CELL / 2;
    for (let c = 0; c < cols; c++) {
      const cx = safe.x + c * CELL + CELL / 2;
      for (const rect of rects) {
        if (cx >= rect.x && cx < rect.x + rect.w && cy >= rect.y && cy < rect.y + rect.h) {
          occupied[r][c] = true;
          break;
        }
      }
    }
  }
  const box = { c0: 0, r0: 0, c1: -1, r1: -1 };
  const cells = largestVoidCells(occupied, cols, rows2, box);
  const cw = box.c1 - box.c0 + 1;
  const ch = box.r1 - box.r0 + 1;
  return {
    fraction: cells / (cols * rows2),
    rect: cells > 0 ? { x: safe.x + box.c0 * CELL, y: safe.y + box.r0 * CELL, w: cw * CELL, h: ch * CELL } : { x: 0, y: 0, w: 0, h: 0 },
    cells: cells > 0 ? { cols: cw, rows: ch } : { cols: 0, rows: 0 }
  };
};

// ../../../private/tmp/claude-501/-Users-alfonsogarces-VIDEO-GEN/8e5a1e8e-9206-4aec-b903-15b4bf81622b/scratchpad/void-calib.ts
var ROOT = "/Users/alfonsogarces/VIDEO_GEN/.data/dogfood";
var aspect = "16:9";
var WITH_PIXELS = process.argv.includes("--pixels");
var INK_SD = 30;
var paintedVoid = async (png) => {
  try {
    const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
    const { cols, rows: rows2 } = GRID[aspect];
    const safe = SAFE[aspect];
    const sx = info.width / 1920;
    const sy = info.height / 1080;
    const occupied = Array.from({ length: rows2 }, () => new Array(cols).fill(false));
    for (let r = 0; r < rows2; r++) {
      for (let c = 0; c < cols; c++) {
        const x0 = Math.round((safe.x + c * CELL) * sx);
        const y0 = Math.round((safe.y + r * CELL) * sy);
        const x1 = Math.min(info.width, Math.round((safe.x + (c + 1) * CELL) * sx));
        const y1 = Math.min(info.height, Math.round((safe.y + (r + 1) * CELL) * sy));
        let n = 0, sum = 0, sum2 = 0;
        for (let y = y0; y < y1; y += 2) {
          for (let x = x0; x < x1; x += 2) {
            const v = data[y * info.width + x];
            n++;
            sum += v;
            sum2 += v * v;
          }
        }
        if (n === 0) continue;
        const mean = sum / n;
        const sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
        occupied[r][c] = sd > INK_SD;
      }
    }
    const box = { c0: 0, r0: 0, c1: -1, r1: -1 };
    const cells = largestVoidCells(occupied, cols, rows2, box);
    return { fraction: cells / (cols * rows2), cells: `${box.c1 - box.c0 + 1}x${box.r1 - box.r0 + 1}` };
  } catch {
    return null;
  }
};
var rows = [];
for (const dir of readdirSync(ROOT)) {
  const compPath = join(ROOT, dir, "composition.json");
  const scriptPath = join(ROOT, dir, "script.generated.json");
  if (!existsSync(compPath) || !existsSync(scriptPath)) continue;
  const comps = JSON.parse(readFileSync(compPath, "utf8"));
  const script = JSON.parse(readFileSync(scriptPath, "utf8"));
  const hasThroughline = !!script.narrative?.throughline;
  const scenes = script.scenes.map((s, i) => ({
    ...s,
    composition: comps[String(i)] ? JSON.parse(JSON.stringify(comps[String(i)].composition)) : void 0
  }));
  validateAndRepairPlans(scenes, { aspect, hasThroughline });
  for (let i = 0; i < scenes.length; i++) {
    if (!comps[String(i)]) continue;
    const scene = scenes[i];
    const plan = composeSceneLayout(
      { register: scene.register, content: scene.content ?? {}, composition: scene.composition },
      aspect,
      { hasThroughline }
    );
    const claimed = plan.elements.filter((e) => e.kind !== "atmosphere").map((e) => ({ ...e.bounds }));
    const m = measureVoid(claimed, aspect);
    let painted = null;
    let paintedCells = "";
    const png = join(ROOT, dir, "frames", `scene${i}.png`);
    if (WITH_PIXELS && existsSync(png)) {
      const p = await paintedVoid(png);
      if (p) {
        painted = p.fraction;
        paintedCells = p.cells;
      }
    }
    rows.push({
      dir,
      scene: i,
      register: scene.register ?? "centered",
      frac: m.fraction,
      cells: `${m.cells.cols}x${m.cells.rows}`,
      rect: `${m.rect.x},${m.rect.y} ${m.rect.w}x${m.rect.h}`,
      minor: Math.min(m.cells.cols, m.cells.rows),
      painted,
      paintedCells
    });
  }
}
rows.sort((a, b) => b.frac - a.frac);
console.log("auth%	cells	minor	paint%	pcells	dir	s	register	rect");
for (const r of rows) {
  console.log(
    `${(r.frac * 100).toFixed(1)}	${r.cells}	${r.minor}	${r.painted === null ? "-" : (r.painted * 100).toFixed(1)}	${r.paintedCells || "-"}	${r.dir}	${r.scene}	${r.register}	${r.rect}`
  );
}
var fr = rows.map((r) => r.frac).sort((a, b) => a - b);
var q = (p) => fr[Math.floor(p * (fr.length - 1))];
console.log(`
N=${rows.length} scenes / ${new Set(rows.map((r) => r.dir)).size} builds`);
console.log(`min ${(fr[0] * 100).toFixed(1)}  p25 ${(q(0.25) * 100).toFixed(1)}  median ${(q(0.5) * 100).toFixed(1)}  p75 ${(q(0.75) * 100).toFixed(1)}  p90 ${(q(0.9) * 100).toFixed(1)}  max ${(fr[fr.length - 1] * 100).toFixed(1)}`);
var withPix = rows.filter((r) => r.painted !== null);
if (withPix.length > 0) {
  const under = withPix.filter((r) => r.frac <= r.painted + 1e-9).length;
  console.log(`
PIXEL TRUTH: ${withPix.length} frames measured.`);
  console.log(`authored \u2264 painted (the predicted one-sided direction) in ${under}/${withPix.length}`);
  const diffs = withPix.map((r) => r.painted - r.frac);
  console.log(`painted\u2212authored: min ${(Math.min(...diffs) * 100).toFixed(1)}  mean ${(diffs.reduce((a, b) => a + b, 0) / diffs.length * 100).toFixed(1)}  max ${(Math.max(...diffs) * 100).toFixed(1)}`);
  const n = withPix.length;
  const ma = withPix.reduce((s, r) => s + r.frac, 0) / n;
  const mp = withPix.reduce((s, r) => s + r.painted, 0) / n;
  const cov = withPix.reduce((s, r) => s + (r.frac - ma) * (r.painted - mp), 0);
  const sa = Math.sqrt(withPix.reduce((s, r) => s + (r.frac - ma) ** 2, 0));
  const sp = Math.sqrt(withPix.reduce((s, r) => s + (r.painted - mp) ** 2, 0));
  console.log(`Pearson r(authored, painted) = ${(cov / (sa * sp)).toFixed(3)}`);
  const rank = (vals) => {
    const idx = vals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const out = new Array(vals.length).fill(0);
    idx.forEach(([, i], k) => out[i] = k);
    return out;
  };
  const ra = rank(withPix.map((r) => r.frac));
  const rp = rank(withPix.map((r) => r.painted));
  const mra = ra.reduce((a, b) => a + b, 0) / n;
  const mrp = rp.reduce((a, b) => a + b, 0) / n;
  let c2 = 0, s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    c2 += (ra[i] - mra) * (rp[i] - mrp);
    s1 += (ra[i] - mra) ** 2;
    s2 += (rp[i] - mrp) ** 2;
  }
  console.log(`Spearman \u03C1(authored, painted) = ${(c2 / Math.sqrt(s1 * s2)).toFixed(3)}`);
}
