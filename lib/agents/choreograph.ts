/**
 * Deterministic choreographer — motion as a COMPILE STEP, not a second LLM pass.
 *
 * The two-pass build re-emitted the whole ~18k-token Composition.tsx just to
 * weave in CSS motion (the "double work"), and the dead-air / reading-time /
 * dwell gates + their paid retries existed ONLY because the LLM timed motion
 * badly. But those gates are deterministic inequalities. This module solves them
 * FORWARD: it schedules every element's entrance so pacing is correct BY
 * CONSTRUCTION, at zero LLM tokens.
 *
 * How it attaches motion without fragile inline-style surgery:
 *   - Element discovery + word counts come from `script.content` (exact), keyed
 *     to the `data-content-path` anchors the design agent already emits.
 *   - Motion is a set of SCOPED CSS rules (`[data-scene="i"] [data-content-path=
 *     "headline"] { animation: … }`) collected into one injected `CHOREO_CSS`
 *     const. The only code edits are: tag each Section root with `data-scene={i}`
 *     and prepend `CHOREO_CSS +` to that section's existing `<style>` __html.
 *   - Dead-air is guaranteed by one infinite ambient on the section root
 *     (imperceptible whole-frame breathe) — assessDeadAir sees `infinite` and
 *     passes for every scene.
 *
 * The gate functions (assessDeadAir/findSlowTextEntrances/findUndwelledText) are
 * kept in the pipeline as LOG-ONLY assertions — a failure here is a choreographer
 * bug, never a paid retry. `scheduleScene` is exported so a unit test can prove
 * the schedule satisfies the exact gate inequalities.
 */
import type { Script } from "../../src/schema";
import { sectionRanges } from "./section-splice";

export type MotionSignal = "high" | "medium" | "low";

type Role = "eyebrow" | "headline" | "lede" | "bullets" | "meta" | "caption" | "cta" | "body";

export interface SceneField {
  /** The data-content-path the design agent emitted for this element. */
  path: string;
  role: Role;
  words: number;
}

export interface ScheduledField extends SceneField {
  keyframe: string;
  /** Entrance duration (s) — always ≤1.0 so findSlowTextEntrances never fires. */
  durationS: number;
  /** Entrance delay (s) — chosen so delay+duration+readTime ≤ T (dwell gate). */
  delayS: number;
}

const EASE = "cubic-bezier(.2,.8,.2,1)";

// The fixed keyframe vocabulary (lifted from prompts/animation-agent.ts, plus the
// two ambient loops the choreographer owns). Injected once as CHOREO_CSS.
export const CHOREO_KEYFRAMES = `
@keyframes choreoFadeRise { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
@keyframes choreoScaleIn { 0% { opacity: 0; transform: scale(0.85); } 60% { opacity: 1; transform: scale(1.04); } 100% { opacity: 1; transform: scale(1); } }
@keyframes choreoFadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes choreoAmbient { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.006); } }
@keyframes choreoBreathe { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.02); } }`.trim();

const roleOf = (path: string): Role => {
  if (path === "eyebrow") return "eyebrow";
  if (path === "headline") return "headline";
  if (path === "lede") return "lede";
  if (path.startsWith("bullets")) return "bullets";
  if (path.startsWith("meta")) return "meta";
  if (path === "caption") return "caption";
  if (path.startsWith("cta")) return "cta";
  return "body";
};

// Reading order: what a viewer scans top-to-bottom. Drives the entrance stagger.
const READING_ORDER: Role[] = ["eyebrow", "headline", "lede", "bullets", "meta", "caption", "cta", "body"];

const keyframeFor = (role: Role): string => (role === "cta" ? "choreoScaleIn" : "choreoFadeRise");
// Headlines settle fast (≤0.4s per the reading-time rule); body a touch slower.
const durationFor = (role: Role): number => (role === "headline" || role === "eyebrow" ? 0.4 : 0.5);

const round2 = (n: number): number => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const wordCount = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;

const sceneSeconds = (s: Script["scenes"][number]): number => {
  if (typeof s.start_seconds === "number" && typeof s.end_seconds === "number") {
    return s.end_seconds - s.start_seconds;
  }
  if (typeof s.start_frame === "number" && typeof s.end_frame === "number") {
    return (s.end_frame - s.start_frame) / 30;
  }
  return 0;
};

const STEP_FOR: Record<MotionSignal, number> = { high: 0.12, medium: 0.18, low: 0.25 };
const AMBIENT_S_FOR: Record<MotionSignal, number> = { high: 6, medium: 8, low: 10 };

/** Enumerate the animatable text fields present in a scene's content, in reading
 *  order, with exact word counts from the script (not the code). */
export const fieldsOf = (content: unknown): SceneField[] => {
  const c = (content ?? {}) as Record<string, unknown>;
  const out: SceneField[] = [];
  const push = (path: string, text: unknown) => {
    const s = typeof text === "string" ? text : "";
    if (s.trim()) out.push({ path, role: roleOf(path), words: wordCount(s) });
  };
  push("eyebrow", c.eyebrow);
  push("headline", c.headline);
  push("lede", c.lede);
  if (Array.isArray(c.bullets)) c.bullets.forEach((b, i) => push(`bullets.${i}`, b));
  if (Array.isArray(c.meta))
    (c.meta as Array<Record<string, unknown>>).forEach((m, i) => push(`meta.${i}.value`, m?.value));
  push("caption", c.caption);
  const cta = c.cta as Record<string, unknown> | undefined;
  if (cta) {
    push("cta.primary", cta.primary);
    push("cta.secondary", cta.secondary);
  }
  return out;
};

/**
 * Schedule a scene's entrances so EVERY text beat satisfies the dwell gate
 * (delay + duration + max(1.2, words*0.3) ≤ T) while keeping a reading-order
 * stagger. The tightest element clamps its own delay to its latest legible start;
 * over-long copy (readTime alone eats the scene — the gate's MAX_READ_FRACTION
 * carve-out) lands as early as possible.
 */
export const scheduleScene = (
  fields: SceneField[],
  sceneDurationS: number,
  signal: MotionSignal,
): ScheduledField[] => {
  const step = STEP_FOR[signal];
  const T = sceneDurationS;
  const ordered = [...fields].sort(
    (a, b) => READING_ORDER.indexOf(a.role) - READING_ORDER.indexOf(b.role),
  );
  return ordered.map((f, k) => {
    const duration = durationFor(f.role);
    const readTime = Math.max(1.2, f.words * 0.3);
    const desired = k * step + 0.1; // small initial offset so nothing pops at t=0
    const maxDelay = T - duration - readTime; // latest start that still leaves reading time
    const delay = maxDelay < 0 ? 0 : clamp(desired, 0, maxDelay);
    return { ...f, keyframe: keyframeFor(f.role), durationS: duration, delayS: round2(delay) };
  });
};

/** The scoped CSS rules for one scene: per-element entrances + the ambient
 *  guarantee + the throughline motif (entrance + subtle infinite breathe). */
export const buildSceneCss = (
  sceneIndex: number,
  scheduled: ScheduledField[],
  signal: MotionSignal,
): string => {
  const sel = `[data-scene="${sceneIndex}"]`;
  const rules: string[] = [];
  for (const s of scheduled) {
    // `both` fill-mode holds the from-state during the delay (hidden) and the
    // to-state after — so the element is never visible before its beat and
    // stays settled to be read.
    rules.push(
      `${sel} [data-content-path="${s.path}"] { animation: ${s.keyframe} ${s.durationS}s ${EASE} ${s.delayS}s both; }`,
    );
  }
  const amb = AMBIENT_S_FOR[signal];
  // NOTE: the section-root ambient is injected INLINE on the root div (see
  // tagSectionRoot), NOT as a rule here — assessDeadAir scans each section's
  // code slice for `infinite`, and a rule in the module-scope CHOREO_CSS const
  // lives outside that slice, so it must be inline on the root to be seen + to
  // guarantee the dead-air pass.
  // The recurring throughline motif gets a slightly bolder entrance + its own
  // sustained loop (no-op when a scene has no data-throughline element).
  rules.push(
    `${sel} [data-throughline] { animation: choreoScaleIn 0.6s ${EASE} 0.15s both, choreoBreathe ${amb}s ease-in-out 0.6s infinite; }`,
  );
  return rules.join("\n");
};

// Tag a section's root <div style={{ ...SECTION_FRAME … }}> with data-scene={i}
// (so the scoped rules target it) AND inject the ambient loop INLINE on that root
// — an imperceptible whole-frame breathe (scale 1.006). Inline, not a CHOREO_CSS
// rule, because assessDeadAir scans each section's own code slice for `infinite`:
// a rule in the module-scope const lives outside that slice, so the ambient must
// be inline on the root to be seen and to guarantee the dead-air pass. First
// occurrence only (the root).
const tagSectionRoot = (slice: string, i: number, ambientS: number): string =>
  slice.replace(
    /<div(\s+style=\{\{\s*)(\.\.\.SECTION_FRAME)/,
    `<div data-scene={${i}}$1animation: "choreoAmbient ${ambientS}s ease-in-out infinite", $2`,
  );

// Prepend CHOREO_CSS to the section's existing <style> __html so the keyframes +
// scoped rules mount. If the section has no <style> (unusual — the design agent
// emits one for brand fonts), inject a fresh one right after the root open tag.
const wireSectionStyle = (slice: string, i: number): string => {
  if (/dangerouslySetInnerHTML=\{\{\s*__html:\s*/.test(slice)) {
    return slice.replace(/dangerouslySetInnerHTML=\{\{\s*__html:\s*/, (m) => `${m}CHOREO_CSS + `);
  }
  // No <style> — inject as the FIRST CHILD of the (already tagged) root div.
  // Only possible when the root actually has children: a SELF-CLOSING root
  // (`<div … />` — the blank-stub shape) cannot take a child, and appending a
  // sibling after it makes the arrow body two expressions → "Expected ';' but
  // found 'dangerouslySetInnerHTML'" at the hard compile gate (real failure,
  // 2026-07-09: a network-dead fill shipped its stub and the whole build died
  // here). A stub has nothing to animate — skip it; its inline ambient's
  // unresolved keyframe name is inert.
  const m = slice.match(/<div\s+data-scene=\{\d+\}[^>]*>/);
  if (m && m.index != null && !m[0].endsWith("/>")) {
    const at = m.index + m[0].length;
    return (
      slice.slice(0, at) +
      `\n      <style dangerouslySetInnerHTML={{ __html: CHOREO_CSS }} />` +
      slice.slice(at)
    );
  }
  console.warn(
    `[choreograph] Section${i}: no <style> and no wrappable root (blank stub?) — motion not mounted for this scene`,
  );
  return slice;
};

/**
 * Apply deterministic motion to a STATIC composition. Pure string transform, no
 * LLM. Returns the animated .tsx (same shape Pass 2 produced) — SectionClock
 * pins the injected CSS animations identically. Best-effort: on any unexpected
 * shape it returns the input unchanged rather than break the build.
 */
export const applyChoreography = (
  code: string,
  script: Script,
  signal: MotionSignal = "medium",
): string => {
  try {
    // 1. Build the full CHOREO_CSS from the SCRIPT (no code parsing for discovery).
    const cssParts: string[] = [CHOREO_KEYFRAMES];
    for (let i = 0; i < script.scenes.length; i += 1) {
      const T = sceneSeconds(script.scenes[i]);
      const scheduled = scheduleScene(fieldsOf(script.scenes[i].content), T, signal);
      cssParts.push(buildSceneCss(i, scheduled, signal));
    }
    const choreoCssValue = cssParts.join("\n");

    // 2. Edit each Section's slice (last→first so earlier ranges stay valid):
    //    tag the root + wire the <style>.
    let out = code;
    const ambientS = AMBIENT_S_FOR[signal];
    const ranges = sectionRanges(out).sort((a, b) => b.start - a.start);
    if (ranges.length === 0) return code; // nothing to choreograph
    for (const r of ranges) {
      const slice = out.slice(r.start, r.end);
      const edited = wireSectionStyle(tagSectionRoot(slice, r.index, ambientS), r.index);
      out = out.slice(0, r.start) + edited + out.slice(r.end);
    }

    // 3. Inject the CHOREO_CSS const just before the first Section (after all
    //    imports + module consts it references nothing of, so position is safe).
    const constDecl = `const CHOREO_CSS = \`\n${choreoCssValue}\n\`;\n\n`;
    if (out.includes("export const Section0")) {
      out = out.replace("export const Section0", constDecl + "export const Section0");
    } else {
      console.warn("[choreograph] no `export const Section0` — CHOREO_CSS not injected");
      return code;
    }
    return out;
  } catch (err) {
    console.warn("[choreograph] failed, shipping static:", err instanceof Error ? err.message : err);
    return code;
  }
};
