# Renderball — Progress Log

A rolling week-by-week record of what's shipped, what's been decided, what's been learned, and what's coming next. Updated continuously. Companion to `PRODUCT.md` (spec), `GTM.md` (go-to-market), `PROCESS.md` (origin reference), and `PRODUCT-REVIEW.md` (autoplan audit trail).

---

## Where we are right now (2026-08-27)

| Field | Status |
|---|---|
| Phase | **Harness pivot** — measurement program closed (docs/HARNESS.md): 5-arm blind gallery; one-call author + context pack beats the cast pipeline; bet-on-models doctrine locked. Building the harness behind a flag (task #119). |
| Product | Decks-first canvas (docs/PIVOT.md). Prod = cast+box-contract engine (legacy, serving until the harness A/B). renderball.com live. |
| Last update | 2026-08-27 |

Everything below this table is the historical log (the video-era "where we
are" table included, unedited, as the 2026-05-28 snapshot it was).

## Where we were (2026-05-28 snapshot — historical)

| Field | Status |
|---|---|
| Phase | **Build sprint active** — V0.3 architecture landed: two-pass CSS-only pipeline + full brand-DNA crawl. Falabella render fix-pack (aspect/palette/dead-air/shake/composition) shipped 2026-05-28 |
| Last update | 2026-05-28 (end-of-session) |
| Bandwidth | Nights + weekends (~26–44 hours/week) |
| Public launch target | Day 50–60 |
| First $2K MRR target (day-job-exit trigger) | Day 90–130 |
| First $10K MRR target (YC application milestone) | Day 120–150 (~4 months) |
| Strategy reversal | **2026-05-27** — pivoted FROM Wave 1 Text-first cold outreach TO build-product-first. Empathy argument decisive: "I would only respond to a video, putting myself in their place." |
| Cold target list (30 prospects) | ✓ Built; held until product can produce send-quality videos |
| Renderball repo | `/Users/alfonsogarces/VIDEO_GEN` — Next.js 14 + Remotion 4.0.468 + TypeScript + Tailwind |
| Engine (Remotion) | ✓ Renders Composition.tsx → MP4 (1920×1080 H.264) locally; CSS @keyframes capture confirmed via standalone test |
| Stage 0 wizard | ✓ 3-step intro (website → shape → prompt) with Auto/Manual paths |
| Website crawl | ✓ V0.3 — fetches linked stylesheets + inline CSS; extracts @font-face declarations, frequency-ranked palette (8 hexes, near-grays filtered), motion signal (high/medium/low based on @keyframes + transition counts) |
| Agent 1 (Script Generator) | ✓ Sonnet 4.5; freeform + pre-structured input; multi-beat visual_concept structure; diegetic-UI instinct (Win95 / IDE / dashboard / phone / chat / browser / terminal / diff archetypes); brand palette + fonts + motion signal threaded through |
| Agent 2a (Design Agent) | ✓ Sonnet 4.5; framing: "senior frontend developer building Linear/Vercel-quality animated React sections." Pure HTML/CSS/JSX. No video vocab. Outputs static layout with all multi-beat elements present at settled positions. |
| Agent 2b (Choreography Agent) | ✓ Sonnet 4.5; framing: "senior frontend dev adding CSS-driven motion." Only @keyframes / animation / animation-delay / transition / cubic-bezier. NO useCurrentFrame / interpolate / Sequence / spring / Easing. Brief surfaced in seconds, not frames. |
| Render wrapper | ✓ Auto-generated index.tsx wraps each agent-emitted SectionN component in a Remotion <Sequence>. The only file with video vocabulary; agents never see it. Resilient to naming drift (Section{i} / Scene{i}Slide / Scene{i} / Slide{i}). |
| Brief brand cache | ✓ brand_extract cached on StoredBrief; Agent 2 receives palette + fonts + motion signal at render time without re-crawling |
| Stage 2 review UI | ✓ Editable visual_concept + text strings inline; auto-save; Render-to-MP4 button |
| Voiceover / music | ⌛ Task 10 — not yet wired (videos silent) |
| Greta freshness window | Closes ~2026-06-12 (15 days from decision) |
| Dev endpoints | `/api/dev/crawl-test?url=…`, `/api/dev/regenerate?briefId=…`, `/api/dev/render?briefId=…` for iterating without the wizard |

**Immediate next actions (build sprint, post-V0.3 architecture):**
1. **Output quality tuning** — architecture honors all 3 axioms but the latest CSS-only render had density regression (Win95 small in corner, lots of empty canvas) and timing issues (Section 1 blank at t=13s — elements opacity 0 with delays >1s into the section). Tracked as task #22.
2. **Push density bar harder in Design Agent** — explicit fail-check, maybe a structural validator that counts top-level children per Section.
3. **Add timing guardrails to Choreography Agent** — no element hidden for more than 30% of its section's duration; first beat should land before 0.5s in.
4. **Then end-to-end test** — Brian Bickell's cold-outreach video on the upgraded pipeline.
5. **If quality clears the bar by ~2026-06-08:** batch-produce 30 prospect videos and send via LinkedIn / email.
6. **Task 10 (VO + music)** — after visual quality clears the bar.
7. **Pending separately (still alive):** SEO/CTR Google Ads test (~2 hours setup, then 14 days passive).

---

## Week -1 — Strategic Planning

**Date range:** through 2026-05-25
**Status:** Complete
**Time invested:** ~15 hours across multiple sessions (initial pitch → planning → autoplan review → moat expansion → office hours → warm-list execution)

### What got built

- **`PRODUCT.md`** — 2,942 lines, 46 sections. Full product spec: thesis, problem, insight, workflow stages, who Renderball is for, brand voice, hero video concept, landing copy, competitive landscape, pricing, free tier + anti-abuse, security model, asset & licensing policy, VO catalog, technical architecture, agents, script JSON schema, agent system prompts, API V2 spec, product surface, critical states, unit economics, funding path, team & operations, 5-week sprint, 30/60/90 roadmap, 9 moats, risks, scope discipline, why now, decisions log.
- **`GTM.md`** — 497 lines. Week-0 day-by-day customer development sprint, outreach templates (LinkedIn / email / Twitter), 30-minute discovery call structure with 7 questions, target list-building criteria, tracking sheet schema, Day-10 decision gate criteria, post-launch growth motion through Day 90+, GTM metrics dashboard.
- **`PRODUCT-REVIEW.md`** — 209 lines. Autoplan review report — 4 reviewer voices (CEO / Design / Eng / DX), 38 findings, full audit trail with auto-decisions and user challenges.
- **`PROCESS.md`** — 373 lines (unchanged). Original FUSE deck-building process. Reference for technical heritage.

### Major decisions locked (17 total)

1. **Product name:** Renderball (chosen over Rendercall)
2. **Brand voice:** Premium / craft-led (Linear/Vercel/Figma tone)
3. **Positioning:** Horizontal — "anyone who wants animation-rich videos" (output-type, not segment)
4. **Subscription pricing:** $29.99/mo for 5 min at 1080p
5. **Pay-as-you-go pricing:** $9.99/min
6. **Free first minute:** yes, no card, **no watermark ever**
7. **Render floor:** 1080p (never below)
8. **Founding team:** Solo founder + AI assistants
9. **Funding path:** Bootstrap → $3–5K MRR base / $10K MRR stretch → YC application
10. **Hero video:** Recursive self-launch, front-loaded with 2-sec output freeze
11. **Launch assets:** Build fresh — no FUSE_DECKS carryover
12. **Geo:** US-only at launch, EU/UK Day 30–60
13. **VO catalog:** 8 curated voices via self-hosted F5-TTS on Modal
14. **Purpose handling:** No taxonomy — free-form text from customer
15. **Launch GTM beachhead:** YC launch cohort (under review pending Week 0 data)
16. **Composer 2.5:** Defer to Week-1 empirical model bake-off
17. **Launch date:** Day 50–60 (nights+weekends realistic)

### Reviews and stress-tests run

- **`/autoplan` full review pipeline** — CEO + Design + Eng + DX reviewers, single-voice (Codex unavailable on machine)
- **38 findings surfaced:** 9 critical + 21 high + 8 medium
- **9 critical findings:** all applied to PRODUCT.md
- **5 taste decisions:** all accepted and applied
- **13 high-severity findings:** all applied in batch with recommended defaults
- **3 user challenges:** held to original direction (horizontal positioning, no watermarks, no avatars)

### Moats expanded from 4 to 9

1. Structural cost gap vs. diffusion (8–40× per output; 1000×+ per variant)
2. Proprietary data flywheel (script corpus, QA outcomes, customer edits)
3. Multi-modal capabilities diffusion can't match (localization, A/B variants, personalization)
4. Open spec + distribution flywheel (publishable schema, customer-owned files, integrations)
5. Self-improving COGS loop (own fine-tunes at 100K renders → ~$0.26/video savings)
6. Brand safety / compliance (enterprise wedge, audit chain → $5K–$50K/mo ACVs)
7. Stripe-of-video infrastructure (Year 2+ TAM expansion, 10× larger market)
8. Speed-of-iteration (solo+AI asymmetry, public changelog as brand)
9. Public-by-default gallery (cost-to-distribution conversion, SEO + viral flywheel)

### `/office-hours` session findings

- **Demand validation gap surfaced.** PRODUCT.md had ~0 mentions of customer evidence; FUSE origin story was missing.
- **FUSE origin documented as Section 1 of PRODUCT.md.** $500–1,000/video agency spend replaced with code-driven workflow at 95%+ cost reduction. N=1 but the right kind of N=1 (founder lived both buyer and builder sides).
- **Week 0 customer development gate added** to GTM.md. 10-day (full-time) / 20-day (nights+weekends) customer dev sprint + 14-day SEO test running in parallel. Decision gate at Day 10/25 determines wedge segment.
- **Launch shifted:** Day 21 → Day 35 → Day 50–60 (nights+weekends realistic timeline).
- **YC pitch reframed:** "I built this at the company I worked at, replaced $X of agency spend, talked to 30 marketing leads in Week 0 to validate it generalized" replaces the architecture-first pitch.

### Personal logistics confirmed

- **Bandwidth:** Nights + weekends (26–44 hours/week)
- **Day-job-exit trigger:** $2,000/month MRR from Renderball
- **Personal runway:** Limited — cannot afford 6 months without paycheck; protect contractor income at FUSE until $2K MRR hits
- **FUSE relationship:** Contractor (not employee). Re-read contract — no IP claim, no conflict-of-interest, no FUSE resources used, built on personal time + savings. Will pursue FUSE as a future customer/investor.
- **Legal entity:** Deferred (Stripe Atlas at $500–1K MRR)
- **Confidentiality:** FUSE name + dollar figures stay internal; anonymized as "a fintech company I worked with" in external materials.

### Warm intros list — built and messaged

| # | Name | Company | Role | Segment fit | Status |
|---|---|---|---|---|---|
| 1 | Alejandro Herrera | VaaS | Head of Sales | Adjacent (sales-outreach video use case + intro source) | ✅ Replied — book call this week |
| 2 | Isabela Rodriguez | Zolvo (<30 ppl) | CEO | Direct buyer — small-startup CEO segment | Sent, awaiting reply |
| 3 | Elias Urrejola | SFV (<30 ppl) | CEO | Direct buyer — small-startup CEO segment | Sent, awaiting reply |
| 4 | Sebastian Gomez | (<30 ppl) | Founder/CEO | Direct buyer — small-startup CEO segment | Sent, awaiting reply |
| 5 | Mario Villegas | Magneto | SDR (intro source — wrong role for direct call) | Intro request to Magneto's marketing lead | Sent, awaiting reply |
| 6 | Nicolas Villada | Welli | CFO (intro source — wrong dept for direct call) | Intro request to Welli's marketing lead | Sent, awaiting reply |

**Removed:** Lluis Cañadell (Treinta, CEO) — not close enough to count as warm.

**Network gap:** 0 warm YC founder contacts. List B (YC launch cohort) validation runs **100% on cold outbound** (Twitter DMs + cold email). Realistic hit rate: 4–6 responses from 20 cold outbound → 2–3 booked calls. Manageable but no margin.

**Emerging insight worth tracking:** the warm list skews heavily toward **small-startup CEOs** (3 of 6 direct fits). This may indicate that small-startup CEOs are a stronger natural beachhead than YC launch cohort *for this founder specifically* — because the network has reach there. Will validate or refute in Week 0.

---

## Week 0 — Customer Development + SEO Validation (in progress)

**Date range:** 2026-05-25 → ~2026-06-19 (nights+weekends realistic ~25 days)
**Status:** Active
**Goal:** Validate (or pivot away from) the wedge segment before any code is written.

### Day-by-day plan (see GTM.md for full detail)

| Days | Block |
|---|---|
| 1–2 | ✅ Warm intros sent (6 messages); Sebastian added; Lluis removed |
| 3–5 | Build cold target lists (30 List A mid-market + 20 List B YC founders) — this weekend |
| 6–8 | Write cold outreach templates + send first batch |
| 9–14 | Send second batch + DM accepted LinkedIn connections + run early warm calls |
| 15–22 | Run remaining booked calls (target: 10 calls total) |
| 22–24 | Synthesis day → 6-section memo |
| 25 | **Decision gate:** proceed / switch beachhead / narrow / pivot / kill |

### Parallel track — SEO/CTR test

- $500 Google Ads budget across 14 days
- 10 candidate phrases tested
- Email-capture landing page on `renderball.com/test`
- Winner phrase becomes the H1 + meta + paid keyword
- **Not yet started** — schedule for this weekend after target lists are built

### Expected outputs by end of Week 0

- 10+ call transcripts with verbatim quotes
- Validated wedge segment (or explicit pivot decision)
- 5–10 warm pre-launch beta candidates
- Calibrated landing-page copy (from SEO test + customer language)
- Updated decisions in PRODUCT.md based on real data
- Day-25 decision memo at `~/.gstack/projects/renderball-product/week0-decision.md`

### Daily logging discipline (during Week 0)

Update this file at the end of each working block with:
- Outreach sent (count + names)
- Replies received
- Calls booked / completed
- Verbatim quotes worth keeping
- Surprises / pattern changes
- Energy check (sustainability for the long sprint)

---

## Weeks 1–2 — Build Sprint (not started)

**Date range:** TBD (depends on Week 0 completion)
**Status:** Gated on Week 0 decision-gate passing
**Goal:** Renderball V1 functional end-to-end

(See `PRODUCT.md` → "The 5-week sprint" for day-by-day build plan: render pipeline, agents, schema, pre-render gate, audio, billing, anti-abuse, hero video.)

---

## Week 3 — Hardening + Closed Beta (not started)

**Date range:** TBD
**Status:** Gated on build sprint completion
**Goal:** Battle-test billing + anti-abuse + render orchestrator before public launch; closed beta with 30 invited customers (including the warm-list pre-launch contacts)

(See `PRODUCT.md` → Week 3 sprint detail.)

---

## Week 4+ — Public Launch + Growth (not started)

**Date range:** Day 50–60 onward
**Status:** Not started
**Goal:** Public launch on ProductHunt + HN + YC alumni Slack + Twitter/LinkedIn launch threads; transition to 4-channel growth motion (founder content + gallery flywheel + YC alumni network + outbound sales)

(See `GTM.md` → Post-Week-0 GTM for the launch sequence and post-launch growth.)

---

## Decisions ledger (live — append as new decisions land)

| Date | Decision | Rationale | Trigger |
|---|---|---|---|
| 2026-05-25 | Add Sebastian Gomez to warm intros (replaces Lluis) | Sebastian is a closer contact; non-YC founder of small company; fits small-startup CEO segment | Founder recall |
| 2026-05-25 | Remove Lluis Cañadell from warm intros | Not close enough to count as warm | Founder recall |
| 2026-05-25 | Reframe Alejandro's call around sales-outreach-video use case | He's Head of Sales not Marketing; sales-outreach video is a real adjacent use case | Honest role-fit assessment |
| 2026-05-25 | Reframe Mario / Nicolas messages from "customer call ask" to "intro request" | SDR and CFO are wrong roles for direct customer call; can intro to right person | Honest role-fit assessment |
| 2026-05-25 | First customer call booked — Alejandro Herrera (VaaS, Head of Sales), Thu 2026-05-28 4pm COT | Same-day reply from first warm message | Outreach |
| 2026-05-25 | Cold List A search filter locked on Sales Navigator: 8 specific marketing titles (Product Marketing Manager, Director of Product Marketing, Content Marketing Manager, Head of Content, Director of Content, Brand Marketing Manager, Director of Brand, Head of Marketing) → 94 results, manageable for fast-pass review | Title narrowing converged on highest-fit roles for Renderball's wedge | List-building |
| 2026-05-25 | A/B outreach experiment for cold List A: top 10 prospects get personalized sample video + call ask; other 20 get standard text outreach. Measure response rate, call quality, beta interest at Day 25 synthesis. | Test hypothesis that personalized video outreach beats text — without compromising Week 0 discovery goal. Production cost ~5 hours for 10 sample videos using existing FUSE infra. | Founder hypothesis worth testing |
| 2026-05-25 | Apollo export filtered (1,351 → 50 high-quality leads) + Sales Nav cleanup (30 → 20 keeping good fits) → merged into single CSV at `~/Downloads/renderball-week0-merged-leads.csv` (61 leads total) | Apollo provided richer signal (funding stage, recent raise date, verified emails) that Sales Nav lacks. Merging both gives 61 leads across LinkedIn-active personas + funded-startup buyers. | List-building |
| 2026-05-25 | Company-by-company fit review: 61 leads → final top 30 at `~/Downloads/renderball-week0-top30.csv`. Tier A (13) = strongest Renderball-fit (AI-native, visual product, brand-conscious). Tier B (17) = good fit, fill out the cohort. 10 of Tier A marked "Video" for personalized sample video outreach; remaining 20 marked "Text" for standard outreach. | Renderball-fit assessment via company knowledge (Modal, Wheel the World, Slang AI top picks for visual storytelling) — not just structural signals (size, funding) | List-building complete |
| 2026-05-25 | LinkedIn URLs patched into top 30 CSV for the 7 Sales Nav rows (manually pulled from Sales Nav profile pages). Bonus: Jill D. → Jill Dornan (real surname revealed by LinkedIn slug). Final state: 30/30 LinkedIn URLs, 23/30 verified emails. | Sales Nav default export doesn't include LinkedIn URLs — manual fix-up after the fact. ~20 min of work. | List completion |
| 2026-05-27 | **Pivot from parallel A/B (video + text simultaneously) to sequential waves.** Wave 1 = 20 Text-tier sent first this week. Wave 2 = Video tier (10 incl. Greta) activated conditionally based on Wave 1 response rate (>15% = full Video tier, 5–15% = top-fit subset, <5% = pause and reassess). Greta held in Video tier, not downgraded. | Sidesteps the "build Renderball before sending Greta?" anxiety loop by deferring the video tier entirely until baseline response data is in hand. Gets signal flowing in 4–5 days instead of 1–2 weeks. Conserves the 5-hour video production budget until Wave 1 data justifies it. Cleaner experimental design — Wave 1 establishes baseline, Wave 2 measures lift. | Strategic gut-check via `/office-hours` |
| 2026-05-27 | **Cold-email drafting protocol: founder writes drafts, Claude gives feedback only — no rewrites.** | Voice has to stay Alfonso's, not a polished-Claude version. Rewrites lead to either copying wrong voice or arguing line-by-line against Claude's phrasing. Feedback-only keeps the pen in the founder's hand. | Founder correction during Greta drafting session |
| 2026-05-27 | **REVERSED Wave 1 Text-first strategy — building Renderball product before any outreach.** | Empathy argument: "putting myself in their place, the only way I would respond is with a video." Marketing-VP buyer profile genuinely won't engage with text-only outreach about a video tool. Wave 1 (text emails) would have produced low-signal baseline. Building first means: (a) we can send personalized videos, (b) "yes I want this" replies become real design-partner conversations not "let me get back to you", (c) the product itself becomes the outreach. Risk: building blind without external validation. Mitigation: founder is N=1 marketing buyer who lived this at FUSE, empathy is informed. | Founder instinct, 2 hours into the Wave 1 build |
| 2026-05-27 | **Build full stack — rendering engine + 4 agents + UI + previewable videos.** | All 4 agents per PRODUCT.md not just engine. UI is Next.js + Tailwind + light mode. Local-first (no Lambda yet). SQLite-free (file-based .data/ store). | Scope decision |
| 2026-05-27 | **Stage 0 wizard restructure: 3-step intro (website → shape → prompt) replacing the dense single-form layout.** | Sequential reduces cognitive load. Website-first unlocks background crawl during subsequent steps. Auto path = freeform prompt → Agent 1; Manual path = per-moment descriptions → Agent 1. | UX iteration based on dogfood + PRODUCT.md §106 |
| 2026-05-27 | **Single-pass agent: merged Setup Agent into Agent 1 (Script Generator).** | Setup Agent and Script Generator were doing the same work twice — describe moments, then translate to scenes. Merging eliminates the handoff, reduces API calls by half, removes brief-vs-script confusion. Agent 1 now handles freeform (auto) and pre-structured (manual) input in one pass. | Founder observation: "we're doing the same thing twice" |
| 2026-05-27 | **Real website crawl shipped (lib/crawl/extract-brand.ts).** | Server-side fetch, regex HTML parsing for title/description/og:image/theme-color/favicon/headlines. Auto-populated into script.assets.images via stable IDs (upload_N, site_favicon, site_apple_icon, site_og_image). Setup-agent/AnalyzePanel ceremony now backed by real work. | Layer 1 unlock — brand context becomes real signal not just text |
| 2026-05-27 | **Agent 2 (Coding Agent) built end-to-end.** | Per PRODUCT.md §1130 + §1615. Reads Script JSON, emits Composition.tsx in src/generated/<scriptId>/. Per-script bundle via @remotion/bundler, render via @remotion/renderer, output at public/renders/<scriptId>.mp4. Replaces the generic ElementRenderer dispatch with custom per-video code. | Task 9 from PRODUCT.md sprint plan |
| 2026-05-27 | **Schema simplification: removed scene.elements[].** | The structured array of typed primitives (text/image/shape/logo with position/size/animations) was forcing a Lego-block aesthetic on Agent 2's output — every video looked like the same template with different text. Replaced with: scene.visual_concept (1-2 sentence brief) + scene.content { texts, asset_ids } (verbatim words + assets to incorporate). Agent 2 now has full creative latitude on composition, motion, layout, atmosphere. Tradeoff: lost the in-browser Player (no structured data to dispatch); MP4 render IS the only preview. | Founder diagnosis: "the on-screen elements are limiting us tremendously" |
| 2026-05-27 | **Agent 2 reframed as designer, not translator.** | Original prompt: "implement elements[] faithfully, can NOT add or change element count, animations, positions." That instruction made the agent a JSON dispatcher — Cursor/Claude-in-IDE gets great Remotion code from a brief, ours got templates because we'd locked it down. New framing: visual_concept is the brief, content is the content manifest, Agent decides composition/motion/layout/decoration. Constraints retained: text strings verbatim, asset URLs only from manifest, no audio/video tags. | Founder insight: "if I put that prompt on any coding agent they will render it perfectly" |
| 2026-05-27 | **Per-scene visual ideation step added to Agent 1.** | For each scene the agent must internally brainstorm 3-5 distinct visual concept candidates, evaluate on message clarity + brand fit + distinctiveness, pick the strongest, write it as scene.visual_concept. Without this step the agent defaulted to template ("headline + logo + accent bar" every scene). Worked examples in prompt show what "distinct" candidates look like. | Founder ask: "for every moment the agent must come up with ideas to visually represent the message and choose the best" |
| 2026-05-27 | **Render = Agent 2; in-browser Player removed.** | Player ran the same components as render = no preview drift, BUT only worked while Script JSON had structured elements[] to dispatch. With elements[] gone, Player has nothing to render. Decision: MP4 download IS the preview. ~60-120s per render is the iteration cost. Accept it for now; revisit if iteration cycle becomes painful. | Schema simplification consequence |
| 2026-05-27 | **API key fallback: Claude Desktop sets empty ANTHROPIC_API_KEY in child-process env, overriding .env.local. lib/anthropic.ts now reads .env.local directly when process.env is empty/whitespace.** | Bug took ~30 min to diagnose. Worth a permanent fix — happens any time a terminal is launched from Claude Desktop. | Production fix |
| 2026-05-28 | **Agent 1 schema migration completed — purged ALL elements[] references from system prompt + buildUserMessage + buildRetryMessage + CREATIVITY_GUIDANCE.** | V0.2 migration was half-done. Validator + Agent 2 prompt were updated 2026-05-27 but Agent 1 was still dual-emitting visual_concept + elements[], which made Agent 2 take the dispatch path (Lego-block aesthetic). Cleaning up the prompt eliminated the regression. | Audit finding |
| 2026-05-28 | **Website crawl expanded to extract fonts + palette + motion signal from CSS.** | Old crawl pulled only theme_color and meta tags — leaving most of a site's design DNA on the table. New crawl fetches up to 5 stylesheets in parallel (5s timeout each, 500KB cap), parses @font-face blocks for family + woff2 URL, regex-extracts colors with near-gray filtering + RGB-distance dedup, counts @keyframes + transitions for motion signal. Stripe: 8 colors + Sohne + SourceCodePro + high motion. Fuse: 8 colors + Neue Montreal + medium. ~1.4s total per site. | User insight: "we should improve the website crawl" |
| 2026-05-28 | **brand_extract cached on StoredBrief.** | brand_extract was previously only stored transiently in wizard state — Agent 2 lost access to it at render time. Cache it on the brief so both agents see the same brand DNA. Adds ~5KB per brief. | Plumbing follow-up |
| 2026-05-28 | **Agent 2 split into two passes: Design Agent (Pass 1) + Animation Agent (Pass 2).** | Single-pass Agent 2 was framed as "code a video" — biased the model toward motion choreography over slide density. Output read as "thing floating in void." Splitting puts the model's strong slide-design prior to work in Pass 1, then layers motion in Pass 2. Pass 1 outputs static designed Composition.tsx. Pass 2 takes that + script and adds motion. Both passes saved on disk (Composition.design.tsx + Composition.tsx) for debugging. ~2× API cost per render (~$0.18 vs ~$0.09), ~30s added latency. Acceptable for the quality jump. | Founder ask: "we should never tell agent 2 they are coding a video" |
| 2026-05-28 | **Three axioms locked: (1) frontend-coding agent never knows it's a video; (2) animation agent never knows it's a video; (3) renderer records the frontend invisibly.** | Sharpens the architecture. The agents have a strong prior for great web design (Linear / Vercel / Stripe homepage sections); they have a weaker prior for "motion graphics." Frame the work as web frontend, not video. | Founder axiom statement |
| 2026-05-28 | **Choreography Agent CSS-only: pure @keyframes / animation / animation-delay / transition / cubic-bezier. NO useCurrentFrame / interpolate / spring / Sequence / Easing.** | Honors axiom 2. Brief surfaced to the agent in seconds, not frames (rewriteFramesToSeconds in buildAnimationUserMessage). Hard-constraint section at top of prompt explicitly forbids Remotion video primitives. | Axiom enforcement |
| 2026-05-28 | **Verified Remotion captures pure CSS @keyframes correctly.** | Built a standalone test composition using only CSS animations (slideIn + pulse + label fade). Rendered. Frames at t=0, t=0.9, t=2.5 all showed correct animation progression. Remotion's headless Chromium mocks the document timeline; CSS animations tick frame by frame as expected. Foundation verified before rewriting 750 lines of prompts. | Architecture verification |
| 2026-05-28 | **Wrapper code is the only Remotion-aware layer: auto-generated index.tsx imports the agents' SectionN components and wraps each in a <Sequence>.** | Honors axiom 3. Resilient to naming drift via pickSection() that tries Section{i}, Scene{i}Slide, Scene{i}, Slide{i}. Lives in app/api/dev/render/route.ts (buildIndexTsx) and app/review/[id]/actions.ts. | Architecture |
| 2026-05-28 | **Removed the FUSE-specific worked example from Agent 1's prompt; diversified to 4 diegetic-UI archetypes spanning developer / consumer / analytics / AI domains.** | Original "Cold outreach to ops leaders about legacy enterprise tool" example was structurally FUSE's Rescue Fund wedge. Renderball serves any brand — biasing toward legacy-replacement narrows the agent's instinct. New worked examples: IDE+terminal for dev tools, phone mockup for consumer apps, dashboard for analytics, chat for AI products. Also added VS Code + dashboard code archetypes to Design Agent's vocabulary (peer to Win95 + modern card). | Founder ask: "this is a product for any company — stop referencing such specific examples" |
| 2026-05-28 | **Deleted stale lib/agents/prompts/coding-agent.ts (orphan from the single-pass era).** | No imports referenced it; dead code from the V0.2 architecture. | Cleanup |
| 2026-05-28 | **Agent 1 now writes visual_concept timing in SECONDS, never frames.** Updated prompt + all worked examples + buildUserMessage to forbid "Frames X-Y:" / "at frame N" phrasing. Replaced with "From Xs to Ys:" / "at 2.4s". | Closes the V0.3 axiom loophole — even though Pass 2's input had a frames-to-seconds shim, the SCRIPT itself was still video-vocabulary'd from the moment Agent 1 wrote it. Both Pass 1 and Pass 2 now see seconds-only language at every input layer. The script.json is video-vocabulary clean. | Founder feedback: "visual description still mentions frames like if it had to do a video" |
| 2026-05-28 | **`Math.random()` ABSOLUTELY FORBIDDEN in Design + Choreography Agent prompts.** | Latest render had 3× `Math.random()` calls that re-randomized per render pass → visible "static energy" jitter across the captured frames. Strengthened both prompts with explicit hardcoded-static-arrays examples. | Founder feedback: "the video looks like it has static energy, frames moving up and down" |
| 2026-05-28 | **`feTurbulence` SVG noise now requires explicit `seed='2'` + `stitchTiles='stitch'` in the Design Agent grain template.** | Without a seed, some renderers regenerate the noise pattern per frame, producing the same static-jitter symptom. Updated the grain code archetype. | Same root cause as Math.random — non-determinism between captured frames |
| 2026-05-28 | **Safe-area guardrail added to Design Agent: 1920×1080 canvas with 80px inset for primary content; decorative atmosphere may bleed past edges.** | Latest Stripe render had the AI Wallet capability card with `width: 1400` positioned such that the "Settlement" tile clipped off the right edge. Design Agent had no concept of a "safe area" — used negative offsets indiscriminately. New rule: primary content (headlines, cards, diegetic UI, CTAs, charts) MUST fit within an 80px inset; only orbitals/embers/gradient blobs/grain may extend past. | Founder feedback: "part of the rendering is not shown in the video" |
| 2026-05-28 | **Pass 1 user message reformatted to per-section briefs in seconds — no raw script JSON dump.** | Previously buildDesignUserMessage dumped JSON.stringify(input.script) which exposed start_frame/end_frame integers to Pass 1. Replaced with a structured "Sections to design" list giving each section's label, intent, duration_seconds, visual_concept (seconds-rewritten), and verbatim copy. Pass 1 never sees a frame count. | Belt-and-suspenders for the axiom |
| 2026-05-28 | **/plan-eng-review audit → six-fix axiom-compliance sweep landed.** A focused engineering review of orchestration vs the three axioms surfaced 11 leaks. Six fixes executed in one sweep: (1) Schema migration `start_frame`/`end_frame` → `start_seconds`/`end_seconds`; `fps` dropped from Script.config; wrapper does seconds→frames conversion at the render boundary. (2) Purged "video" / "Remotion" / "captured frames" / "rendered video" / "render pass" / "Coding Agent" / "video task" / "frame N" / frame-to-seconds translation guidance from all three agent system prompts. (3) Hid Remotion behind sibling `Img.tsx`: agents import `{ Img } from "./Img"` instead of `from "remotion"`. The shim file is dropped next to each generated Composition.tsx. (4) Renamed `lib/agents/coding-agent.ts` → `pipeline.ts`; `generateRemotionCode` → `buildAnimatedSections`; `CodingAgentInput`/`CodingAgentResult` → `BuildInput`/`BuildResult`. (5) Extracted wrapper-building (duplicated across dev/render route and review actions) into a single `lib/render/build-wrapper.ts` module — the only video-aware file, header marked. (6) Flattened the asset-context user message to a clear id→URL list with an inline `<Img src="...">` snippet, eliminating raw JSON dumps. | Founder ask: "make sure the way the product is orchestrated respects the axioms" → /plan-eng-review pass |
| 2026-05-28 | **Asset surface: explicit URL-paste prompt + warning that script.assets.images is an array.** | First render after the flatten broke because the agent inferred `script.assets.images.site_favicon` (object lookup) from the flat id→URL listing. Added an inline `<Img src="...">` example with literal URL pasted, plus a warning line: "Don't write `script.assets.images.someId` — `images` is an Array." Next render succeeded. | Render-failure debug |
| 2026-05-28 | **Content schema rebuilt: flat `texts[]` → typed slots (eyebrow / headline / lede / bullets / caption / meta / cta / illustration).** | Diagnosed via `/plan-eng-review`. Renders had 0 `<p>`, 0 `<svg>`, 1 headline per section. Root cause: `content: { texts: string[] }` is shapeless — Agent 1 dumped 1-4 strings per section and the Design Agent had nothing else to render. Restructured the schema with typed fields; validator enforces `headline` required + length caps. After the change, Stripe regen produces eyebrow + headline + lede + 3 bullets + caption + illustration intent per section (was: 1 headline per section). Render now has 5 SVGs (was 0). | Founder ask: "why is there very little frontend and the text is just big headlines" |
| 2026-05-28 | **SVG Illustration Library added to Design Agent prompt: 14 codified inline-SVG archetypes.** | checkmark, arrow-flow, lock, gear, concentric-rings, phone-mockup, browser-tab, code-window, dashboard-grid, stat-counter, line-chart, bar-chart, sparkline, data-waterfall + freeform intent. Agents set `content.illustration` based on visual_concept; Design Agent picks the matching SVG from the library. Closes the "0 SVG illustrations" gap. | Same review |
| 2026-05-28 | **Blur ceiling: max 40px on CSS `filter: blur(...)`.** | Render still had subpixel jitter ("static energy" the user kept seeing) despite Math.random + feTurbulence-seed fixes. Root cause: `blur(80px)` / `blur(100px)` / `blur(120px)` on background "glow" elements. Large Gaussian blurs cause subpixel rendering instability between frames in headless capture. Hard rule: ≤40px. Use box-shadow spread or radial-gradient backdrop for wider soft-glow effects. After the change, all blurs in latest render are ≤4px. | Same review |
| 2026-05-28 | **Pass 1 quality gate with retry: counts headlines + paragraphs + SVGs against structured content and retries once on shortfall.** | `assessDesignDensity()` in pipeline.ts checks the Design Agent's output for element counts matching what the script's structured content fields ask for. If the agent renders a section without the headline / lede / bullets / illustration that the schema specified, the gate retries Pass 1 with a specific failure message. One retry max; if both fail it proceeds with what we have. Permanent enforcement of density at the orchestration layer, not just the prompt layer. | Same review |
| 2026-05-28 | **visual_concept structure: timeline-storyboard → composition + animations list.** | Founder spotted that visual_concept still read like a video shot list ("From 0s to 1.7s: X enters. From 1.7s to 3.8s: Y happens."). Agent 1 was producing storyboard prose because the prompt's "Beat structure" section instructed it to. That framing forces the Design Agent to reverse-engineer the static composition from a narrative — a translation step that biases toward video framing. New form: visual_concept is a 2-part frontend brief — a Composition sentence (static elements like describing a Linear hero section) + an Animations list (each entry = element + animation name + timing). Both passes consume their native part directly. Closes the last storyboard leak in the agent surface. All 9 worked examples migrated. | Founder review of moment-1 visual_concept |
| 2026-05-28 | **Render quality bumped: CRF 18 + jpegQuality 95.** | Default H.264 settings produced visibly compressed output. CRF 18 is "visually lossless" (5-10x file size of default for crisp text + edges). RENDER_QUALITY const lives in lib/render/build-wrapper.ts; both renderMedia callsites consume it. | Founder ask: "the video feels low quality" |
| 2026-05-28 | **Sustained-motion + font-enforcement rules added to Design Agent prompt + quality gate.** | User saw dead-air ("scene stagnant after animations finish, waits multiple seconds until next scene"). Cause: Design Agent rendered explicit entry animations but no sustained loops. Fix: HARD RULE "≥2 infinite-loop animations per section" in Design Agent prompt; Agent 1 pacing rule requires last entry beat by 60-75% of duration. Font issue: only 2 fontFamily decls existed across 16 text elements in the last render. New rule: every text element MUST set fontFamily to a brand font; quality gate fails Pass 1 if <60% coverage. Latest render: 21 fontFamily decls + 9 infinite animations. | Founder ask: "animations go fast then stagnant; fonts not actually used" |
| 2026-05-28 | **Crawl expanded: body_excerpts, page_images, logo_hd (with Clearbit fallback).** | Founder asked for body-content extraction (veracity), page-image extraction (real product imagery), and HD logo (favicon was 32×32 .ico — blurry). New extractors: extractBodyExcerpts (p+li dedup, skips boilerplate, max 12), extractPageImages (filters tracking pixels, max 8, auto-allocated as site_img_0,1,..), discoverLogoHd (3-tier fallback: <img class/alt/src=logo → static paths /logo.svg etc → Clearbit Logo API → apple-touch-icon last resort). Headlines now deduped (previously emitted duplicates because brand sites repeat h1 in a11y wrappers). Threaded through BrandExtract → AgentBrandExtract → user messages → buildPreallocatedAssets. Stripe render now mounts stripe.com/img/logo.png (HD) instead of a 32×32 favicon. SPA limitation: body_excerpts often empty on JS-rendered sites — Playwright-level fix deferred. | Founder ask: list of 6 issues including HD logo + content extraction |
| 2026-05-28 | **Aspect-ratio default flipped to 16:9.** Agent 1 was choosing 9:16 from "social media" keywords (falabella render produced unwanted portrait). New rule in script-generator prompt: default 16:9; choose 9:16 only when brief EXPLICITLY mentions TikTok / Reels / Stories / Shorts / vertical / mobile-first. "Social media" alone → 16:9. Picking the wrong aspect ratio is the worst config error — it can't be papered over by good design. | Falabella diagnosis: brief said "social media launch" → got 9:16, user expected 16:9 |
| 2026-05-28 | **Palette discipline HARD rule: never invent colors from subject matter.** Falabella render contained `#dc0000` (Spider-Man red) in 3 visual_concepts even though red wasn't in the crawled palette. Agent 1 was associating colors with IP / brief subject (Spider-Man → red, Christmas → green-red, luxury → gold). New rule in script-generator + design-agent: USE ONLY crawled palette hex codes verbatim. Subject matter is what the brand TALKS about, not how the brand LOOKS. Darkening/lightening crawled hexes for backgrounds is OK (same hue family); inventing new hues is not. Design Agent reinforces with: define `PALETTE` const at module scope containing ONLY crawled hexes; never inline a hex outside it. | Falabella diagnosis: 3 invented red declarations baked into PALETTE.red |
| 2026-05-28 | **Dead-air quality gate (post-Pass-2) with retry.** Falabella render's 42 finite animations had max delay of 2.6s — for a 30s video. Every section had all events front-loaded into 0-1.5s then froze. New `assessDeadAir()` in pipeline.ts scans Section{N} bodies, parses `animation: "..."` declarations, computes max finite (`forwards`) delay per section, requires ≥60% of section duration. Fails → retry Pass 2 once with named offending sections + plausible late beats (color shift / accent extend / secondary card / CTA pill / logo glow pulse / gradient transition). Animation Agent prompt + Script Generator prompt also got concrete numeric pacing tables (4s→2.4s min, 8s→4.8s min, 30s→18s min). | Falabella diagnosis: scenes 8s/11s/11s with finite events ending at 1.2s/2.2s/1.6s — massive dead-air |
| 2026-05-28 | **Impact / shake animations HARD-capped at ≥0.4s duration with decaying amplitude.** Falabella render had `screenShake 0.15s` on the SPIDERMAN headline (4.5 frames at 30fps at full amplitude). Against an otherwise-static composition, sub-0.2s shakes read as render bugs / jitter, not impact. New rule in design-agent: shake-family animations must run ≥0.4s with amplitude decaying across the timeline; loop-shakes forbidden unless representing seismic / vibration content. Prefer spring-scale overshoot or 200ms flash overlay for "impact" energy. | Falabella diagnosis: jitter source identified as 0.15s screenShake |
| 2026-05-28 | **Aspect-ratio-aware composition rules + canvas dimensions threaded into user message.** Design Agent prompt hardcoded 1920×1080 in 5 places; Pass 1 user message always said "1920×1080" regardless of `config.aspect_ratio`. Falabella 9:16 portrait: SPIDERMAN headline overflowed horizontally because composition rules assumed landscape. Fix: pipeline.ts now imports `dimensionsForScript` from build-wrapper and writes the real W×H + aspect + safe-area-inset + per-aspect composition guidance into the Canvas section of the user message. Design Agent prompt got a new "Aspect-ratio-aware composition" HARD RULE with per-aspect guidance: 16:9 = horizontal layouts; 9:16 = VERTICAL STACKING IS THE LAW (three-panel concepts stack top-to-bottom, headlines wrap to 2-3 lines, top/middle/bottom thirds); 1:1 = centered symmetric single-focus. Safe-area inset tightens to 64px for portrait/square (vs 80px for landscape). | Falabella diagnosis: 9:16 portrait with landscape composition rules → broken frame coverage |
| 2026-05-28 | **Italic-accent emphasis HARD RULE.** Every headline must wrap 1-3 emphasis words in `<em style={{ fontStyle: "italic", color: BRAND_ACCENT }}>`. This is the FUSE deck's signature editorial-typography move (`modern war`, `five years`, `like a fintech`, `100% automated`, …) — without it headlines feel like template slide titles. Added to Design Agent prompt with template + 5 "forbidden" counter-examples. Validator counts `<em` ≥ headline count and retries Pass 1 on shortfall. | Deck quality-gap analysis — the single most visible "premium" typography move missing in renderball output |
| 2026-05-28 | **Cross-section BrandChrome HARD RULE.** Defined a shared `<BrandChrome sceneIndex totalScenes eyebrow? category? />` component pattern at module scope. Every `Section{N}` renders it identically — brand mark top-left, category pill top-right, pagination dots bottom-center. Only `sceneIndex` and `category` vary; structure does not. Forces cross-scene visual consistency that premium decks have by default. | Deck quality-gap analysis — Renderball generated each Section independently, lost continuity |
| 2026-05-28 | **Font role classification: display/body/mono extracted from crawled fonts.** New `classifyFontRoles()` in `extract-brand.ts` uses family-name heuristics: mono if name contains `mono/code/courier/consol/menlo/jetbrains/source code/fira code`; display (serif) if name contains classic serif families (`tiempos/merriweather/playfair/lora/freight/garamond/caslon/bodoni/didot/minion/miller/noe/times/georgia/...`); body for everything else. Threaded through `BrandExtract.font_roles` → `AgentBrandExtract.font_roles` → Design Agent user message as concrete `FONT_DISPLAY/FONT_BODY/FONT_MONO` constants. Design Agent now routes `<h*>` → display, `<p>/lede` → body, URLs/code → mono — instead of slapping one font on everything. | Quality lift roadmap H2 |
| 2026-05-28 | **Vision input to Design Agent (reference-image grounding).** Anthropic Messages first-turn content now includes image blocks for `brand_extract.og_image` + `logo_hd` + top 3 `page_images` (cap 4 total). These are TASTE PRIORS — the brand's actual visual language (typography mood, palette in context, composition density). Added a prompt section explaining: study the references, DO NOT mount them literally, DO NOT copy compositions wholesale, treat as direction. Cost: ~$0.015 added per Pass 1 first call (vision tokens). The single highest-leverage move in the quality lift. | Quality lift roadmap H1 — without vision input the agent reverse-engineers "premium" from text only |
| 2026-05-28 | **Img shim browser-safe.** Was: `export { Img } from "remotion"` — works in Remotion's bundle, blows up in vanilla Next.js. Now: tries `require("remotion").Img`, catches the error, falls back to `(props) => React.createElement("img", props)`. Same shim works in MP4 render context AND the new preview page. Renderball uses no Remotion-specific Img features so the fallback is loss-free. | Preview flow A1 — bridge for the Composition.tsx to mount in browser without Remotion runtime |
| 2026-05-28 | **Preview-before-MP4 flow shipped.** New `/preview/[id]` route mounts the agent-emitted Composition.tsx in the browser, plays scenes back-to-back via CSS animations + key-remount on scene change, includes scene selector + play/pause + replay-scene + "Regenerate scene N" button. Backed by new `regenerateScene()` in pipeline.ts (passes existing Composition.tsx as context, asks agents to replace ONE Section while keeping rest byte-identical) and `/api/preview/regenerate-scene/route.ts`. New `loadBriefByScriptId()` in store.ts recovers brand context from scriptId. Stage 2 review UI gets a "Preview →" button next to "Render to MP4". Iteration cost: ~10s per per-scene regen vs ~60-120s for MP4. Trade-off documented: CSS-animation timing in browser is "directionally accurate", not frame-perfect — MP4 capture is the truth. | Founder ask: "let the user visualize the frontend being rendered and the animations before making it an MP4. Per-moment regeneration to iterate before committing." |
| 2026-05-28 | **Build-preview endpoint + `skipRetries` flag.** New `/api/preview/build` runs both agent passes and writes files to `src/generated/<id>/` but skips bundle + MP4 capture (~60-120s vs ~13min with retries). `buildAnimatedSections()` accepts `{ skipRetries: true }` — preview path uses it to bypass density + dead-air retries (one-shot iteration). MP4 render path keeps strict gates. Initial first build cost was 13 minutes because both quality gates fired their retries; skipping them brings the first iteration down to ~90s. | Founder pain: "it's been building for a couple minutes" → diagnosis showed both retries firing on a single first build |
| 2026-05-28 | **Img shim simplified to plain `<img>` everywhere.** Was: `require("remotion").Img` with try/catch fallback. The require succeeded in browser bundle but Remotion's `<Img>` calls `useVideoConfig()` which throws outside a `<Composition>` — breaking the preview page. New shim: always render native `<img>`. Tradeoff: lose Remotion's frame-perfect loading semantics during MP4 capture, but Puppeteer's `waitUntil: "networkidle0"` already waits for image loads, so the practical capture behavior is equivalent. Same shim now works in both browser preview and Remotion render bundle. | Founder hit `Unhandled Runtime Error: No video config found` on preview refresh |
| 2026-05-28 | **F1 — Hallucination guardrail (strict mode).** Agent 1 + Design Agent prompts get HARDEST RULE: no specific number / date / dollar / percentage / timeframe / multiplier in `scene.content` unless it appears in `body_excerpts` or `brief.about`. Validator `findInventedClaims()` regex-scans Composition.tsx visible text for currency/percentage/timeframe/count tokens and fails the gate if any token is not in the source corpus. Catches Agent 2 inventing "$2.4M EXIT FEE" from a "$1M–$3M" range. Falabella Spider-Man + Fuse rescue-fund renders confirmed the issue (made-up exit penalties, migration windows, 90-day timelines). | Founder QA: "we are making stuff up like the $2.4M exit fee" |
| 2026-05-28 | **F2 — logo_hd + page_images filtering (customer-logo grids).** `discoverLogoHd` was picking the first `<img>` whose tag contained "logo" — but on Webflow sites the first such image is usually in a "trusted by" grid of customer logos (Fuse's render showed CFSB.png in two spots as if it were Fuse's mark). Fix: restrict search to images inside `<header>`/`<nav>` (or top 6KB body fallback), skip files matching `[A-Z]{2,6}\\.png` customer-acronym pattern, skip tags surrounded by `customer/client/partner/trusted-by/logo-grid/case-stud` class context. Same filter applied to `extractPageImages` so the page_images list isn't 8 customer logos. | Founder QA: "we brought in 2 logos (CFSB and Fuse logo)" — actually both were CFSB |
| 2026-05-28 | **F3 — Bullets enforcement tightened.** Validator's bullet count was lenient (`<li>` OR extra `<p>`), letting the agent drop bullets entirely without failing. Generated Composition.tsx had 0 `<li>` + 0 `<ul>` despite 3 bullets in script content. Fix: STRICT — only `<li>` counts. Added literal `<ul><li>` template to Design Agent prompt with brand-accent marker patterns and 4 forbidden counter-examples (div rows, single li with breaks, lede-merge, drop). | Founder QA: "the space on the bottom of the frame not being used" |
| 2026-05-28 | **F4 — Lucide icons integrated (1,500+ free MIT icons).** `npm install lucide-react@1.17.0`. Added Design Agent prompt section listing 30-40 common icons by category (Security: Shield/Lock/Key; Status: Check/AlertCircle; Growth: TrendingUp/Activity; etc.) with usage rules: 12-18px inline, 20-32px markers, 48-80px hero, `strokeWidth: 1.75` for premium feel. Decision: don't build our own icon library — use lucide. Hand-coded SVG Illustration Library stays for larger brand-specific hero illustrations. | Founder Q: "would it be worth it to build a library of icons" → no, use lucide |
| 2026-05-28 | **F6 — Icon-font filter in font role classifier.** `classifyFontRoles` was picking `webflow-icons` as both display + body roles on Webflow sites (Fuse's site exact case). Added `ICON_FONT_RX` matching common icon font names (webflow-icons, material-icons, font-awesome, fa-*, glyph*, lucide-icons, simple-icons, feather, hero, tabler, phosphor, etc.) — classifier skips matches before considering them for roles. Now Neue Montreal correctly picked as both display and body for Fuse. | Same QA round — display/body were misclassified as icon fonts |
| 2026-05-28 | **Structural logo fix — read-time sanitizer for cached briefs.** `looksLikeCustomerLogo(url)` + `sanitizeBrandExtract()` in pipeline.ts re-applies the F2 customer-logo filter at READ time on cached `logo_hd`, `page_images`, and `script.assets.images`. Means old briefs cached before F2 landed auto-correct without re-crawl. Applied at both `buildAnimatedSections` and `regenerateScene` entry points. Asset list filtering means even if a cached `site_logo` points at CFSB.png, the agent never sees it. | Founder ask: "solve the logo thing structurally, don't make the user recrawl" |
| 2026-05-28 | **M3 — Diegetic-UI specificity HARD RULE (Agent 1).** Added prompt section: when visual_concept references a diegetic UI mock, NAME the specific editorial labels that appear inside it. Concrete examples for dashboards ("Auto-Approve · 60%, Manual Review · 32%, Decline · 8%"), code editors ("POST /loans/{id}/approve route handler with 4 lines: validate, score, log, return JSON 200"), phone mockups (header + step counter + 2 filled input fields + CTA button name). Closes the "shallow diegetic UI" gap that made Renderball outputs feel templaty vs the deck's Stripe-quality specificity. Placeholder/decorative values are explicitly allowed (\`Acme Corp\`, \`Loan #4421\`) — invented real-looking specifics are still blocked by F1 guardrail. | Founder ask: diegetic UI doesn't have brand-specific editorial weight |
| 2026-05-28 | **M1 — Split-asymmetric 16:9 default.** Design Agent prompt's 16:9 composition rule was "compositions CAN use horizontal layout" (permissive). Changed to: **DEFAULT IS SPLIT** — editorial copy left (~50-55% width), diegetic UI / hero element right. Centered/symmetric is the EXCEPTION (openers/closers, massive stat callouts, 4+-element grids). Matches FUSE deck's actual pattern. If visual_concept doesn't suggest a right-zone hero, the agent must INFER ONE — empty right halves are forbidden. | Quality lift M1 |
| 2026-05-28 | **M2 — KPI tile mapping for content.meta.** Promoted `meta` slot mapping from generic "footer key-value grid" to: **if values are numeric/data-style → KPI tile grid** with bordered tiles, brand-accent labels (uppercase tracking-wide), large display-weight values, lucide `<TrendingUp/TrendingDown/Minus/Activity/Clock/Users/Building2/Banknote/DollarSign>` indicators by label semantics. Literal `<div>` grid template included in prompt. Footer key-value row still used for non-numeric meta (event/date/topic-style). Forbidden patterns documented. | Quality lift M2 |
| 2026-05-28 | **L3 — Strikethrough + underline as typography moves.** Codified two HARD-RULE-adjacent patterns: strikethrough (used on terms being REPLACED / DEPRECATED — FUSE deck slide 1 "outdated technology") + underline (used on the thesis word/phrase — FUSE deck slide 4 "AI native"). Both templates in prompt include opacity tuning (0.55 on struck phrases), accent-bar positioning (54% line-height for strike, baseline-6/-8px for underline), and slight rotation for hand-drawn feel. Pairs with italic-accent — the deck's signature combo is italic + accent-color + underline on the SAME word. | Quality lift L3 |
| 2026-05-28 | **N1 — Verified claims wizard field.** Added textarea to the wizard's `intro_website` step ("Verified claims — one per line, optional"). Threaded through `ClientBriefDraft.verified_claims` → `BriefInput.verified_claims` → `StoredBrief.verified_claims` → `AgentBrief.verified_claims` → `BuildInput.verified_claims` → all 4 callsites (review actions, dev render, preview build, preview regenerate-scene). Agent 1 user message surfaces "Verified claims" block with ✓ markers; agent may repeat these verbatim. `findInventedClaims()` validator now accepts `verifiedClaims` as a 3rd source corpus alongside `body_excerpts` and `brief.about` — eliminates the hallucination root cause for SPA brands where the static crawl returns little body content. | Quality lift N1; root-cause fix for hallucination on JS-rendered sites like Fuse |
| 2026-05-28 | **A1 — Scalable logo discovery rewritten.** Old `discoverLogoHd` walked the DOM first and only fell back to meta. This is fundamentally unreliable on marketing sites where customer-logo grids contain the first `<img>` tags. New priority order: (1) Clearbit Logo API by domain — ~95% hit rate for known brands, always returns brand mark, (2) og:image if it's a recognized image format — brand-curated, (3) common static paths (`/logo.svg` etc.) same-origin only, (4) `<img>` walk inside `<header>`/`<nav>` restricted to same-origin OR filename containing the brand label, (5) apple-touch-icon last resort. | Founder QA: "took one of the customer logos again" |
| 2026-05-28 | **A2 — Logo-grid container detection.** New `stripLogoGridContainers()` removes entire `<section>`/`<div>`/`<ul>`/`<aside>` regions whose class/id/data-attr matches `trusted/customer/partner/client/logos-grid/-cloud/-marquee/-strip/-list/-wall/-bar/-row/-carousel` etc. before `extractPageImages` and `discoverLogoHd` see the HTML. Handles nested containers via depth-tracking. Catches lowercase customer logos (tcfcu.png) that filename heuristics missed. | Same QA round; covers Webflow customer-marquee patterns |
| 2026-05-28 | **B1 — Contrast + gradient HARD rule in Design Agent.** Full decision matrix in prompt: minimum WCAG ratios per element role (4.5:1 body, 3:1 large text), solid-vs-gradient guidance per surface type (cards/tiles/buttons solid; section backgrounds + atmospheric layers gradients OK), concrete palette pairings with computed contrast ratios as ✅/❌ examples, 5 forbidden patterns codified. Answers founder's question "when is contrast valuable and when not." | Founder QA: "elements are similar colors and hard to see" |
| 2026-05-28 | **B2 — Contrast validator (warn-level).** WCAG luminance + contrast-ratio computation in pipeline.ts. Parses `color:`/`background:` adjacent pairs inside inline `style={{ }}` blocks, resolves `PALETTE.foo` tokens via a module-scope const scan, computes contrast, surfaces any sub-4.5:1 pair as a soft warning. New `BuildResult.warnings` field returns `{invented_claims, low_contrast, missing_charts}`. Doesn't fail Pass 1 — surfaces to user on review/preview UI (next step). | Same QA round; companion to B1 |
| 2026-05-28 | **C1 — Industry-grade visual libraries installed.** `npm install recharts shiki simple-icons`. Recharts: data viz (line/bar/area/pie/scatter/funnel). Shiki: syntax-highlighted code blocks. Simple-icons: 5,000+ brand logo SVGs for partnerships/social-proof grids ("backed by Stripe + OpenAI", "as featured in TechCrunch"). | Founder Q: "leverage open source libraries especially industry grade" |
| 2026-05-28 | **C2 — Library + diegetic-primitive vocabulary expanded in Design Agent prompt.** Added: (a) Library decision table — when to reach for Recharts vs simple-icons vs Shiki vs lucide vs hand-coded SVG, with literal import + usage patterns; (b) Diegetic UI primitive vocabulary — 40+ primitive patterns we can render natively (forms: text/select/checkbox/radio/toggle/date-picker; status: alerts/toasts/progress/skeletons/empty-states/badges; nav: tabs/accordion/breadcrumb/sidebar/pagination/modal/popover/command-palette; data: table/comparison/pricing-grid/leaderboard/timeline/kanban/funnel/org-chart/network/heatmap/file-tree; industry mocks: inbox/chat/calendar/map/video-player/code-review/PR-card; editorial: quote-block/pull-quote/stat-callout/numbered-step/before-after-slider/countdown/typing-text/counter). Answers founder's "what can we render reliably" with concrete options. | Founder Q: "most of the visuals are still boxes — what can we pull through effectively?" |
| 2026-05-28 | **C3 — Missing-chart soft warning.** When `content.meta` has ≥2 numeric values OR `visual_concept` matches chart-keyword regex (growth/trend/over-time/distribution/percentage/breakdown/conversion/funnel/year-over-year/before-after), `findMissingCharts` surfaces a warning if zero Recharts imports detected. Soft signal in `BuildWarnings.missing_charts` — doesn't fail Pass 1 but nudges via the review UI when we should have used a real chart. | Same C2 round; companion validator |
| 2026-05-28 | **Bug 3 — Box-sizing border-box in SECTION_FRAME.** Default `box-sizing: content-box` + `width: 100%` + `padding: 80px` on a section produces a 2080px border-box on a 1920px canvas, pushing right-side content (cards in horizontal splits, KPI bars, etc.) past the canvas right edge. Section1 of the Fuse render visibly cropped because of this. Added `boxSizing: "border-box"` to the SECTION_FRAME template + a HARD RULE explaining when to apply it and when not to (decorative atmosphere layers without padding don't need it). | Founder QA: "the right of scene 2 is cropped on the right and did not fit the frame" |
| 2026-05-28 | **Bug 2 — Wizard palette role picker (new intro_colors step).** Extracted palette is frequency-ranked from CSS, so for Fuse the saturated link-blue #0050bd became "primary" and got used as the section background — but Fuse's actual brand bg is a darker navy. Frequency ≠ semantic role. New intro_colors wizard step shows the 8 crawled swatches with role-assignment buttons (primary / accent / light / dark), live preview of the choice. Threaded through `ClientBriefDraft.palette_roles` → `BriefInput.palette_roles` → `StoredBrief.palette_roles` → `BuildInput.palette_roles` → Agent 1 user message as AUTHORITATIVE role assignment that overrides the frequency-ranked guess. Optional step — skipping defaults to auto-pick. Includes preview card showing `primary` bg + `accent` italic accent + `light` text so the user sees the choice before committing. | Founder QA: "that tone of blue used for the background is not the main color of the website" |
| 2026-05-28 | **Bug 1a — Vision-evaluated logo discovery agent.** Old priority-chain `discoverLogoHd` picked og:image as a top-2 fallback, but og:image is the share-card (often a screenshot/hero shot), not the brand mark — for Fuse it produced a JPG screenshot rendered as the "logo." New approach: `collectLogoCandidates()` gathers a list from Clearbit + same-origin static paths + header/nav `<img>` + simple-icons brand match + apple-touch-icon + og:image + favicon. The list passes to a new Claude Sonnet 4.5 vision agent (`lib/crawl/find-logo-agent.ts`) that evaluates all images and picks the one that IS the brand's mark — NOT a customer logo, NOT a share-card image. Agent has Anthropic `web_search_20250305` tool available to find additional candidates when crawled ones are weak (falls back gracefully when tool isn't available). Validates the chosen URL with a HEAD probe. Returns ok+url+rationale OR ok:false (in which case wizard prompts user to upload). Latency: ~10-20s per discovery; runs inside the existing async crawl. | Founder ask: "set up an agent that finds the logo and then evaluate the best possible logo in the website or online, and if not found, prompt the user to upload" |
| 2026-05-28 | **Bug 1b — Wizard logo upload fallback.** When the discovery agent returns NONE, the wizard's `intro_website` step shows a prominent amber-bordered "Upload your logo (PNG or SVG)" prompt directly under the URL crawl status. User-uploaded file is tracked separately from `brand_files` and sent as `file_logo` in the form data; server-action marks it with `is_logo: true` on `StoredFileRef`. `buildAgentInputFromBrief` checks for `brand_files.find(f => f.is_logo)` and uses its URL as `logo_hd` ahead of any crawled value — even synthesizing a minimal `brand_extract` when no crawl happened. Means brands like Fuse (Webflow text-wordmark, no extractable image) can ship a properly-branded video with one click. Replace button + visible "marked as brand logo" confirmation in the UI. | Same ask — completes the auto-find → user-fallback loop |

(Append new rows as decisions land.)

---

## Learnings log (live)

| Date | Learning | Source |
|---|---|---|
| 2026-05-25 | Warm network skews to small-startup CEOs, not YC founders or mid-market marketing leads. This may shift the beachhead segment after Week 0. | Warm-list assembly |
| 2026-05-25 | The FUSE origin story is more powerful than any architectural detail in PRODUCT.md. Should anchor the YC application. | /office-hours session |
| 2026-05-25 | First-time founder warm-list mistake is reaching out by relationship strength, not role-fit. Half the warm contacts I built are wrong role — need to be repositioned as intro sources. | Warm-list role-fit review |
| 2026-05-27 | **LLMs writing structured JSON elements produces Lego-block aesthetic. Freeform visual brief + content manifest unlocks creative output.** When we made Agent 2 dispatch elements[] one-to-one, every video looked the same. When we gave it just a prose visual_concept + the words to incorporate, output became visually distinct per video. The constraint isn't the model — it's the schema shape. | Schema iteration during Agent 2 build |
| 2026-05-27 | **Per-scene visual ideation (brainstorm → pick → describe) is the unlock for visual diversity.** Without forcing the agent to enumerate distinct candidates, it defaults to one obvious treatment per scene. With it, each scene gets a unique visual concept that the coding agent can then realize. | Agent 1 iteration |
| 2026-05-27 | **Claude Desktop's child-process env overrides project .env.local.** Any terminal launched from Claude Desktop inherits ANTHROPIC_API_KEY="" (empty string), which Next.js prefers over .env.local. Permanent fix: read .env.local directly when process.env value is empty. | API key debug session |
| 2026-05-27 | **Agent role-framing dominates output quality.** Same model, same script, same brand — but Agent 2's output went from generic to brand-feeling when we changed the prompt from "render elements faithfully" to "you are the designer, realize the visual_concept." The shackles were in our prompt, not the model. | Agent 2 reframe |
| 2026-05-27 | **The "preview" / "render" UX split matters.** When the in-browser Player exists, edits cost ~0s to verify. When only MP4 render exists, every edit costs ~60-120s to verify. Editing UX has to anticipate this — auto-save, batch edits, render-only-when-ready. | UX consequence of schema change |
| 2026-05-27 | **Building before validating is sometimes the right call when the founder IS the buyer profile.** Empathy is N=1 but the right kind of N=1: lived the buyer side at FUSE, can credibly say "I would only respond to video." Office-hours framework treats this as legitimate when founder has earned the right via domain experience. | Strategic decision context |
| 2026-05-28 | **A model's framing matters more than its prompt's rules.** Telling Agent 2 it was "coding a video" + giving Remotion vocab biased every output toward motion-graphics thinking — sparse, frame-driven, low-density. Reframing as "frontend dev building Linear-quality animated sections" + giving CSS vocab tapped the model's much stronger prior for web design. Same model, same model size, dramatically different output. The wedge between "this is a video" and "this is an animated webpage" is a vocabulary boundary, not a capability one. | Two-pass split + axiom enforcement |
| 2026-05-28 | **Input language poisons output language faster than prompt rules can prevent.** First attempt at CSS-only Choreography Agent: prompt forbade Remotion, but the user message included visual_concept text with "Frames 0-80: …" phrasing. Agent ignored the prompt and produced 44 useCurrentFrame/interpolate calls + zero @keyframes. Fix: rewrite "Frames X-Y:" to "From Xs to Ys:" before passing to the agent. Word-for-word matters — the model echoes the vocabulary it sees in input. | CSS-only debugging |
| 2026-05-28 | **Website CSS is a brand-DNA goldmine.** Just parsing @font-face blocks + counting color tokens + counting keyframes gave us the EXACT fonts each brand uses (Stripe → Sohne + SourceCodePro, Vercel → Geist + Geist Mono, Linear → Inter Variable + Berkeley Mono, Fuse → Neue Montreal), a 6-8 color palette ranked by site usage, AND a motion-density signal. ~1.4s per site, zero ML, ~250 lines of regex. The crawl is the cheapest leverage in the system. | Crawl expansion |
| 2026-05-28 | **Naming-style drift is endemic when prompts evolve.** Design Agent prompt said to export Section{N}. Animation Agent output drifted to Scene{N}Slide (residue from an older prompt example). Wrapper expected Section{N} and rendered nothing. Defensive pickSection() that tries multiple naming conventions is cheap insurance — costs 4 lines, prevents silent black-frame renders. | Wrapper bug |
| 2026-05-28 | **A 2026-05-27 render that looked "good" was actually still dispatch-mode.** The Capability Trio + Stripe AI Wallet render produced semantic icons + multi-color palette, which looked like a real designer made it. But it was Pass 2's frame-driven interpolate calls doing the heavy lifting. Switching to CSS-only architecture temporarily LOST that quality because the model is less practiced at composing CSS @keyframes than at writing interpolate(). Quality gain isn't free — even when the architecture is right, the model needs another tuning pass for the new vocabulary. | CSS migration regression |
| 2026-05-28 | **Remotion's headless Chromium captures CSS animations correctly.** Counter-intuitive given Remotion's frame-counter-driven mental model, but proven with a standalone 4-second test composition. The browser's document timeline is mocked frame-by-frame; CSS @keyframes / animation-delay / transitions all progress normally. This is the foundation that lets the CSS-only architecture work. | Architecture validation |
| 2026-05-28 | **`Math.random()` in CSS-animation-context React = guaranteed visual jitter.** The render pass evaluates the component multiple times during capture; each evaluation re-rolls Math.random, so any element whose position/opacity/size/delay was computed via random gets a different value per frame → static-noise effect across the whole video. Same root cause as un-seeded `feTurbulence`. Lesson: any CSS-driven Remotion composition needs ALL non-deterministic primitives stripped from the React code. Static arrays only. | Jitter debugging |
| 2026-05-28 | **The axiom must be enforced at the SCRIPT level, not just at the agent boundaries.** First attempt at "frontend agent never knows it's a video" worked at the prompt level for Pass 2 but failed because Pass 1 saw the script's visual_concept which contained "Frames 0-60:" prose. The agent inherited the video framing from the data, not from the prompt. Real fix: Agent 1 writes visual_concept in seconds so the script itself is video-vocabulary clean. Downstream agents inherit web-vocabulary naturally. | Axiom debugging |
| 2026-05-28 | **Safe-area as a first-class design constraint.** Web developers' instinct is "elements extend past viewport on overflow:hidden" because that's safe at runtime. In a captured video, off-canvas content is just gone. The Design Agent had no concept of a safe area — used negative offsets indiscriminately for both decoration AND primary content. Adding an explicit 80px-inset rule with "decorative-only past the edge" framing gave the agent a concrete heuristic. | Off-canvas debugging |

(Append new rows as observations land.)

---

## Open risks (tracking weekly)

| Risk | Status | Closing action |
|---|---|---|
| N=1 demand validation (only FUSE) | Active | Week 0 customer development sprint |
| Zero warm YC founder contacts → List B is 100% cold | Active | Twitter/LinkedIn 2nd-degree search + accept lower hit rate |
| Nights+weekends sustainability over 16 weeks | Monitor | Energy check at Week 6; off-ramp plan documented in PRODUCT.md |
| $2K MRR achievability by Day 90–130 | Monitor | First check at Day 60 actual MRR |
| FUSE relationship management (future customer/investor potential) | Open | Have the courtesy conversation before public launch |
| Personal financial runway depends on contractor income | Active | Don't quit FUSE until $2K MRR is hit and stable for 30 days |
| Adobe entering enterprise tier territory (Moat 6) | Monitor | Watch Adobe Firefly Video product updates monthly |

---

## Session handoff (current thread state)

**Updated:** 2026-05-28, end-of-session (V0.3 architecture session)
**Status:** **V0.3 architecture landed: two-pass CSS-only pipeline + full brand-DNA crawl.** All three founder axioms honored. Output quality is the open issue.

### The three axioms (locked 2026-05-28)

1. **The frontend-coding agent never knows it's a video.** It's a senior frontend developer building a beautiful animated React section, like Linear / Vercel / Stripe homepage hero work.
2. **The animation/choreography agent never knows it's a video.** It's a senior frontend dev adding CSS-driven motion via @keyframes / animation-delay / transitions.
3. **We record the frontend performing — that's how it becomes a video.** Remotion captures the React component frame-by-frame; the agents never see Remotion.

These axioms drove the V0.3 architecture refactor. The agents have a much stronger prior for great web design than for motion graphics, so the framing change unlocks output quality.

### What got built / changed this session — architecture

**`/Users/alfonsogarces/VIDEO_GEN`** — Next.js 14 + Remotion 4.0.468 + TypeScript + Tailwind. File-based store at `.data/`.

```
VIDEO_GEN/
├── src/                          Remotion rendering side
│   ├── schema.ts                 Script schema (V0.2 — visual_concept + content)
│   ├── Composition.tsx           Top-level composition (legacy)
│   ├── Root.tsx                  Composition registry (legacy)
│   ├── components/               (legacy generic renderer — kept for back-compat)
│   ├── examples/launch-15s.ts    Reference script
│   └── generated/<scriptId>/     Per-render artifacts (gitignored)
│       ├── Composition.design.tsx  Pass 1 output (static designed JSX)
│       ├── Composition.tsx         Pass 2 output (final, with CSS animations)
│       ├── script.json             Script the agents rendered
│       └── index.tsx               Auto-generated wrapper (Remotion <Sequence> shell)
├── app/                          Next.js UI
│   ├── new/                      Stage 0 wizard (unchanged from V0.2)
│   ├── review/[id]/              Stage 2 review (renderScriptToMp4 now wraps two-pass)
│   └── api/dev/                  Dev-only endpoints
│       ├── crawl-test/route.ts   GET ?url=… — times the crawl, returns extracted fields
│       ├── regenerate/route.ts   GET ?briefId=… — re-runs Agent 1 with current prompt
│       └── render/route.ts       GET ?briefId=… — re-runs Pass 1 + Pass 2 + bundle + render
├── lib/
│   ├── anthropic.ts              SDK wrapper + .env.local fallback (model registry)
│   ├── store.ts                  StoredBrief now caches brand_extract
│   ├── crawl/extract-brand.ts    V0.3 — parses linked stylesheets for @font-face, palette, motion
│   └── agents/
│       ├── coding-agent.ts       PIPELINE — orchestrates Pass 1 → Pass 2; preserves external interface
│       ├── script-generator.ts   Agent 1 runner
│       ├── schema-validator.ts   Agent 1 output validation
│       └── prompts/
│           ├── script-generator.ts  Agent 1 — multi-beat visual_concept + diegetic-UI vocabulary
│           ├── design-agent.ts      Pass 1 — frontend dev framing, CSS-only static layout
│           └── animation-agent.ts   Pass 2 — choreography agent, pure CSS @keyframes
└── .data/
    ├── briefs/<id>.json          Brief + cached brand_extract
    ├── scripts/<id>.json         Agent 1 output
    └── render-bundle/<scriptId>/ Cached Remotion bundle
```

### V0.3 pipeline — render flow

User submits brief → Agent 1 produces Script JSON → user reviews/edits → clicks Render → server action calls `generateRemotionCode()` which internally:

1. **Pass 1 (Design Agent):** receives Script + brand context. Outputs static `Composition.tsx` with `Section{N}` named exports — every element at its settled position, no animation imports beyond `Img`. Framing: "senior frontend dev building Linear/Vercel-quality animated sections."

2. **Pass 2 (Choreography Agent):** receives Pass 1's static file + the script (with multi-beat visual_concepts rewritten from "Frames X-Y:" to "From Xs to Ys:" so the agent thinks in seconds, not frames). Outputs the SAME file with `<style>{ANIMATIONS_CSS}</style>` injected per Section + inline `style={{ animation: "name duration delay easing forwards" }}` on elements. Framing: "senior frontend dev adding CSS motion."

3. **Wrapper code (ours):** generates an `index.tsx` that imports each `Section{i}` and wraps in a Remotion `<Sequence>` per the script's `start_frame`/`end_frame`. The only Remotion-aware code. Resilient to naming drift via `pickSection()` that tries `Section{i}` / `Scene{i}Slide` / `Scene{i}` / `Slide{i}`.

4. **Bundle + render:** `@remotion/bundler` + `@remotion/renderer` capture the wrapped component to an MP4.

Both intermediate files saved on disk for debugging:
- `src/generated/<scriptId>/Composition.design.tsx` — Pass 1 output
- `src/generated/<scriptId>/Composition.tsx` — Pass 2 final
- `src/generated/<scriptId>/index.tsx` — wrapper

### V0.3 crawl — what gets extracted

Server-side fetch with 10s HTML timeout + up to 5 stylesheets fetched in parallel (5s each, 500KB cap):

- **Meta:** title, description, og:image, theme-color, favicon, apple-touch-icon, first 3 h1/h2 headlines
- **Fonts:** parses `@font-face` blocks from inline `<style>` + linked CSS. Returns `{ family, src (woff2 URL), weight, style, format }`. Stripe: Sohne + SourceCodePro. Fuse: Neue Montreal × 2. Vercel: Geist × 5 + Geist Mono × 2. Linear: Inter Variable × 2 + Berkeley Mono.
- **Palette:** regex extracts all hex + rgb/rgba colors. Filters near-grays (RGB max − min ≤ 8). Deduplicates near-duplicates (RGB Euclidean distance < 12). Ranks by frequency, prepends theme-color if present. Returns top 8. Stripe: 8 colors including signature #533afd. Fuse: 8 including burgundy #440c12.
- **Motion signal:** counts `@keyframes` + `animation:` + `transition:` declarations. Weighted score → "high" / "medium" / "low". Drives Choreography Agent's motion density expectations.

`BrandExtract` is cached on `StoredBrief.brand_extract` so Pass 2 sees the same DNA at render time without re-crawling.

### Agent prompts — current state

**Agent 1 — Script Generator** ([lib/agents/prompts/script-generator.ts](lib/agents/prompts/script-generator.ts), ~420 lines):
- Brainstorms 3-5 distinct visual concepts per scene; picks strongest
- Multi-beat visual_concept with explicit frame ranges ("Frames 0-80: X. Frames 80-200: Y…")
- Diegetic-UI instinct: reaches for Win95 / IDE / dashboard / phone / chat / browser / terminal / diff archetypes when the moment names a system or interface
- Uses brand palette colors by hex, brand font family names by name
- Worked examples cover 3 shapes (Investor Series B, TikTok Black Friday, Developer-tool API launch) + 4 diegetic-UI examples (IDE, phone, dashboard, chat) — no FUSE-specific copy

**Pass 1 — Design Agent** ([lib/agents/prompts/design-agent.ts](lib/agents/prompts/design-agent.ts), ~500 lines):
- Framing: "senior frontend developer at a top brand studio" building Linear/Vercel-quality animated React sections
- Output: static Composition.tsx, one `Section{N}` per scene as named exports
- Density mandate: 6-10 visual elements per section minimum (eyebrow + display headline + lede + primary content + atmospheric chrome + brand chrome + meta)
- Visual vocabulary archetypes (12 codified moves): glass card, multi-stop gradient backdrop, orbital rings, drifting embers, grain noise, eyebrow, display headline with italic-color emphasis, meta grid, Win95 chrome, modern card, VS Code chrome, dashboard chrome
- Diegetic UI trigger conditions list — picks the chrome that matches the brand's domain
- Multi-beat scenes: ALL beat content present in static design; Pass 2 reveals each beat in time

**Pass 2 — Choreography Agent** ([lib/agents/prompts/animation-agent.ts](lib/agents/prompts/animation-agent.ts), ~375 lines):
- Framing: "senior frontend dev specializing in CSS-driven motion"
- HARD CONSTRAINT at top of prompt: no `useCurrentFrame`, no `interpolate`, no `Sequence`, no `spring`, no `Easing`, no `useState`/`useEffect`/`setTimeout`, no frame counts
- Output: preserves Pass 1's structure; adds `<style>` blocks with `@keyframes` + inline `style={{ animation: "..." }}` on elements
- CSS animation patterns codified: fadeRise, scaleIn, letterSettle, breathe, drift, drawWidth, typeReveal, stutterType, blink, drawCheck, dim, glow, sweep, cinematicZoom
- Brief surfaced in seconds (not frames) — `rewriteFramesToSeconds()` rewrites "Frames X-Y:" to "From Xs to Ys:" before sending

### What's verified

- ✅ Remotion captures pure CSS `@keyframes` correctly. Proved with a standalone 4-second test composition; frames at t=0/0.9s/2.5s all showed correct animation progression.
- ✅ Pass 1 outputs zero video vocab (only `Img` from Remotion).
- ✅ Pass 2 outputs zero video vocab (only `Img` from Remotion); 47 `@keyframes` + 29 `animation:` properties in latest Fuse render.
- ✅ Wrapper code is the only Remotion-aware layer; agents never see Sequence/Composition/AbsoluteFill.
- ✅ Type-check clean across all changes.
- ✅ End-to-end render (Fuse legacy LOS brief) succeeded with new architecture.

### What's not working yet (the open issue)

Visual output quality regressed when switching to CSS-only architecture. The 2026-05-27 single-pass renders looked "good" because Agent 2 was writing `interpolate()` calls — output the model is well-practiced at. CSS-only output has these gaps:

1. **Density bar not enforced** — Design Agent sometimes ignores the 6-10 element mandate. Latest Fuse Scene 0: Win95 window at ~25% of canvas, vast empty burgundy space, no eyebrow, no headline, no meta footer.
2. **Animation timing bugs** — Choreography Agent set many elements to `opacity: 0` initial state with `animation-delay > 1s`. Latest Fuse Scene 1: blank dark gradient at t=13s because nothing has faded in yet.

Both are prompt-tuning problems, not architecture problems. The CSS-only foundation is solid. Tracked as task #22.

### Agents NOT YET built

- **Agent 3 (QA Agent)** — vision-based diff report against script. PRODUCT.md §1655.
- **Agent 4 (Tweak Agent)** — natural-language post-delivery tweaks. PRODUCT.md §1704.

### Known gaps still

- **Silent video.** Audio not wired. VO via ElevenLabs + music bed = Task 10.
- **No retry loop on Pass 2.** Bundle/render errors surface raw; user retries manually.
- **AnalyzePanel doesn't surface what the crawl found.** Wizard shows generic spinner labels — user has no visible signal that fonts/palette were extracted. Worth a UI iteration.
- **Per-render bundle cost.** First render ~90-180s with two-pass (was 60-120s single-pass). Subsequent renders of same script faster (bundle cached).

### Cost / latency per render (V0.3)

- ~$0.18 Anthropic spend (was ~$0.09 single-pass)
- ~90-180s total (Pass 1 ~30s + Pass 2 ~30s + bundle + render ~60-90s)
- ~2× cost is acceptable for the quality jump the architecture enables (once output is tuned)

### How to resume in a new session

> "Continuing Renderball build. Read `/Users/alfonsogarces/VIDEO_GEN/docs/PROGRESS.md` end-to-end, especially the Session Handoff. V0.3 architecture: two-pass CSS-only pipeline (Design Agent + Choreography Agent) + brand-DNA crawl (fonts + palette + motion signal). The three founder axioms are: (1) frontend agent never knows it's a video, (2) animation agent never knows it's a video, (3) we record the frontend → MP4. All three are honored — verified by zero Remotion vocab in agent code. The open issue is OUTPUT QUALITY: latest Fuse render had density regression (Scene 0 sparse) + animation timing bugs (Scene 1 blank at t=13). Pick up at task #22: tighten Design Agent's density bar enforcement + add timing guardrails to Choreography Agent. After that → Task 10 (VO/music) → Brian Bickell test render → batch the 30-prospect cohort."

The new session reads PROGRESS.md, picks up at task #22 (output quality tuning). PRODUCT.md is still the canonical spec but needs updating to reflect the V0.3 two-pass architecture + the three axioms (currently describes single-pass Coding Agent in §1615). CSVs in `~/Downloads/` are durable. Cold-outreach drafts in PROGRESS.md history.

### Open Greta clock

Greta Workman's Series C video shipped ~2026-05-22. Freshness window for the cold-outreach hook: 2-3 weeks. **Deadline ~2026-06-12.** If V0.2 produces send-quality output, batch-produce 30 videos by ~2026-06-08 and send via LinkedIn DM / cold email. If quality isn't there by then, defer outreach further and keep iterating on the pipeline.

---

## Historical reference — pre-reversal cold-outreach context (preserved for when Renderball can produce real videos)

> **The following content is from the Wave-1 strategy that was REVERSED 2026-05-27. It's kept as reference because the Aaron Epstein framework, Greta research, and earlier Greta draft will all be useful when the product is ready to actually send personalized videos. Treat this as a stash, not current state.**

### Aaron Epstein's 7 principles (structural anchor — for when we DO send outreach)

1. **One focused goal per email** — single ask, no paradox of choice
2. **Be human** — write how you talk to a friend, read it out loud
3. **Personalize via "uncommon commonality"** — something you uniquely share with this person (same college, same past employer, their specific recent post, mutual connection). NOT "love what you're doing at [Company]"
4. **Short** — phone-readable, hit-reply-able
5. **Establish credibility** — for Renderball, the FUSE origin story is the anchor ("at a Series A fintech I worked with, we paid agencies $500–1k per launch video; I built an internal tool that replaced it for ~$5")
6. **All about the reader, not you** — first paragraph entirely about them; "I" only enters as quick context
7. **Clear call to action** — own paragraph, concrete next step, 3 specific time slots beats Calendly link

### Renderball cold-email anatomy (six beats)

```
1. Subject line — short, intriguing, specific to them, not pitchy
2. "Hey [First name]"
3. Opening: the uncommon commonality (most important sentence)
4. Bridge: quick context + FUSE story for credibility
5. The ask: ONE thing (15-min call + 3 specific time slots)
6. Sign off like to a friend ("Thanks, Alfonso" — no title, no corporate signature)
```

### Wave 1 — Text tier (active drafting)

**Target list:** 20 Text-tier prospects from `~/Downloads/renderball-week0-top30.csv`

**Next concrete step:** rank the 20 by uncommon-commonality strength (~30 min). One sentence per name on what makes them not-just-cold. Strongest commonalities get drafted first to calibrate voice on highest-leverage prospects.

**Drafting approach:** Per-prospect personalized emails using Aaron's six-beat structure. FUSE origin story carries credibility (no video to lean on, unlike Wave 2). Founder writes; Claude feedback-only.

**Open micro-decisions for Wave 1:**
1. **Sending cadence:** all 20 in one batch, or staggered over 2–3 days? Staggered lets you tune the message based on early responses; one-batch gets parallel data.
2. **Time-zone for ask slots:** ET vs PT vs let-them-pick per prospect (most are US-based, mix of coasts — probably pick per prospect based on company HQ).
3. **Sign-off:** "Alfonso" alone (locked — Aaron's friend-tone principle).

### Wave 2 — Video tier (held, conditional activation)

**Status:** Deferred pending Wave 1 response rate.

**Activation triggers** (read ~Day +5 from Wave 1 send batch):
- **>15% response** → activate full Video tier, send to all 10 incl. Greta
- **5–15% response** → activate Video tier to top-fit subset only (Greta + 2–3 others)
- **<5% response** → pause Video tier, reassess Week 0 strategy before video production investment

**Greta Workman (Modal) — held in Video tier, research preserved for activation:**

LinkedIn research findings:
- Head of PMM at Modal (joined Sep 2025, 9 months in)
- Previously: Head of PMM at Vercel for 4.5 years (first PMM hire, built team from zero, created "Frontend Cloud" category)
- Before that: 7 years at Neo4j (deeply technical infra company)
- Education: Barnard College + Columbia University (Economics)
- Recent post 4d ago: reposting Modal's $355M Series C announcement video with quote "palpable developer love for the product, the clear conviction of the founders"
- Recent post 2w ago: about admiring GTM folks — "sharp, adaptable, fearless"

Uncommon commonalities identified:
1. Her specific quoted line about "palpable developer love" — strongest opener
2. The $355M Modal Series C video she just personally shipped 5 days ago (she IS a customer for this kind of tool, right now). **Timing window: stays open ~2–3 weeks from her ship date — Wave 2 needs to activate before that closes.**
3. Vercel reference — gold standard for B2B SaaS launch marketing, she built it

Greta's draft email (founder-written, no-CTA charm-first variant — preserved for Wave 2 send):
```
Subject: [TBD]

Hey Greta, I saw Modal's series C announcement and made this animated
video for your team to share internally or externally (if you like it).

I made it with the tool I am building for video gen and wanted to share
it with you because I think your product marketing is the best in the
game since Vercel. Being honest, just wanted you to see my product and
share if something like this could be valuable for your team some day.
```

Open items if Greta is pulled into Wave 2 send:
- Subject line not yet picked
- "I am building" phrasing has an integrity edge — Renderball doesn't exist as a product yet, only the FUSE-internal precursor. Either restore FUSE-origin context, soften phrasing, or accept the framing risk. Resolved before any Wave 2 send.
- Video itself not yet produced (gating artifact)
- "If she replies 'I want this now'" response: design-partner offer, not panic — see `/office-hours` log above

### Pending Thursday 2026-05-28 4pm COT
Alejandro Herrera (VaaS) warm call — focus: sales-outreach video discovery + intro to VaaS marketing lead. (Still active — call is unrelated to the product-build reversal.)

(End of pre-reversal cold-outreach reference. Current state is the V0.2 build session handoff above.)

---

## How to use this file

1. **End of each working block:** add a line to the relevant week section with what got done + what's pending
2. **End of each week:** update the "Where we are right now" header with current status
3. **Whenever a decision lands:** append to Decisions Ledger
4. **Whenever a pattern emerges from real data:** append to Learnings Log
5. **Monthly:** review Open Risks for status changes

This file is the single source of truth for "where are we and what's next." PRODUCT.md is the spec; GTM.md is the playbook; PROGRESS.md is the run-state.
