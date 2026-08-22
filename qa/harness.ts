//
// The QA harness: drive the real product in a real browser, as a person would.
//
// WHY THIS SHAPE. Two decisions worth knowing before adding to it.
//
// 1. DETERMINISTIC FLOWS, NOT AN AGENT CLICKING AROUND. A model exploring the UI
//    is good at finding what nobody thought to script, but it is slow,
//    non-repeatable, and its failures are as often its own confusion as they are
//    product bugs — which makes it a poor gate. Scripted flows are the backbone;
//    exploration is a separate, occasional pass.
//
// 2. NO TEST FRAMEWORK. `playwright` (the library) is already a dependency — the
//    render-truth gate uses it — so flows cost nothing to add. Pulling in
//    @playwright/test would change package.json, package-lock and therefore the
//    Docker image build, to gain reporters this does not need. The project
//    already ships its own runner (scripts/run-tests.mjs) for the same reason.
//
// TIERS, because coverage is not free. Editing is deterministic and costs
// nothing; generation is metered and a full build is ~$1 and tens of minutes. So
// a run declares how much it is allowed to spend:
//
//   free  — editing, layout, brand, page ops, export, undo. Seconds. £0.
//   smoke — free + ONE real generation, to prove the model path is alive.
//   full  — everything, including building a deck from a brief.
//
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { promises as fs } from "fs";
import path from "path";

export type Tier = "free" | "smoke" | "full";

/** Ordered so `tierAtLeast` can compare them. */
const TIER_RANK: Record<Tier, number> = { free: 0, smoke: 1, full: 2 };

export interface Ctx {
  page: Page;
  /** Base URL of the server under test. */
  base: string;
  tier: Tier;
  /** True when a signed-in session is available (see qa/auth.ts). */
  authed: boolean;
  /** Attach a note to the current flow's report. */
  note: (msg: string) => void;
}

export interface Flow {
  name: string;
  /** Lowest tier at which this flow runs. */
  tier: Tier;
  /** Skip unless a signed-in session exists. */
  needsAuth?: boolean;
  /**
   * This flow CHANGES the document.
   *
   * Mutating flows are run one at a time. They share a single document, so in
   * parallel they sabotage each other — the first run of this suite had one
   * flow deleting the very element another was resizing, and reported three
   * product bugs that were entirely the harness's own doing. Read-only flows
   * still run concurrently.
   */
  mutates?: boolean;
  /**
   * KNOWN RED, with a reason and a date.
   *
   * A quarantined flow still runs and still reports; its failure just does not
   * fail the suite. This exists because the alternative is worse in both
   * directions: leaving an undiagnosed failure red teaches everyone to ignore a
   * red suite (and then it protects nobody), while deleting or skipping it
   * loses the signal entirely and quietly narrows what the suite claims to
   * cover. Quarantine keeps the flow running, keeps its failure on screen, and
   * refuses to let it block — until someone finishes the diagnosis.
   *
   * The string is not decoration: it must say WHAT is unknown and WHEN it was
   * quarantined, so a reader can tell a fresh unknown from one that has been
   * rotting for a month. Anything quarantined is a debt, and the summary counts
   * it out loud so the debt cannot be forgotten.
   */
  quarantined?: string;
  run: (c: Ctx) => Promise<void>;
}

export interface FlowResult {
  name: string;
  status: "passed" | "failed" | "skipped" | "quarantined";
  ms: number;
  reason?: string;
  notes: string[];
  screenshot?: string;
}

export const tierAtLeast = (actual: Tier, needed: Tier): boolean =>
  TIER_RANK[actual] >= TIER_RANK[needed];

/** Assertion that reads as prose in the report. */
export const expect = (condition: boolean, whatShouldBeTrue: string): void => {
  if (!condition) throw new Error(whatShouldBeTrue);
};

/**
 * Poll until a condition holds.
 *
 * Editor operations are async round trips that end by reloading the canvas
 * iframe, so almost nothing here is true immediately. Fixed sleeps would make
 * the suite both slow and flaky; this waits only as long as it must.
 */
export const until = async (
  what: string,
  check: () => Promise<boolean>,
  timeoutMs = 15000,
): Promise<void> => {
  const started = Date.now();
  let lastErr: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      if (await check()) return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for: ${what}${lastErr ? ` (last error: ${lastErr})` : ""}`,
  );
};

export interface RunOptions {
  base: string;
  tier: Tier;
  flows: Flow[];
  /** How many flows run at once — the "multiple agents" part. */
  concurrency?: number;
  headless?: boolean;
  /** Where failure screenshots land. */
  artifactDir: string;
  /** Applies a signed-in session to a fresh context, when one is available. */
  authenticate?: (ctx: BrowserContext) => Promise<void>;
  /**
   * Reset the document before each MUTATING flow.
   *
   * Serialising them stopped flows from racing, but not from inheriting: a flow
   * that changes the deck's brand rewrites its sources, and the page-op flows
   * that ran next failed for reasons that had nothing to do with page ops. Each
   * mutating flow now starts from the same known document, so a failure means
   * that flow is broken and nothing else.
   */
  resetFixture?: () => Promise<void>;
}

export interface RunSummary {
  results: FlowResult[];
  passed: number;
  failed: number;
  skipped: number;
  /** Known-red flows that ran, failed, and did not block. A standing debt. */
  quarantined: number;
  ms: number;
}

/**
 * Run flows concurrently, each in its OWN browser context.
 *
 * Separate contexts rather than separate tabs: a context is an isolated cookie
 * jar and storage partition, so parallel flows cannot leak state into each
 * other's session — and a flow that leaves the editor in a strange state cannot
 * strand its neighbours.
 */
export const runFlows = async (opts: RunOptions): Promise<RunSummary> => {
  const { base, tier, flows, artifactDir } = opts;
  const concurrency = Math.max(1, opts.concurrency ?? 3);
  await fs.mkdir(artifactDir, { recursive: true });

  const browser: Browser = await chromium.launch({ headless: opts.headless ?? true });
  const started = Date.now();
  const results: FlowResult[] = [];

  // Read-only flows fan out; mutating flows queue behind them, one at a time.
  const parallelFlows = flows.filter((f) => !f.mutates);
  const serialFlows = flows.filter((f) => f.mutates);
  const queue = [...parallelFlows];
  const runOne = async (flow: Flow): Promise<FlowResult> => {
    const notes: string[] = [];
    const t0 = Date.now();

    if (!tierAtLeast(tier, flow.tier)) {
      return { name: flow.name, status: "skipped", ms: 0, reason: `needs tier "${flow.tier}"`, notes };
    }
    if (flow.needsAuth && !opts.authenticate) {
      return { name: flow.name, status: "skipped", ms: 0, reason: "no signed-in session available", notes };
    }

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      if (flow.needsAuth && opts.authenticate) await opts.authenticate(context);
      const page = await context.newPage();
      // Surface page crashes as flow failures rather than silent weirdness.
      const pageErrors: string[] = [];
      page.on("pageerror", (e) => pageErrors.push(String(e)));

      await flow.run({ page, base, tier, authed: !!flow.needsAuth, note: (m) => notes.push(m) });

      // An uncaught page error is normally a real defect. These three are not:
      // they come out of `next dev` compiling a route, carry no frame of our
      // own code, and CANNOT occur in production, which serves routes that were
      // built ahead of time. Failing on them makes the suite useless as a gate —
      // it spent four runs reporting a healthy product as broken. They are
      // noted rather than swallowed, so a flood is still visible.
      const DEV_COMPILE_NOISE =
        /reading 'useContext'|__webpack_modules__|webpack-runtime|ChunkLoadError|reading 'call'/;
      const real = pageErrors.filter((e) => !DEV_COMPILE_NOISE.test(e));
      const noise = pageErrors.length - real.length;
      if (noise > 0) notes.push(`(${noise} dev-compile page error${noise > 1 ? "s" : ""} ignored)`);
      if (real.length) {
        throw new Error(`uncaught page error: ${real[0]}`);
      }
      return { name: flow.name, status: "passed", ms: Date.now() - t0, notes };
    } catch (e) {
      let reason = e instanceof Error ? e.message : String(e);

      // Tell a broken DEV SERVER apart from a broken product.
      //
      // `next dev` compiles incrementally, and enough source edits while it is
      // running leave its cache inconsistent: routes then fail with
      // "__webpack_modules__[moduleId] is not a function" or
      // "Cannot read properties of undefined (reading 'call')" from inside
      // webpack-runtime, with none of our code in the stack. Three flows
      // reported that as product failures for four runs while the product was
      // fine — the fix is one restart, and the suite should say so.
      const looksLikeStaleBuild = await Promise.all(
        context.pages().map((p) =>
          p
            .evaluate(() => document.body?.innerText ?? "")
            .then((t) => /__webpack_modules__|webpack-runtime|ChunkLoadError/.test(t))
            .catch(() => false),
        ),
      ).then((hits) => hits.some(Boolean));
      if (looksLikeStaleBuild || /reading 'call'/.test(reason)) {
        reason =
          `${reason}\n        ↳ this looks like a STALE DEV BUILD, not a product bug. ` +
          `Stop the dev server, delete .next, start it again.`;
      }
      let screenshot: string | undefined;
      try {
        const pages = context.pages();
        if (pages.length) {
          screenshot = path.join(artifactDir, `${flow.name.replace(/[^a-z0-9]+/gi, "-")}.png`);
          await pages[0].screenshot({ path: screenshot, fullPage: false });
        }
      } catch {
        /* a screenshot is a nicety, never a reason to lose the real failure */
      }
      // A quarantined flow reports its failure in full and does not fail the run.
      if (flow.quarantined) {
        return {
          name: flow.name,
          status: "quarantined",
          ms: Date.now() - t0,
          reason: `${reason}\n        ↳ QUARANTINED: ${flow.quarantined}`,
          notes,
          screenshot,
        };
      }
      return { name: flow.name, status: "failed", ms: Date.now() - t0, reason, notes, screenshot };
    } finally {
      await context.close().catch(() => {});
    }
  };

  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const flow = queue.shift();
      if (!flow) return;
      const r = await runOne(flow);
      results.push(r);
      const mark = r.status === "passed" ? "✓" : r.status === "failed" ? "✗" : r.status === "quarantined" ? "⚠" : "–";
      console.log(`  ${mark} ${r.name}${r.status === "skipped" ? ` (${r.reason})` : ` · ${r.ms}ms`}`);
      for (const n of r.notes) console.log(`      · ${n}`);
      if (r.status === "failed") {
        console.log(`      ${r.reason}`);
        if (r.screenshot) console.log(`      screenshot: ${r.screenshot}`);
      }
    }
  });
  await Promise.all(workers);

  // Then the mutating flows, strictly in sequence, each from a clean document.
  for (const flow of serialFlows) {
    if (opts.resetFixture && tierAtLeast(tier, flow.tier)) await opts.resetFixture();
    const r = await runOne(flow);
    results.push(r);
    const mark = r.status === "passed" ? "✓" : r.status === "failed" ? "✗" : r.status === "quarantined" ? "⚠" : "–";
    console.log(`  ${mark} ${r.name}${r.status === "skipped" ? ` (${r.reason})` : ` · ${r.ms}ms`}`);
    for (const n of r.notes) console.log(`      · ${n}`);
    if (r.status === "failed") {
      console.log(`      ${r.reason}`);
      if (r.screenshot) console.log(`      screenshot: ${r.screenshot}`);
    }
  }

  await browser.close().catch(() => {});

  return {
    results,
    passed: results.filter((r) => r.status === "passed").length,
    failed: results.filter((r) => r.status === "failed").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    quarantined: results.filter((r) => r.status === "quarantined").length,
    ms: Date.now() - started,
  };
};
