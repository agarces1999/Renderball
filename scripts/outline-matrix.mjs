// Outline generation, across brief lengths and page counts, repeated.
//
// WHY: a real 12-page generation failed for the founder with "Schema
// validation failed after 3 attempts" — the validator complaining that scene
// visual_concepts named containers with no interior detail. A like-for-like
// retry SUCCEEDED (200 in 78s), so the failure is content-specific or
// intermittent and one sample cannot tell which. This runs the space.
//
// It calls generateScript DIRECTLY rather than through the route: the route
// now (correctly) hides the validator's text behind a human sentence, which is
// exactly the diagnostic this needs. Direct calls also mean no auth, no
// documents created, and nothing to clean up.
//
// Costs real tokens — one outline call per run, plus up to 2 retries when the
// validator rejects. Founder-approved 2026-08-06.
//
//   set -a && source .env.local && set +a && node scripts/outline-matrix.mjs
//
import * as esbuild from "esbuild";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";

const OUT = join(process.cwd(), ".data", "outline-matrix");
mkdirSync(OUT, { recursive: true });

// ── the briefs, by shape ────────────────────────────────────────────────────
// Named for what they ARE, because the report has to be readable at a glance.
const FRAGMENT =
  "Which is why we are excited about the voice you are about to hear. Over to today's speaker.";

const ONE_LINER =
  "A pitch deck for Fuse Finance — continuous reconciliation for finance teams who dread month end.";

const NORMAL = [
  "A pitch deck for Fuse Finance. We connect to the ledgers finance teams already use, learn the shape of their chart of accounts, and reconcile continuously instead of in a panic at month end.",
  "Audience is a CFO or controller at a mid-market company. The problem is that reconciliation is manual, approvals sit in inboxes, and the close takes eleven days. Early customers close in four.",
  "We are raising a Series A and the ask is $12M to expand into forecasting and treasury.",
].join(" ");

const TRANSCRIPT = [
  "Good morning everyone, and thank you for joining us today. Before we begin I want to acknowledge the team that has been working on this for the better part of a year, often nights and weekends, and to say that what you are about to see is the result of their persistence rather than any single decision made in a room like this one.",
  "We started from a simple observation. Finance teams spend an enormous amount of time moving numbers between systems that were never designed to talk to each other. Reconciliation is manual. Approvals sit in inboxes. Month end is a fire drill that everybody dreads and nobody questions, because that is simply how it has always been done.",
  "Our customers told us the same thing in different words. They did not want another dashboard. They wanted the work to be smaller. They wanted the close to take days instead of weeks, and they wanted to stop hiring people whose entire job is to copy figures from one place to another and hope nothing breaks along the way.",
  "So we built something narrower than a platform and deeper than a tool. It connects to the ledgers you already use, it learns the shape of your chart of accounts, and it does the reconciliation continuously rather than in a panic at the end of the month. When something does not match it tells you why, in the language your controller already uses.",
  "The results have been better than we projected. Early customers are closing in four days rather than eleven. One of them redeployed two full time roles into analysis rather than data entry. Another told us their auditors asked what had changed, which is the kind of question you want to be asked.",
  "There is a lot more to say about how it works, and about where we are taking it next, particularly around forecasting and the treasury side. Which is why we are excited about the voice you are about to hear. Over to today's speaker.",
].join(" ");

// Long, and deliberately ABSTRACT — the shape most likely to starve a visual
// planner: many words, almost no nameable objects.
const ABSTRACT_LONG = Array.from({ length: 6 }, () =>
  [
    "Our thesis is that the category has confused activity with progress. Teams adopt tools that measure themselves, and the measurement becomes the work.",
    "What matters is the interval between a question being asked and the answer being trusted. Everything else is theatre. We think the interval collapses when the underlying record is continuously correct rather than periodically corrected.",
    "That belief shapes every decision we make about scope, pricing and pace, and it is why we have said no to several obvious features that would have sold well and taught us nothing.",
  ].join(" "),
).join(" ");

const BRIEFS = [
  { name: "fragment", text: FRAGMENT },
  { name: "one-liner", text: ONE_LINER },
  { name: "normal", text: NORMAL },
  { name: "transcript", text: TRANSCRIPT },
  { name: "abstract-long", text: ABSTRACT_LONG },
];

// The matrix. Page counts span the range the UI allows (1–12). The founder's
// exact cell (transcript × 12 × url) is repeated because the whole question is
// whether it is intermittent.
const RUNS = [
  { brief: "fragment", pages: 3, url: "" },
  { brief: "fragment", pages: 12, url: "fusefinance.com" },
  { brief: "one-liner", pages: 6, url: "" },
  { brief: "one-liner", pages: 12, url: "fusefinance.com" },
  { brief: "normal", pages: 3, url: "" },
  { brief: "normal", pages: 8, url: "fusefinance.com" },
  { brief: "normal", pages: 12, url: "" },
  { brief: "transcript", pages: 6, url: "" },
  { brief: "transcript", pages: 12, url: "fusefinance.com" },
  { brief: "transcript", pages: 12, url: "fusefinance.com" },
  { brief: "transcript", pages: 12, url: "fusefinance.com" },
  { brief: "abstract-long", pages: 12, url: "fusefinance.com" },
  { brief: "abstract-long", pages: 12, url: "fusefinance.com" },
  { brief: "abstract-long", pages: 6, url: "" },
];

const bundle = join(OUT, "gen.mjs");
await esbuild.build({
  entryPoints: [join(process.cwd(), "lib", "agents", "script-generator.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: bundle,
  packages: "external",
  logLevel: "silent",
});
const { generateScript } = await import(pathToFileURL(bundle).href);

const results = [];
const started = Date.now();
console.log(`▶ outline matrix — ${RUNS.length} runs\n`);

for (const [i, run] of RUNS.entries()) {
  const brief = BRIEFS.find((b) => b.name === run.brief);
  const t0 = Date.now();
  const label = `${run.brief}(${brief.text.length}c) × ${run.pages}p ${run.url ? "+url" : "     "}`;
  let row;
  try {
    const r = await generateScript(
      {
        id: `matrix-${i}`,
        owner_id: "matrix",
        purpose: brief.text.slice(0, 200),
        freeform_prompt: brief.text,
        kind: "deck",
        distribution_format: "landscape",
        duration_seconds: run.pages * 5,
        moments: [],
        cta: "",
        created_at: new Date().toISOString(),
        status: "awaiting_agent_1",
        script_id: `matrix-script-${i}`,
        moment_count: run.pages,
        brand_kit_url: run.url || undefined,
      },
      `matrix-${i}`,
    );
    const secs = (Date.now() - t0) / 1000;
    row = {
      ...run,
      chars: brief.text.length,
      ok: !!r.ok,
      secs: Math.round(secs),
      scenes: r.ok ? r.script?.scenes?.length ?? null : null,
      error: r.ok ? null : String(r.error ?? "").slice(0, 600),
    };
  } catch (e) {
    row = {
      ...run,
      chars: brief.text.length,
      ok: false,
      secs: Math.round((Date.now() - t0) / 1000),
      scenes: null,
      error: `THREW: ${e instanceof Error ? e.message : String(e)}`.slice(0, 600),
    };
  }
  results.push(row);
  console.log(
    `${String(i + 1).padStart(2)}/${RUNS.length}  ${label}  →  ${row.ok ? `ok ${row.scenes} scenes` : "FAILED"}  ${row.secs}s`,
  );
  if (!row.ok) console.log(`      ${row.error.slice(0, 220)}`);
  writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 2));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n── ${results.length - failed.length}/${results.length} succeeded · ${Math.round((Date.now() - started) / 60000)} min`);
if (failed.length) {
  console.log("\nFAILURES:");
  for (const f of failed) console.log(`  ${f.brief} × ${f.pages}p ${f.url ? "+url" : ""} — ${f.error.slice(0, 300)}`);
} else {
  console.log("no failures — the founder's case did not recur in this matrix");
}
