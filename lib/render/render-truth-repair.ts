/**
 * Render-truth self-repair ladder (Phase 2).
 *
 * After a build is written, we MEASURE the real render (measure-scene) and gate
 * it (render-truth-gates). If there are blocking findings (clipped/off-canvas
 * content), we don't ship — we try to fix, escalating:
 *
 *   L1  regenerate the failing scene(s)' design (fix the layout)        → re-measure
 *   L2  regenerate again                                                 → re-measure
 *   L3  rewrite the failing scene(s)' SCRIPT (lighter concept) + rebuild → re-measure
 *   L4  give up → caller hard-fails the build (do not ship)
 *
 * A hard COST CEILING ($10/build by default) caps the loop: before any paid
 * step, if cumulative spend would reach the ceiling we stop (reason
 * "cost-ceiling") rather than run away (cf. the 2h45m / untracked-cost incident).
 *
 * All I/O is injected via callbacks, so the ladder logic is unit-tested with
 * mocks — no real build/render spend needed to verify the escalation decisions.
 */
import { MODELS } from "../anthropic";
import { costUsd, type Usage } from "../usage";
import type { RenderTruthFinding } from "./render-truth-gates";
import type { SceneMeasurement } from "./measure-scene";

export const COST_CEILING_USD = 10;
export const MAX_DESIGN_RETRIES = 2; // L1 + L2

export interface GateResult {
  findings: RenderTruthFinding[];
  blocking: RenderTruthFinding[];
  /** The raw measurements this gate ran on (carries each scene's screenshotPath).
   *  Optional so test/mocks needn't supply them; the caller threads them out for
   *  the vision gate so it reuses these screenshots instead of re-rendering. */
  measurements?: SceneMeasurement[];
}

/** What a repair step produced. usage is the tokens it spent (for the ceiling). */
export interface RepairStepResult {
  ok: boolean;
  usage?: Usage;
  error?: string;
}

export interface RepairCallbacks {
  /** Measure + gate the CURRENT genDir (already written). */
  measure: () => Promise<GateResult>;
  /** Regenerate one scene's design with a fix instruction, then write it. */
  regenScene: (sceneIndex: number, instruction: string) => Promise<RepairStepResult>;
  /** Rewrite the given scenes' script (lighter concept) + full rebuild, then write. */
  rewriteScript: (sceneIndexes: number[], reason: string) => Promise<RepairStepResult>;
  /** Cost of a usage bundle (model-aware). Defaults to costUsd(model, ·). */
  costOf?: (u: Usage) => number;
  /** Optional progress log. */
  onStep?: (msg: string) => void;
}

export interface RepairResult {
  ok: boolean;
  reason:
    | "passed"
    | "repaired"
    | "cost-ceiling"
    | "ladder-exhausted"
    | "measure-error"
    | "error";
  steps: string[];
  spentUsd: number;
  findings: RenderTruthFinding[];
  blocking: RenderTruthFinding[];
  /** Findings from the FIRST measure pass — what the gates caught before any
   *  repair. Telemetry tallies these (the deletion criterion needs pre-repair
   *  fires; `findings` is the final measure, where repaired findings vanish). */
  initialFindings: RenderTruthFinding[];
  /** Measurements from the LAST measure pass (final composition). The caller
   *  feeds these to the advisory vision gate instead of measuring a second time. */
  measurements?: SceneMeasurement[];
}

const scenesOf = (findings: RenderTruthFinding[]): number[] =>
  [...new Set(findings.map((f) => f.scene))].sort((a, b) => a - b);

const overflowInstruction = (sceneFindings: RenderTruthFinding[]): string => {
  const detail = sceneFindings.map((f) => f.detail).join("; ");
  return (
    `This scene has content rendered OUTSIDE the 1920×1080 canvas (it gets clipped): ${detail}. ` +
    `Fix the LAYOUT so every element fits within the canvas with a safe margin: narrow or wrap wide rows, ` +
    `reduce fixed widths, re-anchor off-canvas elements, shrink horizontal flows. Keep the copy and the brand; just make it fit.`
  );
};

/**
 * Run the self-repair ladder against an already-built+written genDir.
 * `spentSoFarUsd` is the cost of the initial build (counts toward the ceiling).
 */
export const repairRenderTruth = async (
  cb: RepairCallbacks,
  opts: { spentSoFarUsd?: number; ceilingUsd?: number; model?: string } = {},
): Promise<RepairResult> => {
  const ceiling = opts.ceilingUsd ?? COST_CEILING_USD;
  const model = opts.model ?? MODELS.codingAgentBuild;
  const costOf = cb.costOf ?? ((u: Usage) => costUsd(model, u));
  const steps: string[] = [];
  let spent = opts.spentSoFarUsd ?? 0;
  const log = (m: string) => {
    steps.push(m);
    cb.onStep?.(m);
  };

  let gate = await cb.measure();
  // Fail LOUD on a malformed gate. The original symptom was a cryptic "Cannot
  // read properties of undefined (reading 'length')" here, caused by a measure()
  // callback that spread an UNAWAITED async gate fn (so blocking/findings were
  // absent). Assert the shape so the next such mistake names itself.
  if (!gate || !Array.isArray(gate.blocking) || !Array.isArray(gate.findings)) {
    throw new Error(
      "repairRenderTruth: measure() returned a malformed GateResult (findings/blocking must be arrays) — did an async gate fn get spread without await?",
    );
  }
  const initialFindings = gate.findings;
  if (gate.blocking.length === 0) {
    return { ok: true, reason: "passed", steps, spentUsd: spent, findings: gate.findings, blocking: [], initialFindings, measurements: gate.measurements };
  }

  // A measure-error means the scene couldn't be measured at all (missing
  // browser, compile/eval failure, no Section export). regenScene/rewriteScript
  // are LAYOUT fixes — they cannot repair an infra/compile failure, and running
  // them would burn real Opus dollars (up to 2N regen + 1 rebuild) on a doomed
  // condition before hard-failing anyway. If EVERY blocking finding is a
  // measure-error, stop immediately with the real cause and zero extra spend.
  const allMeasureErrors = gate.blocking.every((f) => f.kind === "measure-error");
  if (allMeasureErrors) {
    log(
      `measure-error(s) cannot be repaired by design retry/rewrite — hard-failing without spend: ${gate.blocking
        .map((f) => f.detail)
        .join("; ")}`,
    );
    return { ok: false, reason: "measure-error", steps, spentUsd: spent, findings: gate.findings, blocking: gate.blocking, initialFindings, measurements: gate.measurements };
  }
  log(`measured ${gate.blocking.length} blocking finding(s) on scene(s) ${scenesOf(gate.blocking).join(", ")}`);

  // Budget guard run before each PAID step: stop if we're already at/over the
  // ceiling (a paid step would breach it). Conservative — stops at the ceiling,
  // never past it.
  const overBudget = () => spent >= ceiling;

  // ── L1 + L2: design retries on the failing scenes ────────────────────────
  for (let attempt = 1; attempt <= MAX_DESIGN_RETRIES; attempt++) {
    if (overBudget()) {
      log(`cost ceiling $${ceiling} reached ($${spent.toFixed(2)} spent) — stopping before L${attempt} design retry`);
      return { ok: false, reason: "cost-ceiling", steps, spentUsd: spent, findings: gate.findings, blocking: gate.blocking, initialFindings, measurements: gate.measurements };
    }
    const failing = scenesOf(gate.blocking);
    log(`L${attempt}: regenerating design for scene(s) ${failing.join(", ")}`);
    for (const s of failing) {
      const sceneFindings = gate.blocking.filter((f) => f.scene === s);
      const r = await cb.regenScene(s, overflowInstruction(sceneFindings));
      if (r.usage) spent += costOf(r.usage);
      if (!r.ok) log(`  scene ${s} regen error: ${r.error ?? "unknown"}`);
    }
    gate = await cb.measure();
    if (gate.blocking.length === 0) {
      return { ok: true, reason: "repaired", steps: [...steps, `passed after L${attempt}`], spentUsd: spent, findings: gate.findings, blocking: [], initialFindings, measurements: gate.measurements };
    }
  }

  // ── L3: rewrite the failing scenes' script (lighter concept) + rebuild ────
  if (overBudget()) {
    log(`cost ceiling $${ceiling} reached ($${spent.toFixed(2)} spent) — stopping before L3 script rewrite`);
    return { ok: false, reason: "cost-ceiling", steps, spentUsd: spent, findings: gate.findings, blocking: gate.blocking, initialFindings, measurements: gate.measurements };
  }
  const failing = scenesOf(gate.blocking);
  log(`L3: rewriting script for scene(s) ${failing.join(", ")} (concept too dense to fit) + rebuild`);
  const rw = await cb.rewriteScript(
    failing,
    `These scenes render content off-canvas even after layout retries — the visual_concept is too dense to fit 1920×1080. Simplify them to fewer, smaller elements that fit.`,
  );
  if (rw.usage) spent += costOf(rw.usage);
  if (!rw.ok) {
    log(`L3 rewrite/rebuild error: ${rw.error ?? "unknown"}`);
    return { ok: false, reason: "error", steps, spentUsd: spent, findings: gate.findings, blocking: gate.blocking, initialFindings, measurements: gate.measurements };
  }
  gate = await cb.measure();
  if (gate.blocking.length === 0) {
    return { ok: true, reason: "repaired", steps: [...steps, "passed after L3"], spentUsd: spent, findings: gate.findings, blocking: [], initialFindings, measurements: gate.measurements };
  }

  // ── L4: ladder exhausted — caller hard-fails ─────────────────────────────
  log(`ladder exhausted — ${gate.blocking.length} blocking finding(s) remain on scene(s) ${scenesOf(gate.blocking).join(", ")}`);
  return { ok: false, reason: "ladder-exhausted", steps, spentUsd: spent, findings: gate.findings, blocking: gate.blocking, initialFindings, measurements: gate.measurements };
};
