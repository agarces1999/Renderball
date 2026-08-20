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

/**
 * The ladder's WALL-CLOCK budget (default 150s). The cost ceiling bounds
 * dollars; nothing bounded MINUTES, and the measured worst case was a
 * founder-watched Klarna build spending 12 of its 15 minutes in here. The
 * budget is checked before each PAID step, same posture as the cost guard.
 */
export const REPAIR_BUDGET_MS = (() => {
  const v = Number(process.env.RB_REPAIR_BUDGET_MS);
  return Number.isFinite(v) && v > 0 ? v : 150_000;
})();

/**
 * L3 (script rewrite + FULL REBUILD) is OFF the live path by default —
 * `RB_REPAIR_REBUILD=on` re-enables it (dogfood/offline lanes). Measured
 * (2026-08-13, gate telemetry): the 15-23-minute builds are exactly the
 * L3 runs, and on the document that hit it three times the rebuild never
 * produced a clean deck — each rewrite re-rolled the layout dice and
 * surfaced NEW findings (overflow → overlap → barbell). The research
 * corroborates: repair value collapses after two passes, and loops converge
 * only when a step must STRICTLY improve the measured defect count to keep
 * going — which is also enforced below.
 */
export const rebuildRungEnabled = (
  env: Record<string, string | undefined> = process.env,
): boolean => String(env.RB_REPAIR_REBUILD ?? "").trim().toLowerCase() === "on";

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
    | "time-budget"
    | "no-progress"
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

const repairInstruction = (sceneFindings: RenderTruthFinding[]): string => {
  const parts: string[] = [];
  const rt = sceneFindings.filter((f) => f.kind === "rule-through-text");
  const deco = sceneFindings.filter((f) => f.kind === "decoration-over-text");
  const of = sceneFindings.filter(
    (f) => f.kind !== "stranded-hero" && f.kind !== "rule-through-text" && f.kind !== "decoration-over-text",
  );
  const sh = sceneFindings.filter((f) => f.kind === "stranded-hero");
  if (rt.length > 0) {
    // Its own instruction — the generic "make it fit" text would send the
    // model chasing canvas bounds when the defect is a decoration collision.
    parts.push(
      `A decorative accent rule STRIKES THROUGH text on this scene (measured on the real render): ${rt
        .map((f) => f.detail)
        .join("; ")}. Fix the RULE, keep the text: place the rule in normal flow BELOW the full text block (e.g. marginTop on a sibling), never at an absolute offset that assumes the text stays on one line — wrapped text must push it down.`,
    );
  }
  if (of.length > 0) {
    const detail = of.map((f) => f.detail).join("; ");
    parts.push(
      `This scene has content rendered OUTSIDE the 1920×1080 canvas (it gets clipped): ${detail}. ` +
        `Fix the LAYOUT so every element fits within the canvas with a safe margin: narrow or wrap wide rows, ` +
        `reduce fixed widths, re-anchor off-canvas elements, shrink horizontal flows. Keep the copy and the brand; just make it fit.`,
    );
  }
  if (deco.length > 0) {
    // The motif is REQUIRED on every scene (the throughline gate fires when it
    // is missing), so the fix is never "delete it" — it is to give it its own
    // air. Say that explicitly or the model will simply drop it and trade one
    // finding for another.
    parts.push(
      `Decoration and copy collide on this scene (measured on the real render): ${deco
        .map((f) => f.detail)
        .join("; ")}. KEEP the throughline motif — it is required — but MOVE it into empty canvas so it no longer crosses any text or card: shift its anchor to a clear margin, or shrink it. Do not delete it, and do not push the copy off-canvas to make room.`,
    );
  }
  if (sh.length > 0) {
    // The gate's detail strings already carry the concrete numeric fix
    // (measured box + the contract numbers) — pass them through verbatim.
    parts.push(
      `This scene FAILS the layout composer contract (measured on the real render): ${sh.map((f) => f.detail).join(" | ")} ` +
        `Recompose the scene around its hero visual — the diegetic object is the anchor of the frame, never an afterthought at an edge.`,
    );
  }
  return parts.join("\n\n");
};

/**
 * Run the self-repair ladder against an already-built+written genDir.
 * `spentSoFarUsd` is the cost of the initial build (counts toward the ceiling).
 */
export const repairRenderTruth = async (
  cb: RepairCallbacks,
  opts: {
    spentSoFarUsd?: number;
    ceilingUsd?: number;
    model?: string;
    /** Wall-clock budget override (tests); default REPAIR_BUDGET_MS. */
    budgetMs?: number;
    /** L3 rebuild-rung override (tests); default rebuildRungEnabled(). */
    allowRebuild?: boolean;
  } = {},
): Promise<RepairResult> => {
  const ceiling = opts.ceilingUsd ?? COST_CEILING_USD;
  const budgetMs = opts.budgetMs ?? REPAIR_BUDGET_MS;
  const allowRebuild = opts.allowRebuild ?? rebuildRungEnabled();
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

  // Budget guards run before each PAID step: stop if we're already at/over
  // the cost ceiling or the wall-clock budget (a paid step would breach it).
  // Conservative — stops at the line, never past it.
  const overBudget = () => spent >= ceiling;
  const t0 = Date.now();
  const outOfTime = () => Date.now() - t0 >= budgetMs;

  // ── L1 + L2: design retries on the failing scenes ────────────────────────
  for (let attempt = 1; attempt <= MAX_DESIGN_RETRIES; attempt++) {
    if (overBudget()) {
      log(`cost ceiling $${ceiling} reached ($${spent.toFixed(2)} spent) — stopping before L${attempt} design retry`);
      return { ok: false, reason: "cost-ceiling", steps, spentUsd: spent, findings: gate.findings, blocking: gate.blocking, initialFindings, measurements: gate.measurements };
    }
    if (outOfTime()) {
      log(`repair time budget ${Math.round(budgetMs / 1000)}s reached — stopping before L${attempt} design retry`);
      return { ok: false, reason: "time-budget", steps, spentUsd: spent, findings: gate.findings, blocking: gate.blocking, initialFindings, measurements: gate.measurements };
    }
    const before = gate.blocking.length;
    const failing = scenesOf(gate.blocking);
    log(`L${attempt}: regenerating design for scene(s) ${failing.join(", ")}`);
    for (const s of failing) {
      const sceneFindings = gate.blocking.filter((f) => f.scene === s);
      const r = await cb.regenScene(s, repairInstruction(sceneFindings));
      if (r.usage) spent += costOf(r.usage);
      if (!r.ok) log(`  scene ${s} regen error: ${r.error ?? "unknown"}`);
    }
    gate = await cb.measure();
    if (gate.blocking.length === 0) {
      return { ok: true, reason: "repaired", steps: [...steps, `passed after L${attempt}`], spentUsd: spent, findings: gate.findings, blocking: [], initialFindings, measurements: gate.measurements };
    }
    // STRICT IMPROVEMENT, or stop. A round that did not reduce the blocking
    // count is measured non-convergence — on the document that ran the old
    // ladder three times, every later round surfaced NEW findings while
    // burning a build's worth of tokens. Spending again on a treatment that
    // just measurably failed is not persistence, it is the meter running.
    if (gate.blocking.length >= before) {
      log(
        `L${attempt} did not improve (${before} → ${gate.blocking.length} blocking) — stopping: repairs are not converging`,
      );
      return { ok: false, reason: "no-progress", steps, spentUsd: spent, findings: gate.findings, blocking: gate.blocking, initialFindings, measurements: gate.measurements };
    }
  }

  // ── L3: rewrite the failing scenes' script (lighter concept) + rebuild ────
  // OFF the live path by default (see rebuildRungEnabled) — the full rebuild
  // re-rolls every page's layout and was measured to surface new findings
  // rather than converge. Dogfood/offline lanes opt back in.
  if (!allowRebuild) {
    log(`L3 rebuild rung disabled on this path — stopping after ${MAX_DESIGN_RETRIES} scoped rounds`);
    return { ok: false, reason: "ladder-exhausted", steps, spentUsd: spent, findings: gate.findings, blocking: gate.blocking, initialFindings, measurements: gate.measurements };
  }
  if (overBudget()) {
    log(`cost ceiling $${ceiling} reached ($${spent.toFixed(2)} spent) — stopping before L3 script rewrite`);
    return { ok: false, reason: "cost-ceiling", steps, spentUsd: spent, findings: gate.findings, blocking: gate.blocking, initialFindings, measurements: gate.measurements };
  }
  if (outOfTime()) {
    log(`repair time budget ${Math.round(budgetMs / 1000)}s reached — stopping before L3 script rewrite`);
    return { ok: false, reason: "time-budget", steps, spentUsd: spent, findings: gate.findings, blocking: gate.blocking, initialFindings, measurements: gate.measurements };
  }
  const failing = scenesOf(gate.blocking);
  // The L3 reason must match the DEFECT. "Simplify to fewer, smaller elements"
  // is right for overflow/density, but INVERTED for a stranded hero (the fix is
  // a BIGGER, recomposed hero) — telling the model to shrink would entrench it.
  const onlyStranded = gate.blocking.every((f) => f.kind === "stranded-hero");
  const l3Reason = onlyStranded
    ? `These scenes fail the layout composer contract even after layout retries — the main visual is too small or stranded at an edge. RECOMPOSE around a larger hero visual anchored in the frame (not fewer/smaller elements); the hero is the subject of the scene.`
    : `These scenes render content off-canvas even after layout retries — the visual_concept is too dense to fit 1920×1080. Simplify them to fewer, smaller elements that fit.`;
  log(`L3: rewriting script for scene(s) ${failing.join(", ")} (${onlyStranded ? "hero too small/stranded" : "concept too dense"}) + rebuild`);
  const rw = await cb.rewriteScript(failing, l3Reason);
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
