# Renderball

AI-native design generation (pivoted 2026-07-23; formerly video-first). A brief
becomes an on-brand, editable, multi-format design document — wedge format:
presentation decks. Next.js 14 + Remotion + TypeScript + Tailwind.

## Pivot (2026-07-23) — read first
Read `docs/PIVOT.md` before any product or engine work. It holds the locked
decisions (decks-first wedge; video shelved NOT deleted; name stays Renderball;
usage-based token pricing with 1M free via Stripe meters), the keep/adapt/
shelve/new reuse map with file anchors, and the phase plan. Do not build
video-only features; do not delete video code paths.

## Design System
Always read `DESIGN.md` before making any visual, UI, or UX-flow decision.
Fonts, colors, spacing, the crystal-ball motif, and the fluid v1 flow are
defined there. Do not deviate without explicit approval. In QA or review, flag
any UI that does not match DESIGN.md.

Core rules to internalize:
- The chrome is quiet on purpose. When a brand-color preview is on screen, the
  app UI recedes so the user's work is the loudest thing.
- Story before render: show and let the user approve the narrative before
  spending expensive build/render compute.
- Config is refinement, not a gate. Format / colors / duration are
  crawl-defaulted side controls, never upfront wizard steps.
- Display type (Cabinet Grotesk) is for story surfaces only. Geist for UI/body,
  Geist Mono for timings and technical text.

## Model routing
Model choice per stage lives in `lib/anthropic.ts` (`MODELS` + `VISION_MODEL`).
The stack is **GLM-only** (z.ai) — this is the final call: every text/build stage
(script generation, build/regen coding agents, QA, logo discovery, design-language,
tweak) runs on `glm-5.2`, and all vision (the QA gate + crawl image reads) runs on
`glm-5v-turbo` via z.ai's NATIVE endpoint. Do not propose Opus/Sonnet as a build or
validation substrate. Change models there, not inline.

Vision MUST go through the native paas endpoint (`lib/render/zai-vision.ts` →
`callZaiVision`), NOT `getAnthropic()` — z.ai's Anthropic-compat endpoint silently
drops image blocks, so any image sent through the SDK client is invisible to the
model (it hallucinates). All crawl/QA image reads use `callZaiVision`.

## Spatial quality system
Before touching layout, allocation, washout/contrast repairs, overlap gates, or
type scaling, read `docs/SPATIAL_QUALITY.md` — the durable spec: principles
(ink is the unit of account; occupy, don't redistribute; repairs must never
manufacture defects), the system map with file anchors, calibration evidence,
detector ideas already KILLED BY DATA (do not rebuild them), the pending
RB_DENSITY_FLOOR spec, and the offline validation playbook (stored builds +
replay scripts). The running lab ledger is `.data/dogfood/SPATIAL_EXEC.md`.
