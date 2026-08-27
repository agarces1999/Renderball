# Plan — Auxiliary asset library (images + Lottie + video), agent-queried

> **VIDEO-ERA PLAN — not current direction.** Asset sourcing may return post-harness; 'design agent' architecture referenced here is retired (docs/HARNESS.md).

**Goal:** give the design agent a real, free-to-use, commercial-safe asset library it
**queries live** (icons already exist; add **photos, video, Lottie**) so non-tech scenes
get real media instead of vague CSS shapes — the true ceiling on non-tech quality
identified in the pilot.

**Reviewed via** the same eng-review rigor as the foundation plan. This is the
deferred "real imagery" Phase 2.

---

## Decisions locked (review gate)

1. **Scope: broad** — photos + video + Lottie (not images-only).
2. **Keep Remotion**; migrate the preview from the plain-React iframe to **`@remotion/player`** so video/Lottie/Img behave identically in preview and MP4, and the custom `<img>` shim is deleted (one render path). The preview-friction that prompted "dump Remotion?" is solved here; Remotion's deterministic capture is kept.
3. **The design agent queries assets via a tool call** (`search_assets`) during Pass 1 — a tool-use loop, not a pre-resolution step.
4. **Sources** (commercial-safe, no/again-light attribution): **Pexels** for photos + video; **LottieFiles** for Lottie (filtered to commercial-free licenses).

### Reconciling "agent tool-call" with "preview IS the MP4"
A live tool-call sounds non-deterministic, but determinism is preserved by **caching + baking**:
the tool downloads the chosen asset to a LOCAL path and the agent bakes that local path into
the static `Composition.tsx`. The tool-use happens at build time; the OUTPUT is frozen. Preview
and render read the same baked composition + the same local files → still byte-identical. The
existing "render reuses the previewed composition" logic carries this for free.

---

## Architecture

```
DESIGN PASS (Pass 1) — restructured into an Anthropic tool-use loop
  agent → tool_use: search_assets({ type:"photo"|"video"|"lottie", query, orientation })
        │
        ▼
  resolveAssetSearch(args)                 Pexels (photo + video) · LottieFiles (lottie)
        │   returns 3–6 candidates: { id, thumbUrl, fullUrl, w, h, durationS?, license }
        │   (license-filtered to commercial-safe BEFORE the agent sees them)
        ▼
  agent picks one → writes the composition referencing it
        │
        ▼
  cacheAsset(chosen)   download bytes → src/generated/<id>/assets/<sha>.<ext>
        │              append assets-manifest.json { query, source, srcUrl, license, sha }
        ▼
  Composition.tsx references the LOCAL cached path (baked, static)
        │
        ▼
  ONE render path (post-Player):  preview = <Player component={Comp}/> ,  MP4 = renderMedia
    photo → Remotion <Img> · video → <OffthreadVideo> · lottie → @remotion/lottie
    same comp + same local assets  →  preview === MP4
```

Determinism: non-determinism is only in WHICH asset the agent picks while generating;
once built it's frozen (baked local path + manifest). Re-render reuses the cached comp.

---

## Phasing (broad scope, shipped incrementally — not big-bang)

**Phase 0 — Player migration (prerequisite, shippable alone).** Replace the iframe preview
with `@remotion/player`; mount the composition inside real Remotion context; delete the
`<img>` shim; comps import Remotion `<Img>` directly. De-risks everything downstream and is
independently valuable (true preview=render for the CURRENT output). Verify all 5 pilot
brands still preview + render identically.

**Phase 1 — Photos via tool-call (first real asset value).** `search_assets` tool + tool-use
loop in the design pass + Pexels photo source + license filter + `cacheAsset` + manifest +
design-prompt guidance ("when a scene needs a real photo, call search_assets; place the
result with `<Img>`"). This is the bulk of the non-tech win (Patagonia/Glossier).

**Phase 2 — Video.** Add Pexels video to `search_assets`; render with `<OffthreadVideo>`
(now trivial — Player makes it work in preview too); cap clip length to scene duration;
mute by default; poster handled by Remotion.

**Phase 3 — Lottie.** Add LottieFiles (commercial-free filter) to `search_assets`; render
with `@remotion/lottie` (frame-driven). Smallest, most license-sensitive — do last.

Each phase is a shippable increment; stop after any phase if quality is sufficient.

---

## Workstreams + files

| # | Workstream | Files | Phase |
|---|---|---|---|
| W0 | Player preview migration; drop `Img` shim; comps use Remotion media | `app/preview/[id]/PreviewClient.tsx`, `lib/render/build-wrapper.ts` (IMG_SHIM removal), generated `index.tsx` wrapper, design-agent import guidance | 0 |
| W1 | `search_assets` tool def + Anthropic tool-use loop in Pass 1 | `lib/agents/pipeline.ts` (design pass → tool loop), new `lib/assets/search.ts` | 1 |
| W2 | Source adapters (Pexels photo/video, LottieFiles) + license filter | new `lib/assets/sources/{pexels,lottiefiles}.ts`, `.env.local` keys | 1–3 |
| W3 | `cacheAsset` (download → genDir/assets) + `assets-manifest.json` | new `lib/assets/cache.ts`, `writeGeneratedFiles` (manifest) | 1 |
| W4 | Design-prompt guidance: when/how to call search_assets, placement per type | `lib/agents/prompts/design-agent.ts` | 1–3 |
| W5 | Video render (`<OffthreadVideo>`, length cap, mute) | design-agent + build-wrapper | 2 |
| W6 | Lottie render (`@remotion/lottie`, frame-driven) + dep | design-agent + deps | 3 |

New deps: `@remotion/player` (W0), `@remotion/lottie` (W3). New env: `PEXELS_API_KEY`, `LOTTIEFILES_API_KEY`.

---

## Licensing (hard constraint)
- **Pexels**: free for commercial use, no attribution required. ✓
- **LottieFiles**: per-asset licenses vary — query ONLY the free/commercial-licensed set, and record the license in the manifest. Drop anything not clearly commercial-free.
- **Every cached asset records its source URL + license in `assets-manifest.json`** so usage is auditable. This is the deliverable that makes the library legally safe, not just functional.

---

## Test coverage (high level — detailed in implementation)
- `lib/assets/search.ts` + source adapters: unit-test query→candidate mapping, license filtering (drop non-commercial), orientation/dimension selection, empty-result handling. [pure with mocked fetch]
- `cacheAsset`: downloads to genDir, dedupes by sha, writes manifest; handles a dead URL gracefully (skip, don't crash the build).
- Tool-use loop: the agent's `search_assets` calls resolve, results feed back, the final comp references a LOCAL baked path (not a remote URL or invented path).
- Player migration: all 5 pilot brands preview via `<Player>` and render identically (regression — CRITICAL, this changes the render mount).
- Failure modes: Pexels down / rate-limited → scene falls back to the existing CSS/illustration path (NEVER a broken `<img>`); non-commercial Lottie filtered out; clip longer than scene → trimmed.

---

## NOT in scope
- AI-generated imagery (separate, bigger; the "can't fake the real product" case stays upload-only).
- User asset upload UI for arbitrary scene media (exists for logo; per-scene upload deferred).
- Audio / music.
- A standalone asset-browser UI (the agent queries; humans don't browse in v1).
- Replacing Remotion (explicitly rejected — Player migration instead).

## What already exists (reuse)
- `resolveBrandIdentity` + the `writeGeneratedFiles`/reuse cache → extend the manifest + cache pattern.
- `page_images` (the brand's own crawled imagery) → `search_assets` can prefer these before going to Pexels for on-brand shots.
- lucide / simple-icons / recharts → unchanged; `search_assets` covers only photo/video/lottie.
- The Anthropic streaming call → becomes the tool-use loop (same client, add tools + loop).

## Parallelization
Phase 0 (W0) is a hard prerequisite — sequential, first. Within Phase 1: W1 (tool loop) ‖ W2 (sources) ‖ W3 (cache) can be built in parallel then integrated; W4 (prompt) after. Phases 2–3 are sequential add-ons.

## Implementation Tasks (Phase 0 + 1 only; 2–3 detailed when reached)
- [ ] **T1 (P0)** — Player migration: `<Player>` preview, drop `Img` shim, comps import Remotion `<Img>`; verify 5 pilots preview+render identical. *(prerequisite)*
- [ ] **T2 (P1)** — `lib/assets/sources/pexels.ts` (photo search) + license filter + unit tests (mocked fetch).
- [ ] **T3 (P1)** — `lib/assets/cache.ts`: download→genDir/assets, sha-dedupe, `assets-manifest.json`; dead-URL safe.
- [ ] **T4 (P1)** — `search_assets` tool def + restructure design Pass 1 into an Anthropic tool-use loop; bake the chosen LOCAL path into the comp.
- [ ] **T5 (P1)** — design-agent prompt: when to call `search_assets`, place photos with `<Img>`, fall back to CSS/illustration if no result (never a broken img).
- [ ] **T6 (P1)** — verify on Patagonia + Glossier: scenes whose `visual_concept` calls for a photo now render a real cached Pexels image; manifest records license.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run |
| Eng Review | `/plan-eng-review` | Architecture & tests | 1 | CLEAR | 4 decisions locked, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | not run |

- **Scope:** broad (images+video+lottie), phased to stay incremental.
- **Decisions locked:** broad scope; keep Remotion + Player; agent tool-call (cache+bake preserves preview=MP4); Pexels + LottieFiles (commercial-safe).
- **UNRESOLVED:** 0. **Critical gaps:** 0 (asset-source failure falls back to CSS, never a broken img).
- **VERDICT:** ENG CLEARED — ready to build, starting with Phase 0 (Player migration) as the prerequisite. Note: bigger than the foundation; recommend shipping phase-by-phase. A `/plan-ceo-review` is worth considering given this spends an innovation token (external APIs + render-mount change).
