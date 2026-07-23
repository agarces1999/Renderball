/**
 * P2 LAYOUT BAKE-OFF — the spatial plan's DECISION GATE (2026-07-18).
 *
 * ONE question, answered with evidence: does having the composition head emit a
 * `grid-template-areas` ASCII block beat having it emit raw pixel bounds?
 * Nothing in the plan's research corpus answers this for OUR head, OUR prompt
 * and OUR validator — it is the one real evidence gap, and P3 (the solver
 * rewrite) is gated on the answer.
 *
 *   ARM A (control)   RB_HEAD_INTENT=pixel — the shipped head, unchanged.
 *   ARM B (treatment) RB_HEAD_INTENT=grid  — the same head with ONLY its
 *                     spatial blocks swapped for the grid dialect
 *                     (lib/agents/grid-intent.ts), then converted
 *                     deterministically to the same pixel bounds.
 *
 * WHAT MAKES THIS A FAIR TEST
 * - SAME SCRIPTS. The sample is 31 CACHED briefs with CACHED generated scripts
 *   (.data/briefs + .data/scripts). Script generation is the expensive stage and
 *   is identical across arms, so it is not re-run; neither arm can ever see a
 *   different script than the other.
 * - SAME PROMPT except the one variable. Interior inventories, copy ownership,
 *   accent discipline, register shapes, the singularity budget and the worked
 *   example's non-spatial content are byte-identical between arms.
 * - SAME SCORER. Both arms produce a `SceneComposition` carrying pixel bounds,
 *   so `composeSceneLayout` + `validateScenePlan` (via lib/agents/plan-validate)
 *   cannot tell them apart. No new violation checker was written for this.
 * - SAME ORDER, same model, same token ceiling, same retry budget.
 *
 * WHAT THIS TEST CANNOT DECIDE — read before trusting the headline number.
 * Arm B gets CONTAINMENT and inter-element DISJOINTNESS for free: its lattice
 * lives inside the safe area and a grid cell has one owner. Those two counts
 * going to zero is a property of the REPRESENTATION, not evidence that the model
 * composed better, and the report labels them as structural gimmes. The
 * genuinely contested metrics are the format-failure rate, the void size, the
 * stranded-hero and budget contracts, collisions with the composer's
 * deterministic slots (chrome bar, throughline anchor), and tokens.
 *
 *   set -a && source .env.local && set +a && node scripts/layout-bakeoff.mjs
 *
 * Env: RB_BAKEOFF_LIMIT (first N briefs — smoke runs), RB_BAKEOFF_CONCURRENCY,
 * RB_BAKEOFF_OUT, RB_CAST_MODEL.
 */
import { promises as fs } from "fs";
import path from "path";
import {
  generateComposition,
  type CompositionCaller,
  type HeadIntent,
} from "../lib/agents/composition-head";
import { checkSceneComposition } from "../lib/agents/schema-validator";
import { validateAndRepairPlans } from "../lib/agents/plan-validate";
import {
  composeSceneLayout,
  validateScenePlan,
  type Aspect,
  type PlanViolation,
} from "../lib/agents/layout-composer";
import { voidFraction, GRID } from "../lib/agents/grid-intent";
import { resolveCanvasPlan, signatureWithLogoFallback, brandShortName } from "../lib/crawl/brand-identity";
import { deriveCrawlTheme } from "../lib/render/crawl-theme";
import { neutralizeInk } from "../lib/agents/cast-build";
import { castCall } from "../lib/llm/cast-provider";
import type { Script, Scene, SceneComposition } from "../src/schema";

// ─── The sample ─────────────────────────────────────────────────────────────

/**
 * 31 cached briefs, ONE PER BRAND, hardcoded so the run is exactly
 * reproducible. Selection rule, applied to all 297 cached briefs:
 *   1. brand_extract present and ok (the head needs real brand + palette),
 *   2. a cached generated script in .data/scripts on the CURRENT schema
 *      (scene.content + scene.visual_concept present),
 *   3. one brief per brand host, preferring scripts that carry a narrative and
 *      a register on every scene, tie-broken by lowest ULID,
 *   4. brands whose script had NEITHER a narrative NOR any register dropped
 *      (apple, salesforce, slack, zolvo — the four weakest, all pre-narrative).
 *
 * Spread: 27× 16:9, 2× 9:16 (falabella-ES, vercel), 2× 1:1 (notion, oatly);
 * 3–5 scenes; dark canvases (linear #08090a, supabase #1E1E1E, sentry #6A5FC1)
 * and light ones (falabella/klarna #ffffff, posthog #E5E7E0); registers spanning
 * full-bleed / split / list / quote / stat / centered; one non-English brand.
 */
const SAMPLE: string[] = [
  "01KWJ5HG6SYNQVS48VT62KWD48", // arc.net
  "01KWZ1FXHWJHY3G4TE3JTG119Z", // cal.com
  "01KV4TD5R9BDKWZ32KV4PC4F27", // cloudflare.com
  "01KTJG9D33ANBN1M03HKEMX9XA", // corgi.insure
  "01KWTM7M5AVH10QD8QEM6KKBHJ", // duolingo.com
  "01KWJ23CKW9BBE4YENMTXK3QAX", // elevenlabs.io
  "01KT7ZEVFJWHFA0JT199R9Y58P", // falabella.com  (9:16, Spanish)
  "01KT4NX3F0XTMMFV5A88F9VC9K", // figma.com
  "01KWR49KR78FWM0N84732YB7RF", // framer.com
  "01KTA3D9P1NKXDW7M79BQB4B54", // fusefinance.com
  "01KVYRVVHFPNR2TDMEQCK7H2HV", // glossier.com
  "01KWTTE1XSW6BXXKSXPTBX9HDH", // klarna.com
  "01KTP8ZX05AESK9PFFXHZBZZA0", // linear.app     (dark canvas)
  "01KTCTCVXM31QKR59TNWGNTG3E", // liquiddeath.com
  "01KWTEYD12B9D24MRTV3SEPGW6", // loom.com
  "01KT4NGY72ZTSRKV6FE2C4PMD4", // notion.com     (1:1)
  "01KT5FXNHV3X3MRQN9B3HH0D4M", // oatly.com      (1:1)
  "01KT7YQB5PM51V7FR32QTEV78Z", // patagonia.com
  "01KTQJ09BDFJKV5YC9ZM43A4HJ", // posthog.com    (light canvas)
  "01KV1B1P4SZCG77WXNBHT2VV9B", // ramp.com
  "01KTQFVMY5W3G9EG8RE144KG6S", // raycast.com
  "01KVYFG858VJDBHQM5Y6DHJ3FB", // robinhood.com
  "01KTQGZZPV99MANAHS0K2E15NK", // sentry.io
  "01KVZ6ZNMZBMGHMT62GW1DA9W0", // shopify.com
  "01KWFTGG67VEKE66TV2VH5AQ1T", // spotify.com
  "01KVZFHBCTJFGQ426YZKHVWSN3", // stripe.com
  "01KTQ67JQ305PYANX4JTPBAE3P", // supabase.com   (dark canvas)
  "01KWR8Z4JCGGMWN4HR5EC8KR2V", // superhuman.com
  "01KTVZA5F1J1R950M02QE54X7X", // tailscale.com
  "01KT6WXWCNRB7GEDCXHJTEZ4CH", // tonyschocolonely.com
  "01KT4P770WH6Q8AG469EF1MQVB", // vercel.com     (9:16)
];

/**
 * The arms to RUN this invocation. Arm C (2026-07-18) was run alone —
 * `RB_BAKEOFF_ARMS=cells RB_BAKEOFF_MERGE=.data/dogfood/BAKEOFF_P2.ab.json` —
 * because arms A and B were already measured on this exact sample with this
 * exact code, and re-running them would have spent ~$5.50 to reproduce numbers
 * we already hold. `RB_BAKEOFF_MERGE` folds the stored rows back in so the
 * report is a genuine three-arm comparison rather than an orphan.
 *
 * THE CAVEAT THIS CREATES, stated plainly: arm C's rows are from a LATER run
 * than A's and B's, against the same pinned model string. Nothing else moved —
 * same briefs, same cached scripts, same scorer, same retry budget — but the
 * provider's weights behind that string are not under our control, so a
 * same-session run would be marginally stronger evidence than this is.
 */
const ALL_ARMS: HeadIntent[] = ["pixel", "grid", "cells"];
const ARMS: HeadIntent[] = (process.env.RB_BAKEOFF_ARMS ?? "pixel,grid,cells")
  .split(",")
  .map((s) => s.trim())
  .filter((s): s is HeadIntent => (ALL_ARMS as string[]).includes(s));

/** Path to a prior BAKEOFF json whose rows are merged in for arms NOT run now. */
const MERGE_FROM = process.env.RB_BAKEOFF_MERGE ?? "";

const ARM_LABEL: Record<HeadIntent, string> = {
  pixel: "arm A (pixel)",
  grid: "arm B (grid ASCII)",
  cells: "arm C (int cells)",
};

const CAST_MODEL = process.env.RB_CAST_MODEL ?? "accounts/fireworks/routers/glm-5p2-fast";
const OUT_DIR = process.env.RB_BAKEOFF_OUT ?? path.join(process.cwd(), ".data", "dogfood");
const CONCURRENCY = Math.max(1, Number(process.env.RB_BAKEOFF_CONCURRENCY ?? 4));
const LIMIT = Number(process.env.RB_BAKEOFF_LIMIT ?? 0);

/** Fireworks GLM-5.2 list pricing, USD per million tokens (2026-07). An
 *  ESTIMATE for the cost line — the token counts are measured, the dollars are
 *  derived. */
const USD_PER_M_IN = 0.55;
const USD_PER_M_OUT = 2.19;

const t0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

// ─── Scoring ────────────────────────────────────────────────────────────────

type ViolationKind = PlanViolation["kind"];
const KINDS: ViolationKind[] = ["containment", "disjointness", "stranded-hero", "budget"];

interface SceneScore {
  scene: number;
  register: string;
  violations: Record<ViolationKind, number>;
  total: number;
  /** Largest contiguous unclaimed rectangle, as a fraction of the safe area. */
  voidFrac: number;
  /** Non-atmosphere elements the head left without usable bounds. Arm A's
   *  analogue of an invalid grid declaration: the composer silently reverts
   *  those to its geometry table, so the head's frame intent is lost. */
  unboundElements: number;
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const emptyKinds = (): Record<ViolationKind, number> =>
  ({ containment: 0, disjointness: 0, "stranded-hero": 0, budget: 0 });

/**
 * Score a set of composed scenes WITHOUT repairing them — this is what the head
 * AUTHORED, which is the composition-quality signal. Deep-cloned first, because
 * plan-validate's repair ladder mutates compositions in place and we want the
 * pre-repair truth.
 *
 * The void is measured on the COMPOSED PLAN (not on either arm's native
 * representation) so neither arm gets a home-field rasterization. Atmosphere is
 * excluded — the full-bleed base layer covers every cell and would drive every
 * void to zero, measuring nothing. Chrome is included: it is real painted mass.
 */
const scoreScenes = (
  scenesIn: Scene[],
  aspect: Aspect,
  hasThroughline: boolean,
): SceneScore[] => {
  const scenes = clone(scenesIn);
  return scenes.map((scene, i) => {
    const comp = scene.composition as SceneComposition | undefined;
    const content = (scene.content ?? {}) as Record<string, unknown>;
    const violations = emptyKinds();
    let voidFrac = 0;
    let unbound = 0;

    if (comp && Array.isArray(comp.elements) && comp.elements.length > 0) {
      for (const el of comp.elements) {
        if (el?.role === "atmosphere") continue;
        const b = el?.bounds;
        const ok =
          !!b &&
          [b.x, b.y, b.w, b.h].every((n) => typeof n === "number" && Number.isFinite(n)) &&
          b.w > 0 &&
          b.h > 0;
        if (!ok) unbound++;
      }
    }

    const plan = composeSceneLayout(
      { register: scene.register, content, composition: comp },
      aspect,
      { hasThroughline },
    );
    for (const v of validateScenePlan(plan, aspect, { composition: comp, content })) {
      violations[v.kind]++;
    }
    voidFrac = voidFraction(
      plan.elements.filter((e) => e.kind !== "atmosphere").map((e) => e.bounds),
      aspect,
    ).fraction;

    return {
      scene: i,
      register: plan.register,
      violations,
      total: KINDS.reduce((n, k) => n + violations[k], 0),
      voidFrac,
      unboundElements: unbound,
    };
  });
};

/**
 * Classify one head-loop error line into the bake-off's failure taxonomy — a
 * PARSE / INVALID-DECLARATION defect, as opposed to a taste or geometry
 * violation. The arm-C clauses (`whole number`, `runs off the lattice`,
 * `0-based`, `at least 1`, `claim overlapping cells`, `declares no cell
 * rectangle`) are its analogues of arm B's row-length and rectangularity rules,
 * and they include one defect class arm B could NOT have — undeclared overlap,
 * which arm B got free by construction. Arm C is therefore scored against a
 * strictly LARGER set of format failures than arm B, never a smaller one.
 */
const isFormatFailure = (e: string): boolean =>
  /JSON\.parse failed|no JSON array found|not an array|are not SceneComposition|not a solid rectangle|characters — every row|rows — it must have|no areas at all|declares no area|claims area|is drawn in the grid|declares no elements|cells carry a single letter|not an object\.|declares no cell rectangle|must be a whole number|runs off the lattice|the lattice is 0-based|must be at least 1|claim overlapping cells/.test(
    e,
  );

// ─── One arm on one brief ───────────────────────────────────────────────────

interface ArmResult {
  arm: HeadIntent;
  brief: string;
  brand: string;
  aspect: Aspect;
  sceneCount: number;
  attempts: number;
  /** Head-loop errors, per attempt, verbatim. */
  errors: string[];
  formatFailureAttempts: number;
  firstAttemptParsedClean: boolean;
  /** What the head AUTHORED on attempt 1, pre-repair. */
  authored: SceneScore[] | null;
  /** What SHIPS after P1's deterministic ladder + the head's retries. */
  final: SceneScore[];
  residualErrors: number;
  tokensIn: number;
  tokensOut: number;
  seconds: number;
  failure?: string;
}

interface BriefContext {
  brief: string;
  brand: string;
  aspect: Aspect;
  script: Script;
  hasThroughline: boolean;
  canvasBackground: string;
  paletteHint: string;
  designNotes: string;
}

const loadContext = async (briefId: string): Promise<BriefContext> => {
  const briefRaw = await fs.readFile(path.join(process.cwd(), ".data", "briefs", `${briefId}.json`), "utf8");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b: any = JSON.parse(briefRaw);
  const scriptRaw = await fs.readFile(path.join(process.cwd(), ".data", "scripts", `${b.script_id}.json`), "utf8");
  const stored = JSON.parse(scriptRaw) as Script;

  const be = b?.brand_extract?.ok ? b.brand_extract : undefined;
  const brand = be ? brandShortName(be) : "Brand";
  const aspect = (["16:9", "9:16", "1:1"].includes(stored.config?.aspect_ratio ?? "")
    ? stored.config!.aspect_ratio
    : "16:9") as Aspect;

  const canvasPlan = resolveCanvasPlan(be);
  const signature =
    signatureWithLogoFallback(be?.palette ?? [], be?.theme_color, be?.logo_color) ??
    be?.theme_color ??
    (be?.palette ?? [])[0] ??
    "#666666";
  const derived = deriveCrawlTheme(be, canvasPlan.background, canvasPlan.mode, signature, be?.palette ?? []);
  const theme = neutralizeInk(derived.theme).theme;

  // Strip any stored composition — both arms author from a clean slate.
  const script: Script = { ...stored, scenes: stored.scenes.map((s) => ({ ...s, composition: undefined })) };

  return {
    brief: briefId,
    brand,
    aspect,
    script,
    hasThroughline: !!script.narrative?.throughline?.trim(),
    canvasBackground: canvasPlan.background,
    paletteHint: `canvas ${canvasPlan.background} (${canvasPlan.mode}), signature accent ${signature}, brand palette: ${(be?.palette ?? []).join(", ")}`,
    designNotes: `Design system consts downstream: PALETTE (CANVAS/INK/ACCENT/MUTED/SOFT_NEUTRAL/CARD_FILL/WHITE), shared keyframes (glowBreathe, drift1-3, drawWidth, fadeRise, scaleIn). Fonts: display ${theme.fonts.display}, body ${theme.fonts.body}.`,
  };
};

const runArm = async (ctx: BriefContext, arm: HeadIntent): Promise<ArmResult> => {
  const started = Date.now();
  let tokensIn = 0;
  let tokensOut = 0;
  let authored: SceneScore[] | null = null;
  // Counted HERE, not from the result: a terminal unparseable failure THROWS,
  // so the result's attempt count never arrives and the failure-rate
  // denominator would silently shrink for exactly the arm that failed most.
  let calls = 0;

  const caller: CompositionCaller = async (call) => {
    calls++;
    const r = await castCall({
      system: call.system,
      user: call.user,
      maxTokens: call.maxTokens,
      model: CAST_MODEL,
      effort: call.effort === "none" ? "low" : call.effort,
    });
    tokensIn += r.inputTokens;
    tokensOut += r.outputTokens;
    return { text: r.text };
  };

  const base: Omit<ArmResult, "attempts" | "errors" | "formatFailureAttempts" | "firstAttemptParsedClean" | "authored" | "final" | "residualErrors"> = {
    arm,
    brief: ctx.brief,
    brand: ctx.brand,
    aspect: ctx.aspect,
    sceneCount: ctx.script.scenes.length,
    tokensIn,
    tokensOut,
    seconds: 0,
  };

  try {
    const composed = await generateComposition({
      script: ctx.script,
      caller,
      intent: arm,
      aspect: ctx.aspect,
      brandName: ctx.brand,
      paletteHint: ctx.paletteHint,
      designNotes: ctx.designNotes,
      // IDENTICAL for both arms — the same production validate stack the real
      // build path injects (fullpipe-render.ts:136). Capturing the first
      // attempt's scenes HERE, at the top of the callback, is the only place the
      // pre-repair truth exists: plan-validate repairs in place further down.
      validate: (scenes: Scene[]) => {
        if (authored === null) authored = scoreScenes(scenes, ctx.aspect, ctx.hasThroughline);
        return [
          ...checkSceneComposition(scenes, { aspect: ctx.aspect, canvasBackground: ctx.canvasBackground }),
          ...validateAndRepairPlans(scenes, { aspect: ctx.aspect, hasThroughline: ctx.hasThroughline }).errors,
        ];
      },
    });

    const final = scoreScenes(composed.scenes, ctx.aspect, ctx.hasThroughline);
    const attemptErrors = composed.errors;
    // An attempt "failed on format" when any of its errors is a parse / invalid
    // declaration — as opposed to a taste or geometry violation.
    const failedAttempts = new Set<number>();
    for (const e of attemptErrors) {
      const m = /^attempt (\d+):/.exec(e);
      if (m && isFormatFailure(e)) failedAttempts.add(Number(m[1]));
    }

    return {
      ...base,
      attempts: composed.attempts,
      errors: attemptErrors,
      formatFailureAttempts: failedAttempts.size,
      firstAttemptParsedClean: !failedAttempts.has(1),
      authored,
      final,
      residualErrors: checkSceneComposition(composed.scenes, {
        aspect: ctx.aspect,
        canvasBackground: ctx.canvasBackground,
      }).length,
      tokensIn,
      tokensOut,
      seconds: (Date.now() - started) / 1000,
    };
  } catch (err) {
    return {
      ...base,
      attempts: calls,
      errors: [`terminal: ${err instanceof Error ? err.message : String(err)}`],
      // Every attempt of a terminal-unparseable brief was a format failure.
      formatFailureAttempts: calls,
      firstAttemptParsedClean: false,
      authored,
      final: [],
      residualErrors: 0,
      tokensIn,
      tokensOut,
      seconds: (Date.now() - started) / 1000,
      failure: err instanceof Error ? err.message : String(err),
    };
  }
};

// ─── Aggregation ────────────────────────────────────────────────────────────

interface Agg {
  arm: HeadIntent;
  briefs: number;
  scenes: number;
  attempts: number;
  hardFailures: number;
  formatFailureAttempts: number;
  totalAttempts: number;
  firstPassCleanBriefs: number;
  authoredViolations: Record<ViolationKind, number>;
  authoredTotal: number;
  authoredPerScene: number;
  finalViolations: Record<ViolationKind, number>;
  finalTotal: number;
  finalPerScene: number;
  unboundElements: number;
  voidMean: number;
  voidP90: number;
  voidWorst: number;
  voidOver25: number;
  tokensIn: number;
  tokensOut: number;
  usd: number;
  seconds: number;
}

const quantile = (xs: number[], q: number): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.floor(q * (s.length - 1)));
  return s[i];
};

const aggregate = (rows: ArmResult[], arm: HeadIntent): Agg => {
  const mine = rows.filter((r) => r.arm === arm);
  const authoredScenes = mine.flatMap((r) => r.authored ?? []);
  const finalScenes = mine.flatMap((r) => r.final);
  const voids = authoredScenes.map((s) => s.voidFrac);

  const sumKinds = (scenes: SceneScore[]): Record<ViolationKind, number> => {
    const out = emptyKinds();
    for (const s of scenes) for (const k of KINDS) out[k] += s.violations[k];
    return out;
  };
  const authoredViolations = sumKinds(authoredScenes);
  const finalViolations = sumKinds(finalScenes);
  const authoredTotal = KINDS.reduce((n, k) => n + authoredViolations[k], 0);
  const finalTotal = KINDS.reduce((n, k) => n + finalViolations[k], 0);
  const tokensIn = mine.reduce((n, r) => n + r.tokensIn, 0);
  const tokensOut = mine.reduce((n, r) => n + r.tokensOut, 0);

  return {
    arm,
    briefs: mine.length,
    scenes: authoredScenes.length,
    attempts: mine.reduce((n, r) => n + r.attempts, 0),
    hardFailures: mine.filter((r) => r.failure).length,
    formatFailureAttempts: mine.reduce((n, r) => n + r.formatFailureAttempts, 0),
    totalAttempts: mine.reduce((n, r) => n + Math.max(r.attempts, 1), 0),
    firstPassCleanBriefs: mine.filter((r) => r.firstAttemptParsedClean && !r.failure).length,
    authoredViolations,
    authoredTotal,
    authoredPerScene: authoredScenes.length ? authoredTotal / authoredScenes.length : 0,
    finalViolations,
    finalTotal,
    finalPerScene: finalScenes.length ? finalTotal / finalScenes.length : 0,
    unboundElements: authoredScenes.reduce((n, s) => n + s.unboundElements, 0),
    voidMean: voids.length ? voids.reduce((a, b) => a + b, 0) / voids.length : 0,
    voidP90: quantile(voids, 0.9),
    voidWorst: voids.length ? Math.max(...voids) : 0,
    voidOver25: voids.filter((v) => v > 0.25).length,
    tokensIn,
    tokensOut,
    usd: (tokensIn / 1e6) * USD_PER_M_IN + (tokensOut / 1e6) * USD_PER_M_OUT,
    seconds: mine.reduce((n, r) => n + r.seconds, 0),
  };
};

/**
 * Paired difference across the briefs both arms completed, with a normal-
 * approximation 95% interval on the mean. With n≈31 this is a coarse
 * instrument — it is here to say "this clears noise" or "this does not", not to
 * produce a publishable p-value.
 */
const pairedDelta = (
  rows: ArmResult[],
  pick: (r: ArmResult) => number,
  arm: HeadIntent,
  baseline: HeadIntent = "pixel",
): { mean: number; ci95: number; n: number } => {
  const byBrief = new Map<string, Partial<Record<HeadIntent, ArmResult>>>();
  for (const r of rows) {
    const slot = byBrief.get(r.brief) ?? {};
    slot[r.arm] = r;
    byBrief.set(r.brief, slot);
  }
  const diffs: number[] = [];
  for (const slot of byBrief.values()) {
    const a = slot[baseline];
    const b = slot[arm];
    // BOTH arms must have COMPLETED the brief. A hard-failed brief contributes
    // no data, so pairing it would silently compare an arm's successes against
    // the other arm's full spread — the survivorship trap this column exists to
    // avoid.
    if (a && b && !a.failure && !b.failure) diffs.push(pick(b) - pick(a));
  }
  const n = diffs.length;
  if (n < 2) return { mean: 0, ci95: 0, n };
  const mean = diffs.reduce((a, b) => a + b, 0) / n;
  const varc = diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  return { mean, ci95: 1.96 * Math.sqrt(varc / n), n };
};

const perSceneOf = (r: ArmResult, kinds: ViolationKind[]): number => {
  const scenes = r.authored ?? [];
  if (scenes.length === 0) return 0;
  return scenes.reduce((n, s) => n + kinds.reduce((m, k) => m + s.violations[k], 0), 0) / scenes.length;
};

const meanVoidOf = (r: ArmResult): number => {
  const scenes = r.authored ?? [];
  return scenes.length ? scenes.reduce((n, s) => n + s.voidFrac, 0) / scenes.length : 0;
};

// ─── Report ─────────────────────────────────────────────────────────────────

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const f2 = (x: number) => x.toFixed(2);
const f3 = (x: number) => x.toFixed(3);

/**
 * An arm that HARD-FAILED a brief contributes no scenes, so every per-scene
 * average silently divides zero by zero and prints "0.00" — which reads as a
 * perfect score when it actually means "no data". Every per-scene cell goes
 * through this, so a missing measurement can never masquerade as a good one.
 */
const orNA = (agg: Agg, render: () => string): string => (agg.scenes === 0 ? "n/a *(no data)*" : render());

/**
 * The report, generalized over N arms (2026-07-18, arm C). Arms appear as
 * columns; every non-baseline arm gets a PAIRED Δ against arm A computed only
 * over briefs BOTH of them completed. Nothing here special-cases an arm — a
 * fourth representation would slot in by extending HeadIntent alone.
 */
const buildReport = (rows: ArmResult[], aggs: Record<HeadIntent, Agg>, arms: HeadIntent[]): string => {
  const present = arms.filter((a) => aggs[a] && aggs[a].briefs > 0);
  const baseline: HeadIntent = present.includes("pixel") ? "pixel" : present[0];
  const others = present.filter((a) => a !== baseline);

  const deltas = (pick: (r: ArmResult) => number) =>
    others.map((a) => ({ arm: a, d: pairedDelta(rows, pick, a, baseline) }));

  const dAll = deltas((r) => perSceneOf(r, KINDS));
  const dContested = deltas((r) => perSceneOf(r, ["stranded-hero", "budget"]));
  const dVoid = deltas(meanVoidOf);
  const dOut = deltas((r) => r.tokensOut);

  /** "clears noise" = the 95% interval does not straddle zero. */
  const verdict = (d: { mean: number; ci95: number }, arm: HeadIntent, lowerIsBetter = true): string => {
    const clears = Math.abs(d.mean) > d.ci95 && d.ci95 > 0;
    if (!clears) return "within noise";
    const better = lowerIsBetter ? d.mean < 0 : d.mean > 0;
    return better ? `**${arm} better**` : `**${baseline} better**`;
  };

  const head = (label: string) => `| ${label} | ${present.map((a) => ARM_LABEL[a]).join(" | ")} |`;
  const rule = () => `|---|${present.map(() => "---|").join("")}`;
  const row = (label: string, cell: (a: HeadIntent) => string) =>
    `| ${label} | ${present.map(cell).join(" | ")} |`;

  const deltaBlock = (
    title: string,
    ds: { arm: HeadIntent; d: { mean: number; ci95: number; n: number } }[],
    fmt: (x: number) => string,
    lowerIsBetter = true,
  ) =>
    ds
      .map(
        ({ arm, d }) =>
          `| ${title} — Δ ${arm} − ${baseline} | ${fmt(d.mean)} ± ${fmt(d.ci95)} | n=${d.n} paired | ${verdict(d, arm, lowerIsBetter)} |`,
      )
      .join("\n");

  const anyFail = present.some((a) => aggs[a].hardFailures > 0);
  const survivorWarning = anyFail
    ? `
> **⚠️ SURVIVORSHIP WARNING — read before comparing any per-scene number.**
> Hard failures (no parseable output after 3 attempts) by arm:
> ${present.map((a) => `${ARM_LABEL[a]} ${aggs[a].hardFailures}/${aggs[a].briefs}`).join(", ")}.
> A failed brief contributes NO violation and NO void data, so **every per-scene
> average below is conditional on that arm having succeeded** — scenes scored:
> ${present.map((a) => `${ARM_LABEL[a]} ${aggs[a].scenes}`).join(", ")}. An arm that fails the hard
> briefs and succeeds only on the easy ones will look better than it is. The
> paired Δ rows are computed ONLY over briefs BOTH arms completed, and are the
> only like-for-like comparison here. **A hard failure is the worst possible
> outcome in production — it ships no frame at all — so the failure count
> outranks every quality metric below it.**
`
    : "";

  const bestOf = (get: (a: Agg) => number, lowerIsBetter = true): HeadIntent => {
    let best = present[0];
    for (const a of present) {
      const better = lowerIsBetter ? get(aggs[a]) < get(aggs[best]) : get(aggs[a]) > get(aggs[best]);
      if (better) best = a;
    }
    return best;
  };
  const fmtBest = (get: (a: Agg) => number, lowerIsBetter = true) => {
    const b = bestOf(get, lowerIsBetter);
    const tie = present.every((a) => get(aggs[a]) === get(aggs[b]));
    return tie ? "tie" : `**${ARM_LABEL[b]} better**`;
  };

  return `# P2 layout bake-off — pixel bounds vs grid ASCII vs integer cells

Run ${new Date().toISOString()} · model \`${CAST_MODEL}\` · ${aggs[baseline].briefs} briefs
Scenes scored: ${present.map((a) => `${ARM_LABEL[a]} ${aggs[a].scenes}`).join(", ")}.
Machine-readable: \`BAKEOFF_P2.json\` (per-brief rows + every head error verbatim).

**THE THREE ARMS.** A = the shipped head, raw pixel \`{x,y,w,h}\`. B = the same
head emitting a \`grid-template-areas\` ASCII picture on a ${GRID["16:9"].cols}×${GRID["16:9"].rows} square-cell
lattice. C = the SAME lattice as B, stated as four integers per element
(\`colStart\`/\`colSpan\`/\`rowStart\`/\`rowSpan\`) in the JSON schema — no picture, so
no character to miscount. **B changed two variables at once (discretization AND
ASCII encoding); C exists to separate them.**
${survivorWarning}
## Verdict — format first

Format failures outrank everything below them: an arm that cannot emit a
parseable frame ships nothing at all.

${head("metric")}
${rule()}
${row("**hard failures** (no frame after 3 attempts)", (a) => `${aggs[a].hardFailures}/${aggs[a].briefs}`)} 
${row("**format-failure rate** (attempts)", (a) => pct(aggs[a].formatFailureAttempts / Math.max(1, aggs[a].totalAttempts)))}
${row("**first-attempt clean parse** (briefs)", (a) => `${aggs[a].firstPassCleanBriefs}/${aggs[a].briefs}`)}

- hard failures: ${fmtBest((x) => x.hardFailures)}
- format-failure rate: ${fmtBest((x) => x.formatFailureAttempts / Math.max(1, x.totalAttempts))}

## Verdict — composition quality (conditional on the arm having succeeded)

${head("metric")}
${rule()}
${row("**authored violations / scene** (all kinds)", (a) => orNA(aggs[a], () => f2(aggs[a].authoredPerScene)))}
${row("**CONTESTED violations / scene** (stranded-hero + budget)", (a) => orNA(aggs[a], () => f2((aggs[a].authoredViolations["stranded-hero"] + aggs[a].authoredViolations.budget) / aggs[a].scenes)))}
${row("**residual violations / scene** (post-repair, ships)", (a) => orNA(aggs[a], () => f2(aggs[a].finalPerScene)))}
${row("**void — mean largest hole**", (a) => orNA(aggs[a], () => pct(aggs[a].voidMean)))}
${row("**void — p90 / worst**", (a) => orNA(aggs[a], () => `${pct(aggs[a].voidP90)} / ${pct(aggs[a].voidWorst)}`))}
${row("**scenes with a hole > 25% of safe area**", (a) => orNA(aggs[a], () => `${aggs[a].voidOver25}/${aggs[a].scenes}`))}
${row("**unbound elements** (no usable placement)", (a) => orNA(aggs[a], () => String(aggs[a].unboundElements)))}
${row("**head attempts**", (a) => String(aggs[a].attempts))}
${row("**tokens in / out**", (a) => `${aggs[a].tokensIn.toLocaleString()} / ${aggs[a].tokensOut.toLocaleString()}`)}
${row("**cost (est.)**", (a) => `$${aggs[a].usd.toFixed(2)}`)}
${row("**wall seconds (sum)**", (a) => String(Math.round(aggs[a].seconds)))}

### Paired differences — the only like-for-like comparison

Computed per brief, over briefs BOTH arms completed. Negative = the arm beat
${ARM_LABEL[baseline]} on a lower-is-better metric.

| metric | mean Δ ± 95% CI | pairs | reads as |
|---|---|---|---|
${deltaBlock("authored violations / scene", dAll, f2)}
${deltaBlock("contested violations / scene", dContested, f2)}
${deltaBlock("void — mean largest hole", dVoid, f3)}
${deltaBlock("output tokens", dOut, (x) => String(Math.round(x)))}

## Format-failure taxonomy

Every distinct format defect the head produced, across all attempts of all
briefs. This is the LayoutNUWA-comparable number: does a code-shaped
representation get emitted more reliably than four bare integers per box?

${head("defect")}
${rule()}
${(() => {
  const buckets: { label: string; re: RegExp }[] = [
    { label: "JSON unparseable / not an array", re: /JSON\.parse failed|no JSON array found|not an array|are not SceneComposition|not an object\./ },
    { label: "grid row wrong LENGTH *(B only — needs a picture)*", re: /characters — every row/ },
    { label: "grid wrong ROW COUNT *(B only)*", re: /rows — it must have/ },
    { label: "named area NOT RECTANGULAR *(B only)*", re: /not a solid rectangle/ },
    { label: "element claims a missing area *(B only)*", re: /claims area/ },
    { label: "area drawn but unclaimed *(B only)*", re: /is drawn in the grid/ },
    { label: "element declares no placement", re: /declares no area|declares no cell rectangle/ },
    { label: "coordinate not a whole number *(C only)*", re: /must be a whole number|must be at least 1/ },
    { label: "block runs OFF the lattice *(C only)*", re: /runs off the lattice|the lattice is 0-based/ },
    { label: "undeclared OVERLAP *(C only — free for B)*", re: /claim overlapping cells/ },
    { label: "scene count mismatch", re: /emit exactly one SceneComposition per scene/ },
  ];
  const tally = (arm: HeadIntent, re: RegExp) =>
    rows.filter((r) => r.arm === arm).reduce((n, r) => n + r.errors.filter((e) => re.test(e)).length, 0);
  return buckets
    .map((b) => `| ${b.label} | ${present.map((a) => String(tally(a, b.re))).join(" | ")} |`)
    .join("\n");
})()}

**Read the *(B only)* / *(C only)* labels.** The two discrete arms cannot fail in
the same ways: only a picture can have a wrong-length row, and only an explicit
rect can overlap another. Arm C is checked against a STRICTLY LARGER set of
declaration rules than arm B — it must also avoid undeclared overlap, which arm
B got free by construction — so its format-failure rate is if anything
pessimistic relative to B's, never flattered.

## Violations by kind — and which of them mean anything

Per scene, as AUTHORED (pre-repair). **Read the label before the numbers.**

${head("kind")}
${rule()}
${row("containment ⚠️ *free for B and C*", (a) => orNA(aggs[a], () => f2(aggs[a].authoredViolations.containment / Math.max(1, aggs[a].scenes))))}
${row("disjointness ⚠️ *mostly free for B and C*", (a) => orNA(aggs[a], () => f2(aggs[a].authoredViolations.disjointness / Math.max(1, aggs[a].scenes))))}
${row("stranded-hero ✅ *contested*", (a) => orNA(aggs[a], () => f2(aggs[a].authoredViolations["stranded-hero"] / Math.max(1, aggs[a].scenes))))}
${row("budget ✅ *contested*", (a) => orNA(aggs[a], () => f2(aggs[a].authoredViolations.budget / Math.max(1, aggs[a].scenes))))}

⚠️ **CONTAINMENT and INTER-ELEMENT DISJOINTNESS are structural gimmes for BOTH
discrete arms, C included.** The lattice covers only the title-safe area, whose
bottom edge (1026px @16:9) sits above the bottom reserve (1042px), so
containment cannot fail. A cell has exactly one owner — enforced by construction
in B (a character slot) and by a rejected declaration in C (the overlap check) —
so two head-authored elements cannot overlap. Neither count is evidence that the
model composed a better frame; both are properties of the representation,
knowable without a bake-off. They are reported because they are real defect
reductions in production, not because they settle the question. Both discrete
arms can still collide with the composer's DETERMINISTIC slots (the chrome bar
reaches up into the bottom lattice row; the throughline anchor is pinned
mid-frame), and those collisions are contested.

✅ **STRANDED-HERO, BUDGET, the FORMAT-FAILURE RATE and the VOID are the honest
scoreboard** — every one of them is fully available to all three arms.

## Per-brief

| brief | brand | aspect | scenes | ${present.map((a) => `${a} att`).join(" | ")} | ${present.map((a) => `${a} viol`).join(" | ")} | ${present.map((a) => `${a} void`).join(" | ")} | ${present.map((a) => `${a} fmt`).join(" | ")} |
|---|---|---|---|${present.map(() => "---|").join("").repeat(4)}
${SAMPLE.filter((id) => rows.some((r) => r.brief === id))
  .map((id) => {
    const got = present.map((a) => rows.find((r) => r.brief === id && r.arm === a));
    const any = got.find(Boolean);
    if (!any) return "";
    const cell = (fn: (r: ArmResult) => string) => got.map((r) => (r ? fn(r) : "—")).join(" | ");
    return `| \`${id}\` | ${any.brand} | ${any.aspect} | ${any.sceneCount} | ${cell((r) => String(r.attempts))} | ${cell((r) => (r.failure ? "HARD" : f2(perSceneOf(r, KINDS))))} | ${cell((r) => (r.failure ? "HARD" : pct(meanVoidOf(r))))} | ${cell((r) => (r.failure ? "HARD" : String(r.formatFailureAttempts)))} |`;
  })
  .filter(Boolean)
  .join("\n")}

## Method

- **Sample**: ${aggs[baseline].briefs} cached briefs, one per brand, hardcoded in
  \`scripts/layout-bakeoff.ts\` (\`SAMPLE\`). Cached generated scripts from
  \`.data/scripts\` — script generation was NOT re-run, so every arm saw
  byte-identical scripts. Any stored composition was stripped first.
- **Arms**: one prompt each, selected by the \`intent\` option on
  \`generateComposition\` (\`pixel\` | \`grid\` | \`cells\`). ONLY the spatial blocks,
  the placement bullet, the output contract and the worked example's PLACEMENT
  differ; the worked example's CONTENT and every non-spatial instruction are
  byte-identical across arms.
- **Scorer**: \`composeSceneLayout\` + \`validateScenePlan\` via
  \`lib/agents/plan-validate\` — the P1 module, unmodified. No new violation
  checker was written for this bake-off, and all three arms produce the same
  \`SceneComposition\` shape, so the scorer cannot tell them apart.
- **Authored vs residual**: "authored" is attempt 1, captured at the top of the
  validate callback BEFORE plan-validate's repair ladder mutates the
  composition. "Residual" is what survives the full retry + repair loop.
- **Void**: largest maximal contiguous unclaimed rectangle over the
  ${"`"}32×18${"`"} safe-area lattice (maximal-rectangle-in-binary-matrix), as a
  fraction of the safe area. Measured on the COMPOSED PLAN for every arm, so
  none gets a home-field rasterization. Atmosphere excluded (it covers
  everything); chrome included (real painted mass). Total coverage is
  deliberately NOT scored — mandating it would reward the over-fill regression
  already shipped and reverted.
- **Statistics**: paired per-brief differences with a normal-approximation 95%
  interval. This is a coarse instrument; "within noise" means the interval
  straddles zero.
- **Run provenance**: arms A and B were measured in the first run; arm C was run
  separately against the same pinned model string and the stored A/B rows were
  merged in (\`RB_BAKEOFF_MERGE\`). Same briefs, scripts, scorer and retry budget;
  a same-session run would nonetheless be marginally stronger evidence.
`;
};

// ─── Driver ─────────────────────────────────────────────────────────────────

const pool = async <T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> => {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
};

(async () => {
  const ids = LIMIT > 0 ? SAMPLE.slice(0, LIMIT) : SAMPLE;
  log(`P2 bake-off: ${ids.length} briefs × ${ARMS.length} arms, model ${CAST_MODEL}, concurrency ${CONCURRENCY}`);

  const contexts: BriefContext[] = [];
  for (const id of ids) {
    try {
      contexts.push(await loadContext(id));
    } catch (err) {
      log(`SKIP ${id} — ${err instanceof Error ? err.message : err}`);
    }
  }
  log(`loaded ${contexts.length} briefs: ${contexts.map((c) => `${c.brand}(${c.aspect},${c.script.scenes.length})`).join(", ")}`);

  const jobs = contexts.flatMap((ctx) => ARMS.map((arm) => ({ ctx, arm })));
  let done = 0;
  const fresh = await pool(jobs, CONCURRENCY, async ({ ctx, arm }) => {
    const r = await runArm(ctx, arm);
    done++;
    log(
      `[${done}/${jobs.length}] ${arm.padEnd(5)} ${ctx.brand} — ${r.attempts} attempt(s), ` +
        `${r.failure ? `HARD FAIL (${r.failure})` : `${f2(perSceneOf(r, KINDS))} viol/scene, void ${pct(meanVoidOf(r))}`}, ` +
        `${r.tokensOut} out-tok, ${r.seconds.toFixed(0)}s`,
    );
    return r;
  });

  // Fold in a prior run's rows for arms NOT run this invocation. Rows for an arm
  // we just measured always WIN — a merge can add history, never overwrite a
  // fresh measurement with a stale one.
  const rows: ArmResult[] = [...fresh];
  if (MERGE_FROM) {
    const prior = JSON.parse(await fs.readFile(path.resolve(MERGE_FROM), "utf8")) as { rows: ArmResult[] };
    const ranNow = new Set(ARMS);
    const merged = prior.rows.filter((r) => !ranNow.has(r.arm) && ids.includes(r.brief));
    rows.push(...merged);
    log(`merged ${merged.length} prior rows from ${MERGE_FROM} for arms [${[...new Set(merged.map((r) => r.arm))].join(", ")}]`);
  }

  const reportArms = ALL_ARMS.filter((a) => rows.some((r) => r.arm === a));

  const aggs = Object.fromEntries(ALL_ARMS.map((a) => [a, aggregate(rows, a)])) as Record<HeadIntent, Agg>;
  const report = buildReport(rows, aggs, reportArms);

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUT_DIR, "BAKEOFF_P2.md"), report, "utf8");
  await fs.writeFile(
    path.join(OUT_DIR, "BAKEOFF_P2.json"),
    JSON.stringify(
      {
        runAt: new Date().toISOString(),
        model: CAST_MODEL,
        sample: ids,
        pricing: { usdPerMillionIn: USD_PER_M_IN, usdPerMillionOut: USD_PER_M_OUT, note: "Fireworks list price, estimate" },
        aggregate: aggs,
        rows,
      },
      null,
      2,
    ),
    "utf8",
  );

  // Cost THIS invocation (the arms actually run) — merged rows are already paid
  // for, so folding them into the spend line would double-count history.
  const spentNow = ARMS.reduce((n, a) => n + aggs[a].usd, 0);
  log(`DONE — ${path.join(OUT_DIR, "BAKEOFF_P2.md")}`);
  log(`this run [${ARMS.join(",")}]: est. $${spentNow.toFixed(2)}`);
  for (const a of reportArms) {
    log(`  ${ARM_LABEL[a]}: ${aggs[a].tokensIn}/${aggs[a].tokensOut} tok, ${aggs[a].hardFailures} hard fail, est. $${aggs[a].usd.toFixed(2)}`);
  }
  console.log(`\n${report}`);
  process.exit(0);
})().catch((e) => {
  console.error("BAKEOFF FAILED:", e);
  process.exit(1);
});
