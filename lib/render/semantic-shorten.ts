/**
 * SEMANTIC SHORTEN — TEXT_FIT layer 3's build-time half. When the render-time
 * fit pass hits its readability floor (data-rb-fit-floor, which now carries
 * the RESIDUAL FULLNESS), shrinking has failed and the copy itself is too
 * long for its box. The repair is one targeted call: "shorten this field to
 * ≤N chars" — convergent by construction, because N is COMPUTED from the
 * measured overfullness, not judged: a box 1.4× overfull needs copy ~1/1.4
 * as long (capped by the role's measured budget where the field has one).
 *
 * Bounded: ONE call per build, only the floored fields, never blocking — a
 * failed or refused shorten leaves the deck exactly as it was (flagged by
 * the gates as before).
 */
import { COPY_BUDGETS } from "../agents/copy-budgets";
import type { SceneMeasurement } from "./measure-scene";

export interface FlooredCopy {
  scene: number;
  /** dot-form content path as emitted: "headline", "bullets.2", "cta.primary" */
  path: string;
  fullness: number;
  current: string;
  /** convergent target length */
  target: number;
}

const budgetForPath = (path: string): number | null => {
  if (path.startsWith("bullets.")) return COPY_BUDGETS.bullet;
  if (path in COPY_BUDGETS) return COPY_BUDGETS[path as keyof typeof COPY_BUDGETS];
  return null; // cta.* / meta.* — no measured budget; fullness alone drives
};

const readPath = (content: Record<string, unknown>, path: string): unknown =>
  path.split(".").reduce<unknown>((acc, k) => {
    if (acc == null || typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[k];
  }, content);

const writePath = (content: Record<string, unknown>, path: string, value: string): boolean => {
  const parts = path.split(".");
  let node: unknown = content;
  for (const k of parts.slice(0, -1)) {
    if (node == null || typeof node !== "object") return false;
    node = (node as Record<string, unknown>)[k];
  }
  const leaf = parts[parts.length - 1];
  if (node == null || typeof node !== "object") return false;
  (node as Record<string, unknown>)[leaf] = value;
  return true;
};

/** Floored, content-mapped copy across the measured deck — deduped per field,
 *  worst fullness wins. */
export const findFlooredCopy = (
  measured: SceneMeasurement[],
  scenes: { content?: Record<string, unknown> }[],
): FlooredCopy[] => {
  const byKey = new Map<string, FlooredCopy>();
  for (const m of measured) {
    for (const el of m.elements) {
      if (!el.fitFloor || !el.contentPath) continue;
      const content = scenes[m.scene]?.content;
      if (!content) continue;
      const value = readPath(content, el.contentPath);
      if (typeof value !== "string" || value.length < 12) continue;
      const budget = budgetForPath(el.contentPath);
      // 0.95 under the pure-fullness bound: wrap granularity means exact
      // division still wraps one line long about half the time.
      const byFullness = Math.floor((value.length / el.fitFloor) * 0.95);
      const target = Math.max(8, budget ? Math.min(byFullness, budget) : byFullness);
      if (target >= value.length) continue; // nothing to gain
      const key = `${m.scene}:${el.contentPath}`;
      const prev = byKey.get(key);
      if (!prev || el.fitFloor > prev.fullness) {
        byKey.set(key, { scene: m.scene, path: el.contentPath, fullness: el.fitFloor, current: value, target });
      }
    }
  }
  return [...byKey.values()];
};

/** Apply model-shortened values; only entries that actually fit are adopted. */
export const applyShortened = (
  floored: FlooredCopy[],
  answers: unknown[],
  scenes: { content?: Record<string, unknown> }[],
): number => {
  let applied = 0;
  floored.forEach((f, i) => {
    const v = answers[i];
    if (typeof v !== "string") return;
    const trimmed = v.trim();
    if (trimmed.length === 0 || trimmed.length > f.target + 8) return; // 8-char grace, not a loophole
    const content = scenes[f.scene]?.content;
    if (content && writePath(content, f.path, trimmed)) applied += 1;
  });
  return applied;
};

export const shortenPrompt = (floored: FlooredCopy[]): string =>
  `This presentation copy does not fit its boxes even at the smallest readable size. Shorten each numbered line to AT OR UNDER its max characters. Keep the meaning, voice and language. Return ONLY a JSON array of the shortened strings, in order.\n\n${floored
    .map((f, i) => `${i}. (max ${f.target} chars, currently ${f.current.length}): "${f.current}"`)
    .join("\n")}`;
