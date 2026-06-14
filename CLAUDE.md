# Renderball

AI-native video generation. A brief becomes a story-driven, on-brand animated
frontend, rendered to MP4. Next.js 14 + Remotion + TypeScript + Tailwind.

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
Model choice per stage lives in `lib/anthropic.ts` (`MODELS`). Every stage runs
on Opus 4.8 (`claude-opus-4-8`) per the 2026-06-14 directive — script generation,
build/regen coding agents, QA, logo discovery, design-language, and tweak. Change
there, not inline.
