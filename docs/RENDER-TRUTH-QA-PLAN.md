# Render-Truth Quality System — Plan

Status: approved direction (2026-06-14), not yet implemented.
Decisions: D1 = Hybrid (deterministic measure + vision). D2 = retry → rewrite-script → hard-fail, with a $10/build cost ceiling.

## The problem (why we keep shipping broken scenes)

All ~18 current gates parse the **generated code** and reason about **declared** values
(inline `width`/`left`, declared hex pairs, the visual_concept string). But every defect
that ships is a property of the **rendered output**, not the source:

- Clipped text/flow → flex content *computed* wider than its box (no declared width is "wrong")
- Unreadable logos → a light asset *composited* on a light surface (no declared hex pair to check)
- Wall-of-type → absence; static checks approximate it badly

Each new defect → a new heuristic that approximates a rendered property from source → the
next defect is a property we didn't approximate. Whack-a-mole, because the gates operate on
the wrong representation. There is exactly one source of truth for "does it look right": the
rendered frame + its computed layout. We render (Remotion headless Chromium) but never
measure before shipping; the only build-path gate is jsdom SSR, which has **no layout engine**.

## Architecture — hybrid (D1)

```
BUILD PATH  (app/api/preview/build/route.ts → pipeline.ts buildAnimatedSections)

 1. Design + Choreography agents → genDir            [unchanged]
 2. Compile gate (esbuild parse)                      [unchanged]
 3. SOURCE-LEVEL gates  (KEEP — about code/content, not render):
       copy-binding · claims-grounding · lucide-repair · type-only-concept
 4. ┌─ RENDER-TRUTH PASS  (new primitive) ───────────────────────────┐
    │  headless Chromium loads each scene @1920×1080, pinned to its   │
    │  settled frame (reuse SectionClock), then captures:             │
    │    • getBoundingClientRect + computed styles for EVERY element  │
    │    • a screenshot (PNG)                                         │
    │  4a. DETERMINISTIC gates on the MEASURED layout → BLOCKING      │
    │       • overflow/clip : any rect crosses [0,0,1920,1080]        │
    │       • contrast      : text/logo luminance vs the REAL pixels  │
    │                         behind it (catches light-on-light)      │
    │       • dead-region   : measured empty bands (folds in          │
    │                         lib/render/painted-content.ts)          │
    │  4b. VISION gate on the screenshot → advisory, then blocking    │
    │       • Opus vision + brand rubric (bg color, readable, not     │
    │         wall-of-type, brand-fit). Promote to blocking once      │
    │         false-positive rate is calibrated.                      │
    └─────────────────────────────────────────────────────────────────┘
 5. ok:true requires 4a pass (within the escalation budget)
 6. DELETE the static approximations 4a subsumes (see Gate migration)
```

The core move: replace the jsdom-SSR "does it evaluate" check with a real-browser "does it
lay out correctly" check. Measurement is high-confidence (a measured clip is a fact, not a
guess), which is what makes blocking finally safe and lets us delete gates instead of adding.

## Failure handling — cost-bounded self-repair (D2)

```
measure scene ── pass ──► ship
   │ fail
   ▼
 L1 design-agent retry (fix layout)            → re-measure
 L2 design-agent retry #2                       → re-measure
 L3 rewrite scene SCRIPT (lighter concept) +
    rebuild from new script                     → re-measure
 L4 hard-fail the build (do not ship)

 ⛔ at every step: cumulative build spend ≥ $10 → stop, hard-fail (cost-ceiling)
```

- L1/L2 fix *layout* bugs the design agent can patch. L3 handles the case the concept itself
  is unbuildable (too dense → clips) — the real fix is a lighter visual_concept, so regenerate
  the scene's script and rebuild. L4 guarantees a measured-broken scene never ships.
- The $10 ceiling needs a per-build cumulative cost accumulator (extend lib/usage.ts; check
  before each retry/regen). Prevents runaway (cf. the 2h45m ECONNRESET build).
- A hard-failed build surfaces the exact scene + measured reason; user can per-scene-regenerate.

## The render-and-measure primitive

- Tool: **Playwright** (Layer-1, tried-and-true; clean `page.evaluate` for rects + computed
  styles + `screenshot`). Likely a new dev dep; small. Alternative: reuse the puppeteer-core
  that @remotion/renderer already bundles (no new dep, lower-level API) — decide at build time.
- Load each scene's settled frame: bundle exists for MP4; pin time via the SectionClock
  (getRemotionEnvironment().isRendering path) so animations are at their end state.
- This primitive is shared by the build gate AND the dogfood loop (replaces the manual pass).

## Phases (incremental, strangler-fig — not big bang)

- **Phase 1 — primitive, advisory.** Build the render-and-measure pass; wire into the build
  path as LOG-ONLY. Validate it flags the known defects on the current Fuse build
  (01KV4J28RYSNFXH4TTQXSTBXBQ): scene 2 + 4 right-edge clip, scene 3 light-on-light logos.
  No behavior change yet. Ship.
- **Phase 2 — deterministic gates blocking + escalation + budget.** Turn 4a blocking with the
  L1→L4 ladder and the $10 ceiling. Delete the subsumed static gates. This is the phase that
  stops broken scenes shipping.
- **Phase 3 — vision gate.** Add 4b (Opus vision on the screenshot) as advisory; calibrate
  false-positive rate; promote to blocking for the taste/readability class.
- **Phase 4 — unify the loop.** Point the dogfood loop QA at the same primitive; retire the
  manual SCENE-QA invocation.

## Gate migration (stop the sprawl)

DELETE once 4a is proven (they approximate what we now measure):
- overflow geometry gate (findOverflowingElements) — measured directly
- declared-contrast gate — measured against real pixels
- vertical-fill / dead-region heuristics — measured

KEEP (genuinely source/content-level, nothing to measure in a frame):
- copy-binding (findUnboundCopy) · claims-grounding · lucide-import-repair ·
  type-only-visual_concept · CTA-duplication · provided-component-redefinition

## NOT in scope
- Replacing the script/design/choreography agents or model routing (separate concern).
- Font-capture fix (Merriweather serif) — real gap, tracked separately; not part of QA arch.
- Animation-quality/taste scoring beyond the vision rubric (future).
- Multi-aspect (9:16, 1:1) measurement tuning — Phase 2 does 16:9 first, others follow.

## What already exists (reuse, don't rebuild)
- `lib/render/painted-content.ts` — pixel ink scoring; folds into 4a dead-region.
- `lib/render/build-wrapper.ts` SectionClock — pins settled frame for measurement.
- `scripts/dogfood-stills.mjs` — already renders real frames; shares the primitive.
- `docs/SCENE-QA.md` + vision judges — become the 4b rubric, wired not manual.
- `lib/usage.ts` — extend for the per-build cumulative cost ceiling.
- `lib/render/ssr-render.ts` verifyScenesRender — superseded by the real-browser pass.

## Failure modes
- Playwright load flake → retry once, then treat as gate-error (fail closed, not silent).
- Measurement disagrees with MP4 render (different browser/version) → pin the same Chromium
  Remotion uses; measure at the same frame.
- $10 ceiling hit mid-repair → hard-fail with cost reason (never silent, never runaway).
- Vision false-positive while advisory → logged only; cannot block until calibrated.
