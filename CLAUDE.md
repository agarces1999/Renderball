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
**FIREWORKS ONLY (founder call 2026-07-23) — z.ai is out of the stack.** Every
text/build stage (script generation, build/regen coding agents, QA, logo
discovery, design-language, tweak) runs GLM-5.2 **served by Fireworks**
(`accounts/fireworks/routers/glm-5p2-fast`, override RB_BUILD_MODEL; fast
router bills $2.10/$6.60 per M). Vision (QA gate + crawl image reads) runs
**Kimi K2.6** (`accounts/fireworks/models/kimi-k2p6`, override
RB_VISION_MODEL) — the account's ONE live serverless VLM, probe-verified
reading real slides. GLM-4.5V/Qwen-VL exist on Fireworks' catalog pages but
404 on this account ("not deployed"); glm-5p2 is text-only (clean 400 on
images). Before assuming any catalog model is callable, check
GET /v1/models with the account key. Kimi is a thinking model: terse
extraction calls must send thinking-disabled (zai-vision.ts does this for
GLM/Kimi-family ids only). Gate-judgment re-baselining vs the GLM-5V era is
pending.
Abstract names live in `lib/anthropic.ts` (`MODELS`, `VISION_MODEL`); the
transports are `lib/llm/build-client.ts` (Anthropic-shaped shim over the
OpenAI-wire `castCall`) and `lib/render/zai-vision.ts` (vision; keeps its
historical name). `getAnthropic()` is dormant — do not add new call sites to
it, and do not propose Opus/Sonnet as a build or validation substrate. Change
models in those files, not inline.

Vision lesson that must survive the provider change: images go ONLY through
the single vision transport (`callZaiVision`) on a wire where images
verifiably arrive — an Anthropic-compat proxy that silently drops image
blocks blinded the whole vision layer once already.

## Spatial quality system
Before touching layout, allocation, washout/contrast repairs, overlap gates, or
type scaling, read `docs/SPATIAL_QUALITY.md` — the durable spec: principles
(ink is the unit of account; occupy, don't redistribute; repairs must never
manufacture defects), the system map with file anchors, calibration evidence,
detector ideas already KILLED BY DATA (do not rebuild them), the pending
RB_DENSITY_FLOOR spec, and the offline validation playbook (stored builds +
replay scripts). The running lab ledger is `.data/dogfood/SPATIAL_EXEC.md`.
