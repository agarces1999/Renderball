/**
 * MEASURED character budgets per content role — the Layer-3 upstream numbers
 * (docs/TEXT_FIT.md: "measure each slot's real capacity ONCE, offline, with
 * real fonts, and put the budget in the generation schema").
 *
 * Measured 2026-08-16 by scripts/measure-copy-budgets.mjs: live Chromium,
 * the CONSERVATIVE canonical copy column (780px — layout-composer's split
 * slot; centered = 960, band = 900), a width-spread of faces decks actually
 * resolve to when brand faces are unknowable upstream (Verdana was the
 * widest and therefore sets every bound), 6% wrap slack. Raw capacity:
 *
 *   headline  84px × 3 lines → 39 chars   (14 cpl)
 *   lede      24px × 4 lines → 229 chars  (61 cpl)
 *   bullet    20px × 2 lines → 139 chars  (74 cpl)
 *   caption   16px × 2 lines → 174 chars  (93 cpl)
 *   eyebrow   14px × 1 line  → 62 chars   (66 cpl, uppercase + tracking)
 *
 * Policy applied to raw capacity:
 * - HEADLINE budgets at the 68px basis (~48 chars) — the largest COMMON hero
 *   size, one ramp step below the head. A 48-char headline renders ≥68px
 *   without ever hitting the fit floor; the old prompt guess (≤120) was 3×
 *   over the 84px capacity, which is why long headlines stepped far down the
 *   ramp or floored.
 * - Where the prompt's old editorial guess was TIGHTER than capacity
 *   (bullet 120 < 139, caption 140 < 174), the tighter number stays —
 *   brevity is a feature; only looseness beyond capacity is a defect.
 * - The eyebrow had NO cap before; it gets its measured single-line bound.
 *
 * These constants are the single source: the generation prompt interpolates
 * them, the post-parse gate enforces them (ONE bounded shorten retry — the
 * research is explicit that constrained decoding cannot enforce length), and
 * the build-time semantic shorten targets them.
 */
export const COPY_BUDGETS = {
  headline: 48,
  lede: 229,
  bullet: 120,
  caption: 140,
  eyebrow: 62,
} as const;

export type BudgetedField = keyof typeof COPY_BUDGETS;

export interface BudgetViolation {
  sceneIndex: number;
  field: string; // "headline" | "lede" | "caption" | "eyebrow" | "bullets[2]"
  budget: number;
  length: number;
  value: string;
}

/** Every content field over its measured budget, exactly as addressed in the scene. */
export const findBudgetViolations = (
  scenes: { content?: Record<string, unknown> }[],
): BudgetViolation[] => {
  const out: BudgetViolation[] = [];
  scenes.forEach((scene, sceneIndex) => {
    const c = scene.content;
    if (!c) return;
    for (const field of ["headline", "lede", "caption", "eyebrow"] as const) {
      const v = c[field];
      if (typeof v === "string" && v.length > COPY_BUDGETS[field]) {
        out.push({ sceneIndex, field, budget: COPY_BUDGETS[field], length: v.length, value: v });
      }
    }
    const bullets = c.bullets;
    if (Array.isArray(bullets)) {
      bullets.forEach((b, i) => {
        if (typeof b === "string" && b.length > COPY_BUDGETS.bullet) {
          out.push({ sceneIndex, field: `bullets[${i}]`, budget: COPY_BUDGETS.bullet, length: b.length, value: b });
        }
      });
    }
  });
  return out;
};

/** Write a shortened value back to the exact address a violation names. */
export const applyShortenedValue = (
  scenes: { content?: Record<string, unknown> }[],
  v: BudgetViolation,
  value: string,
): boolean => {
  const c = scenes[v.sceneIndex]?.content;
  if (!c) return false;
  const m = /^bullets\[(\d+)\]$/.exec(v.field);
  if (m) {
    const arr = c.bullets;
    if (!Array.isArray(arr) || !(Number(m[1]) in arr)) return false;
    arr[Number(m[1])] = value;
    return true;
  }
  if (!(v.field in COPY_BUDGETS)) return false;
  c[v.field] = value;
  return true;
};
