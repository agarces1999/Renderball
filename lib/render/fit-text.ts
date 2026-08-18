/**
 * Deterministic render-time text fit — the PowerPoint algorithm in our
 * renderer (docs/TEXT_FIT.md layer 1; founder adoption 2026-08-13).
 *
 * THE PROBLEM THIS OWNS. Generated scenes hard-code pixel font sizes into
 * absolutely-positioned boxes; when the model's guess is short — measured as
 * the engine's #1 and #2 blocking finding classes (overflow 19 fires,
 * cross-piece-overlap 22, the latter mostly spill from the former) — the text
 * walks out of its box, collides with neighbours, and feeds the repair
 * ladder. Every production system we researched computes fit
 * deterministically at render time instead of hoping the generator guessed
 * right; this module is that computation for every page we render.
 *
 * THE ALGORITHM (Microsoft patent US6256650, expired; PowerPoint autofit
 * semantics):
 *   fullness = required text height / box height
 *              (in DOM terms: scrollHeight / clientHeight)
 *   1. line-spacing reduction FIRST, capped at 20% — cheapest legibility
 *      spend, often enough on its own;
 *   2. then font scale, seeded by the patent's wrap-aware first guess:
 *      the no-rewrap bound (1/fullness), the full-rewrap bound
 *      (sqrt(1/fullness)), interpolated by how long the lines are — long
 *      lines re-wrap fully (sqrt bound is accurate), short lines barely
 *      re-wrap (linear bound is accurate). Converges in 1–3 probes where
 *      naive bisection needs ~8.
 *   3. a READABILITY FLOOR: never below 60% of authored size and never below
 *      11px. A box still overfull at the floor keeps the floor size and is
 *      MARKED (data-rb-fit-floor) — the honest signal for the semantic
 *      shorten path (docs/TEXT_FIT.md layer 3). The pass never hides
 *      content: no clipping, no truncation, and the measurement gates read
 *      post-fit geometry, so residual overflow is still their finding.
 *
 * WHERE IT RUNS — and the invariant that matters more than any of it: the
 * SAME script runs in every page builder. renderSceneDoc (editor iframe,
 * static export, share viewer) and measure-scene's buildSceneHtml (the
 * blocking gates) both inject FIT_TEXT_SCRIPT; the gates await
 * window.__rbFitDone before walking rects. One runtime, one result —
 * measuring an unfitted page while showing a fitted one (or the reverse) is
 * the measurement/render mismatch the research names as the failure mode
 * that quietly re-breaks every library-based approach.
 *
 * The video path (Remotion, shelved since the 2026-07-23 pivot) does NOT run
 * this script — decks are the wedge. If video un-shelves, the fit must move
 * into (or be mirrored by) the Remotion composition before any deck code
 * assumes fitted geometry there.
 *
 * RB_TEXT_FIT=off is the opt-out (page builders omit the script entirely);
 * default ON once the offline replay gate passed (scripts/replay-text-fit.mjs
 * over the stored builds — the allocator's precedent).
 */

const DISABLED = new Set(["off", "0", "false", "no"]);

/** Default ON; `RB_TEXT_FIT=off` opts out. Same shape as allocateEnabled. */
export const textFitEnabled = (
  env: Record<string, string | undefined> = process.env,
): boolean => !DISABLED.has(String(env.RB_TEXT_FIT ?? "").trim().toLowerCase());

/** Floor: never shrink below this fraction of the authored size… */
export const FIT_MIN_SCALE = 0.6;
/** …and never render text below this pixel size, whichever bites first. */
export const FIT_MIN_PX = 11;
/** Line-spacing reduction cap — PowerPoint reduces spacing at most ~20%. */
export const FIT_MAX_LNSR = 0.2;

/**
 * The patent's wrap-aware first guess, pure for tests.
 *
 * @param fullness  scrollHeight / clientHeight, > 1 when overfull
 * @param avgLineChars  average characters per rendered line — the wrap signal
 * @returns scale in (0, 1): the seed the in-page bisection starts from
 */
export const fitGuess = (fullness: number, avgLineChars: number): number => {
  if (!(fullness > 1)) return 1;
  const noRewrap = 1 / fullness; // short lines: removing height is linear
  const fullRewrap = Math.sqrt(1 / fullness); // long lines: area-like rewrap
  // Interpolation weight: at ≤10 chars/line treat as pure no-rewrap; by ~40+
  // chars/line the sqrt bound dominates (the patent interpolates around a
  // ~30-char knee; the exact knee matters less than being between bounds).
  const t = Math.min(1, Math.max(0, (avgLineChars - 10) / 30));
  return noRewrap + (fullRewrap - noRewrap) * t;
};

/** Floor for a candidate whose smallest authored font is `minPx`. Pure. */
export const floorScale = (minPx: number): number =>
  Math.max(FIT_MIN_SCALE, minPx > 0 ? Math.min(1, FIT_MIN_PX / minPx) : FIT_MIN_SCALE);

/**
 * The in-page pass. Dependency-free, ES5-safe, no template interpolation
 * inside (it is embedded in template literals by two builders). Contract:
 *   window.__rbFitDone  — Promise resolving after the pass (or immediately
 *                          when there is nothing to do);
 *   window.__rbFitSummary — { fitted, floored, candidates } for probes;
 *   data-rb-fit / data-rb-fit-floor — per-element outcome marks.
 * Roots: .renderball-canvas (scene-iframe) or #rb-stage (measure-scene).
 * data-rb-no-fit on an element exempts its whole subtree.
 */
export const FIT_TEXT_SCRIPT: string = [
  "(function () {",
  "  var MIN_SCALE = " + FIT_MIN_SCALE + ";",
  "  var MIN_PX = " + FIT_MIN_PX + ";",
  "  var MAX_LNSR = " + FIT_MAX_LNSR + ";",
  "  var EPS = 2; /* px of forgiven overflow — sub-line rounding, descenders */",
  "  var resolveDone;",
  "  window.__rbFitDone = new Promise(function (r) { resolveDone = r; });",
  "  window.__rbFitSummary = { fitted: 0, floored: 0, candidates: 0 };",
  "  function overflowPx(el) { return el.scrollHeight - el.clientHeight; }",
  "  function isOverfull(el) { return el.clientHeight > 8 && overflowPx(el) > EPS; }",
  "  function hasText(el) {",
  "    for (var i = 0; i < el.childNodes.length; i++) {",
  "      var n = el.childNodes[i];",
  "      if (n.nodeType === 3 && String(n.textContent).replace(/\\s+/g, '') !== '') return true;",
  "      if (n.nodeType === 1 && hasText(n)) return true;",
  "    }",
  "    return false;",
  "  }",
  "  function bigReplaced(el) {",
  "    var media = el.querySelectorAll('img,svg,video,canvas');",
  "    for (var i = 0; i < media.length; i++) {",
  "      var r = media[i].getBoundingClientRect();",
  "      if (r.height > el.clientHeight * 0.6) return true;",
  "    }",
  "    return false;",
  "  }",
  "  function exempt(el) {",
  "    for (var n = el; n; n = n.parentElement) {",
  "      if (n.getAttribute && n.getAttribute('data-rb-no-fit') !== null) return true;",
  "    }",
  "    return false;",
  "  }",
  "  function textNodesOf(root) {",
  "    var out = [];",
  "    var all = [root].concat(Array.prototype.slice.call(root.querySelectorAll('*')));",
  "    for (var i = 0; i < all.length; i++) {",
  "      var el = all[i];",
  "      var direct = false;",
  "      for (var j = 0; j < el.childNodes.length; j++) {",
  "        var n = el.childNodes[j];",
  "        if (n.nodeType === 3 && String(n.textContent).replace(/\\s+/g, '') !== '') { direct = true; break; }",
  "      }",
  "      if (direct) out.push(el);",
  "    }",
  "    return out;",
  "  }",
  "  function fitOne(box) {",
  "    var nodes = textNodesOf(box);",
  "    if (nodes.length === 0) return;",
  "    var meta = [];",
  "    var minFs = Infinity;",
  "    for (var i = 0; i < nodes.length; i++) {",
  "      var cs = getComputedStyle(nodes[i]);",
  "      var fs = parseFloat(cs.fontSize) || 16;",
  "      var lh = parseFloat(cs.lineHeight);",
  "      if (!isFinite(lh)) lh = fs * 1.2; /* 'normal' */",
  "      meta.push({ el: nodes[i], fs: fs, lh: lh });",
  "      if (fs < minFs) minFs = fs;",
  "    }",
  "    function apply(scale, lnsr) {",
  "      for (var i = 0; i < meta.length; i++) {",
  "        var m = meta[i];",
  "        m.el.style.fontSize = (Math.round(m.fs * scale * 4) / 4) + 'px';",
  "        m.el.style.lineHeight = (Math.round(m.lh * scale * (1 - lnsr) * 4) / 4) + 'px';",
  "      }",
  "    }",
  "    /* 1 — line spacing first, capped. */",
  "    var f0 = box.scrollHeight / box.clientHeight;",
  "    var lnsr = Math.min(MAX_LNSR, Math.max(0, 1 - 1 / f0));",
  "    if (lnsr > 0.01) {",
  "      apply(1, lnsr);",
  "      if (!isOverfull(box)) {",
  "        box.setAttribute('data-rb-fit', 'l=' + lnsr.toFixed(2));",
  "        window.__rbFitSummary.fitted++;",
  "        return;",
  "      }",
  "    }",
  "    /* 2 — font scale, patent-seeded. */",
  "    var fullness = box.scrollHeight / box.clientHeight;",
  "    var text = box.innerText || '';",
  "    var lineCount = Math.max(1, Math.round(box.scrollHeight / (meta[0].lh || 20)));",
  "    var avgChars = text.length / lineCount;",
  "    var noRewrap = 1 / fullness;",
  "    var fullRewrap = Math.sqrt(1 / fullness);",
  "    var t = Math.min(1, Math.max(0, (avgChars - 10) / 30));",
  "    var guess = noRewrap + (fullRewrap - noRewrap) * t;",
  "    var floorS = Math.max(MIN_SCALE, minFs > 0 ? Math.min(1, MIN_PX / minFs) : MIN_SCALE);",
  "    var lo = floorS, hi = 1, scale = Math.max(floorS, Math.min(1, guess));",
  "    var fitted = false;",
  "    for (var probe = 0; probe < 5; probe++) {",
  "      apply(scale, lnsr);",
  "      if (isOverfull(box)) { hi = scale; } else { fitted = true; lo = scale; if (probe > 0) break; }",
  "      var next = fitted ? (lo + hi) / 2 : (lo + scale) / 2;",
  "      /* once fitting, one refinement upward is enough; overfull → bisect down */",
  "      if (fitted && hi - lo < 0.04) break;",
  "      scale = Math.max(floorS, Math.min(1, next));",
  "      if (!fitted && scale <= floorS + 0.001) { apply(floorS, lnsr); fitted = !isOverfull(box); scale = floorS; break; }",
  "    }",
  "    if (!fitted) apply(lo, lnsr); /* rest at the best known (floor) size */",
  "    if (isOverfull(box)) {",
  "      /* the mark carries RESIDUAL FULLNESS at the floor — the semantic",
  "         shorten path computes its convergent target from it: a box 1.4x",
  "         overfull needs the copy ~1/1.4 as long. '1' told nobody anything. */",
  "      box.setAttribute('data-rb-fit-floor', (box.scrollHeight / Math.max(1, box.clientHeight)).toFixed(2));",
  "      window.__rbFitSummary.floored++;",
  "    } else {",
  "      window.__rbFitSummary.fitted++;",
  "    }",
  "    box.setAttribute('data-rb-fit', 's=' + scale.toFixed(2) + (lnsr > 0.01 ? ';l=' + lnsr.toFixed(2) : ''));",
  "  }",
  "  function pass(root) {",
  "    var all = Array.prototype.slice.call(root.querySelectorAll('*'));",
  "    var cands = [];",
  "    for (var i = 0; i < all.length; i++) {",
  "      var el = all[i];",
  "      if (!isOverfull(el)) continue;",
  "      if (!hasText(el)) continue;",
  "      if (exempt(el)) continue;",
  "      if (bigReplaced(el)) continue;",
  "      cands.push(el);",
  "    }",
  "    /* outermost first: fitting a parent rescales its children and often",
  "       resolves them; children still overfull get the second pass. */",
  "    var outer = [];",
  "    for (var i = 0; i < cands.length; i++) {",
  "      var covered = false;",
  "      for (var j = 0; j < cands.length; j++) {",
  "        if (i !== j && cands[j].contains(cands[i])) { covered = true; break; }",
  "      }",
  "      if (!covered) outer.push(cands[i]);",
  "    }",
  "    window.__rbFitSummary.candidates += outer.length;",
  "    for (var i = 0; i < outer.length; i++) fitOne(outer[i]);",
  "  }",
  "  function run() {",
  "    try {",
  "      var root = document.querySelector('.renderball-canvas') || document.getElementById('rb-stage');",
  "      if (root) { pass(root); pass(root); /* second pass: inner residuals */ }",
  "    } catch (e) { /* a fit failure must never break a render */ }",
  "    resolveDone(window.__rbFitSummary);",
  "  }",
  "  function start() {",
  "    if (document.fonts && document.fonts.ready && document.fonts.ready.then) {",
  "      document.fonts.ready.then(run, run);",
  "    } else { run(); }",
  "  }",
  "  if (document.readyState === 'loading') {",
  "    document.addEventListener('DOMContentLoaded', start);",
  "  } else { start(); }",
  "})();",
].join("\n");
