# Text fit — how generated pages stop being born overfull

> **SPLIT BY THE HARNESS VERDICT — 2026-08-27 (docs/HARNESS.md).** The autofit RUNTIME
> (fit-text.ts, the PowerPoint algorithm) survives — it is checks-class and
> engine-agnostic. The emission-side machinery (char budgets in the
> generation schema, shorten loops) was compensation for fragmented
> authoring and retires with the cast engine.

Adopted 2026-08-13 after a two-track research sweep (industry products +
deterministic methods; sources at the bottom). This is the Layer-1 answer to
the founder's question "why do builds fall into the repair loop": pages are
born with more text than their boxes because the model GUESSES pixel font
sizes, and nothing in the browser corrects the guess. See
docs/SPATIAL_QUALITY.md for the measured background (overflow 19 fires,
cross-piece-overlap 22 — the #1 and #2 blocking findings; overlap is mostly
overflow's consequence).

## The one-sentence finding

No production system lets an LLM freely guess pixel font sizes on a fixed
canvas and cleans up with a visual loop — every shipping system either makes
text fitting a deterministic render-time computation (PowerPoint for 30
years), constrains generation to slots with measured capacities (Google
responsive ads, Beautiful.ai, PPTAgent), or gives up the fixed canvas
entirely (Gamma's auto-growing cards — not available to us; we export PPTX
and render video frames).

Our current architecture — model emits `fontSize: 24` into absolute boxes,
27 absolutely-positioned elements per scene, ~zero overflow rules, then a
render-and-repair loop regenerates whole scenes — is the documented
anti-pattern, and its non-convergence is also documented: unguided
self-revision "brings no substantial improvement" (Design2Code), repair value
collapses after two passes, and loops converge only with deterministic
detection + scoped patches + accept-only-if-strictly-better (ReLook's forced
optimization; Anthropic's harness writeup).

## What we adopt (three layers, in order)

### 1. Deterministic autofit at render time — the PowerPoint algorithm in our renderer

A text region that overflows its box gets its type fitted BY THE RUNTIME,
not by a model:

- Fullness = required height / box height (in DOM terms:
  scrollHeight / clientHeight — the exact ratio in Microsoft patent
  US6256650, which also gives the wrap-aware first guess:
  `newSize ≈ size × (desired/current fullness)` unwrapped bound,
  `size × sqrt(desired/current)` full-rewrap bound, interpolated by line
  length; converges in 1–3 probes, better than naive binary search).
- Order of operations (PowerPoint semantics): line-spacing reduction first,
  capped at 20%, THEN font scale, stepping down the design-system type scale
  (not continuously — per-shape continuous shrink destroys cross-page type
  consistency), with a readability floor.
- At the floor, stop: the page is flagged for the semantic path (layer 3).

Delivery mechanism: a fit pass that runs IN-PAGE before paint on nodes the
emitted scaffold marks as fit-managed, so the measurement loop, the editor,
the PDF/PNG export and the video renderer all see the same fitted result.
Remotion — already in the stack — ships the measurement half natively
(`@remotion/layout-utils`: `fitText`, `fitTextOnNLines`, `measureText`) with
two documented traps that MUST be respected: fonts loaded before measuring,
and measurement props byte-identical to render props.

This is model-independent: it corrects any composition, including every
stored build and every live edit, without a prompt change or a token.

### 2. The emitted dialect stops guessing — scaffold contract + banned literals

- The scaffold every scene is emitted into gains the overflow-proof CSS
  contract: `overflow: hidden` + `min-width/height: 0` at piece boundaries,
  per-slot `line-clamp`, `text-wrap: balance` on headlines. Anything that
  slips past fit clips gracefully at a defined line count instead of
  colliding with its neighbour.
- Raw `fontSize:` pixel literals in generated text nodes become a validator
  violation (the Claude-artifacts pattern: the model is barred from inventing
  pixel numbers). The model emits a TYPE-SCALE ROLE; the runtime owns the
  pixels. Enforced by the structural gate, auto-downgraded (rewritten to the
  nearest role) rather than retried — a lint, not a loop.

### 3. Measured character budgets upstream + the convergent shorten loop

- Measure each slot's real capacity ONCE, offline, with the real fonts
  (headline at role-size X in Cabinet Grotesk holds N chars/line × M lines)
  and put the budget in the generation schema. Critical detail from the
  research: length limits CANNOT be delegated to constrained decoding
  (structured-output samplers don't enforce minLength/maxLength) — they are
  validated post-hoc with ONE bounded shorten-retry.
- When render-time fit hits its readability floor, the repair is SEMANTIC
  and targeted: one "shorten this field to ≤N chars" call. Convergent by
  construction — the fit condition is computed, not judged.

### The repair-ladder consequence (Layer 2, separate decision)

With 1+2 in place the ladder's remaining job is real collisions and
aesthetics. The convergence recipe from the research applies to what stays:
deterministic detectors → localized critique naming the element → scoped
patch → accept only if the measured defect count STRICTLY drops → hard cap
of 2 rounds. The full-deck rebuild rung (L3) leaves the live path.

## Validation before any live spend

Stored builds carry full per-element rendered geometry
(`.data/dogfood/*/_measure/rects-scene-N.json`, 155 elements/scene). The fit
pass is validated by re-rendering stored compositions with the new runtime
and re-measuring: the overflow/overlap finding count before vs after is the
score, per the SPATIAL_QUALITY playbook. No model calls. Prompt-side changes
(role emission, budgets) go through the same offline replay, then one
founder-approved live A/B.

**Layer-1 gate result (2026-08-13, scripts/replay-text-fit.mjs, all 155
stored builds, both arms):** blocking overflow findings 48 → 41 (15% cut),
zero NEW finding kinds in the on-arm (nothing manufactured), zero replay
errors; 33 measure-errors are pre-pivot video compositions failing
identically in both arms. Caveat stated plainly: the stored corpus is
POST-REPAIR survivors, so it structurally under-represents the born-overfull
class the pass targets — the synthetic in-engine proof (fullness 2.47 fitted
to exactly 1.0, `s=0.73;l=0.20`, PowerPoint order of operations) plus the
sweep's no-regression result is the ship gate; the true reduction instrument
is live gate telemetry, which now records per-scene `fit`
{candidates, fitted, floored} on every build. Shipped default ON
(RB_TEXT_FIT=off opts out).

## What we explicitly do NOT adopt

- A Cassowary/ILP constraint solver — new dialect for the model, still
  cannot measure text; flexbox already is the solver where we need one.
- Whole-slide `transform: scale` shrink — one long paragraph would shrink
  the headline; destroys hierarchy.
- Unguided screenshot self-revision — measured non-convergent; the VLM stays
  reserved for aesthetics with calibrated criteria, never for overflow.
- Waiting for CSS `text-fit` — still in CSSWG design, no shipping target.

## Sources (both research reports, 2026-08-13)

PowerPoint autofit semantics: python-pptx analysis of `normAutofit`;
Microsoft patent US6256650 (fullness ratio, wrap-aware convergence).
Industry: Gamma card-size docs (fixed canvas abandoned; PPTX export caveat);
leaked v0 + Claude-artifacts prompts (responsive-only, pixel literals
banned); Presenton (Zod slot schemas); Beautiful.ai Smart Slides; PPTAgent
arXiv:2501.03936 (edit-into-template: 95% success vs 2.95→3.67 judged
quality over from-scratch). Fitting mechanics: Remotion layout-utils docs
(fitText/fitTextOnNLines + font-loading traps); satori; react-pdf; fitty
(width-only — wrong tool); auto-text-size; Marp auto-scaling (fitting policy
belongs to the theme layer, not the emitter). Loop convergence: Design2Code
arXiv:2403.03163 (self-revision ≈ no improvement); ReLook arXiv:2510.11498
(zero-reward invalid renders + accept-only-if-strictly-better); UI2Code^N
arXiv:2511.08195 (bounded gains, plateau by round 5); Anthropic harness
engineering post 2026-03-24 (separate evaluator, calibrated rubric; 70/25
diminishing returns → cap at 2). Budgets: Google responsive display ad specs
(hard per-slot character budgets + permitted degradation); OpenAI
structured-outputs docs (no maxLength enforcement in constrained decoding).
