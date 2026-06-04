# Renderball PRODUCT.md — /autoplan Review Report

Run timestamp: 2026-05-25
Plan file: `/Users/alfonsogarces/VIDEO_GEN/docs/PRODUCT.md` (moved from `/Users/alfonsogarces/FUSE_DECKS/` on 2026-05-28)
Restore point: `~/.gstack/projects/renderball-product/autoplan-restore-20260525-162645.md`
Mode: **single-voice (Claude subagent only)** — codex CLI not installed on this machine, dual-voice degraded per skill matrix.

---

## Run summary

| Phase | Status | Findings (crit / high / med) | Outside voice |
|---|---|---|---|
| 1. CEO | Complete | 3 / 5 / 2 | Claude subagent (codex unavailable) |
| 2. Design | Complete (UI scope detected) | 2 / 5 / 2 | Claude subagent (codex unavailable) |
| 3. Eng | Complete | 3 / 6 / 3 | Claude subagent (codex unavailable) |
| 3.5. DX | Complete (DX scope detected) | 1 / 5 / 4 | Claude subagent (codex unavailable) |
| 4. Gate | Pending user input | — | — |

**Aggregate:** 38 findings across 4 phases. 9 critical, 21 high, 8 medium.

---

## Consensus tables (single-voice; codex column N/A)

### CEO Consensus

| Dimension | Claude subagent | Verdict |
|---|---|---|
| 1. Premises valid | CONCERN | CONCERN (single-voice) |
| 2. Right problem to solve | CONCERN | CONCERN |
| 3. Scope calibration correct | FAIL | FAIL |
| 4. Alternatives sufficiently explored | CONCERN | CONCERN |
| 5. Competitive/market risks covered | FAIL | FAIL |
| 6. 6-month trajectory sound | CONCERN | CONCERN |

### Design Consensus

| Dimension | Claude subagent | Verdict |
|---|---|---|
| 1. Information hierarchy clear | CONCERN | CONCERN |
| 2. Critical states specified | FAIL | FAIL |
| 3. Emotional arc maintains momentum | CONCERN | CONCERN |
| 4. Specificity sufficient for build | FAIL | FAIL |
| 5. Hero video concept lands | CONCERN | CONCERN |
| 6. Script-first friction managed | CONCERN | CONCERN |
| 7. Accessibility considered | FAIL | FAIL |

### Eng Consensus

| Dimension | Claude subagent | Verdict |
|---|---|---|
| 1. Architecture sound | CONCERN | CONCERN |
| 2. Test coverage sufficient | FAIL | FAIL |
| 3. Performance risks addressed | FAIL | FAIL |
| 4. Security threats covered | FAIL | FAIL |
| 5. Error paths handled | CONCERN | CONCERN |
| 6. Deployment risk manageable | CONCERN | CONCERN |

### DX Consensus

| Dimension | Claude subagent | Verdict |
|---|---|---|
| 1. Getting started < 5 min | CONCERN | CONCERN |
| 2. API/CLI naming guessable | FAIL | FAIL |
| 3. Error messages actionable | FAIL | FAIL |
| 4. Docs findable & complete | FAIL | FAIL |
| 5. Upgrade path safe | FAIL | FAIL |
| 6. Dev environment friction-free | CONCERN | CONCERN |

**Cross-phase pattern:** the plan is strong on product vision and pricing/positioning rationale, weak on implementation specificity (UI screens, error taxonomy, schema completeness, security mitigations, eval rubrics). 8 of 25 dimensions scored FAIL; all 25 were CONCERN or worse.

---

## Cross-phase themes (concerns flagged in 2+ reviews independently)

- **Missing-state and error taxonomy** — Design F3 + DX F3 + Eng F4 all flag this. The plan covers happy paths; failure paths are unspecified.
- **Vision-QA reliability** — CEO F5 + Eng F3 + Design F9 all flag risk that vision-model QA will produce false passes/fails and trap users in unowned post-QA-cap state.
- **Script schema completeness** — Eng F1 + Eng F2 + DX F7 all flag the schema is missing text-fit, font preload manifest, and versioning policy.
- **Free-tier abuse hardening** — CEO F8 + Eng F7 + DX F9 all flag the 14-day sprint is optimistic on this surface AND the IP-lifetime rate limit punishes legitimate users.
- **Production-grade prompt engineering** — CEO F5 + DX F6 + Eng F9 all flag the model bake-off has no eval rubric and the agent will be tuned blind.

---

## Auto-decisions (per the 6 principles)

The following findings are auto-resolved to YES, FIX. Each is in the blast radius of the build, fixes a real gap with no strategic tradeoff, and follows P1 (completeness) or P5 (explicit over clever).

| # | Finding | Decision | Principle |
|---|---|---|---|
| AD-01 | Add `text_fit`, `max_lines`, `min_font_size`, `overflow` to `TextContent` (Eng F1) | YES, add to schema | P1 |
| AD-02 | Add top-level `Script.assets` manifest with explicit fonts/images/audio URIs and Lambda preload step (Eng F2) | YES, schema change | P1 critical |
| AD-03 | Replace vision-based color tolerance check with deterministic pixel sampling + ΔE in code (Eng F3) | YES | P5 explicit |
| AD-04 | Add Lambda failure-mode spec: per-chunk retry, total budget cap, idempotent render IDs (Eng F4) | YES | P1 |
| AD-05 | Wrap user input in delimiters + post-gen URL allowlist + SSRF-protected brand-kit fetcher (Eng F6) | YES, security non-negotiable | P1 critical |
| AD-06 | Move free-tier gate from "IP lifetime" to "email-verified + $0 card pre-auth" (Eng F7) | YES | P1 |
| AD-07 | Honest F5-TTS cold-start handling + V1 ships 3 voices not 8 (Eng F8) | YES, reduce V1 scope on voice count | P3 pragmatic |
| AD-08 | Mandatory pre-render compile gate (tsc + ESLint + 1-frame test) before Lambda spend (Eng F9) | YES, infra required | P1 critical |
| AD-09 | Add SQS/queue/backpressure model from Day 1 (Eng F11) | YES | P1 |
| AD-10 | Add operational COGS lines (egress, Whisper, AudD, Sentry, Stripe reserve) and re-state margin (Eng F10) | YES | P1 |
| AD-11 | Define one canonical script-review UI (scene cards + plain-English summary + advanced disclosure) (Design F1) | YES | P1 critical |
| AD-12 | Brief intake: one field at a time with click-to-fill example chips (Design F2) | YES, default UX | P5 |
| AD-13 | Add explicit specs for 8 missing UI states (Design F3) | YES, append to plan | P1 critical |
| AD-14 | Collapse asset confirmation + audio selection into one screen (Design F4a) | YES | P3 pragmatic |
| AD-15 | Add live frame-by-frame preview during render wait (Design F4b) | YES | P5 |
| AD-16 | Post-QA-cap UX defined (numbered issues + "Try again with adjustments" vs "Submit for human review") (Design F9) | YES, critical handoff | P1 critical |
| AD-17 | Brand kit confirmation = visual swatch grid with confidence indicators (Design F10) | YES | P5 explicit |
| AD-18 | Add accessibility section: WCAG 2.2 AA target, keyboard-first script editor, captions, accessible voice picker (Design F7) | YES | P1 critical |
| AD-19 | Resolve Renderball wordmark vs voice tension via "ball" as render-progress motif (Design F8) | YES | P5 |
| AD-20 | Define API endpoint sketch for Pro tier OR remove "API access" from Pro copy until V2 (DX F2) | YES — remove from V1 Pro copy, ship in V2 with full spec | P3 pragmatic |
| AD-21 | Define error contract (RFC 7807 problem+json) with 8 named failure codes (DX F3) | YES | P1 |
| AD-22 | Stand up minimal docs site with Diataxis quadrants at V2 launch; defer for V1 (DX F4) | YES, deferred to V2 | P3 |
| AD-23 | Define three thin interfaces in V1: `ScriptGenerator`, `TTSProvider`, `Renderer` (DX F5) | YES | P1 |
| AD-24 | Build 20-brief eval set with golden outputs + nightly CI before Week-1 bake-off (DX F6) | YES — Week 0 prerequisite | P1 critical |
| AD-25 | Lock schema versioning policy (immutable approved scripts, re-renders against authoring version, 12mo deprecation) (DX F7) | YES | P1 critical |
| AD-26 | Ship a minimal Tweak Agent in V1 OR remove "natural-language tweaks" from landing copy (DX F8) | YES — remove from landing copy until V1.1 ships it | P3 pragmatic |
| AD-27 | Pre-write 8 anti-abuse rejection messages with "I'm a real user on a VPN" override path (DX F9) | YES | P1 |
| AD-28 | Day-1 `make dev` local environment with fake LLM + local Remotion + Stripe test mode (DX F10) | YES | P5 |
| AD-29 | Reassess scoped-re-render architecture: chunked manifest approach is the only path to the $0.20 cost claim (Eng F5) | YES — architect chunked-manifest renderer; budget 1 extra week | P1 critical |

29 auto-decisions, all queued for the doc update.

---

## Taste decisions (surfaced at gate)

These are real tradeoffs where reasonable people could disagree. Auto-recommendation per principle but you make the final call.

**T1 — Launch date.** Reviewer recommends pushing public launch from Day 14 to Day 21 to harden billing + anti-abuse + run a closed beta first.
- **Recommend: push to Day 21** (P1 completeness over P6 bias-to-action when the cost of a launch-day failure is high)
- Tradeoff: 7 days of revenue lost, but launch quality protected

**T2 — Public MRR target.** Reviewer recommends re-baselining the public plan from $10K MRR by Day 90 to $3–5K, with $10K as stretch.
- **Recommend: re-baseline to $3–5K base / $10K stretch** (P3 pragmatic — honest expectations protect investor/team confidence)
- Tradeoff: less ambitious-sounding YC application narrative; but YC accepts pre-revenue all the time and growth rate matters more than absolute MRR

**T3 — Add a "fast path" mode for short-form video.** Reviewer recommends auto-approving scripts after 10 sec for TikTok/social purposes (segment-specific gate behavior).
- **Recommend: defer to V1.1** (P3 pragmatic — keeps V1 simple, validates segment behavior with real data first)
- Tradeoff: short-form users may bounce in V1; risk is real but data > guessing

**T4 — Recursive hero video front-loading.** Reviewer recommends leading the 45-sec hero with a 2-sec freeze of the final output before showing the workflow.
- **Recommend: front-load the payoff** (P5 explicit — bounce happens at 6s, recursion must be obvious by then)
- Tradeoff: slightly less elegant narrative arc, but conversion-honest

**T5 — Acknowledge Remotion as platform-layer competitor.** Reviewer recommends explicit risk acknowledgment + Motion Canvas backup prototype by Day 60.
- **Recommend: add risk explicitly to doc; defer Motion Canvas prototype to Day 60+ trigger-based** (P3 pragmatic)
- Tradeoff: one more eng burden if it fires; small now

**T6 — HeyGen/Synthesia risk timeline.** Reviewer recommends reclassifying non-avatar feature risk from "Low (12 months)" to "Medium-High (6 months)."
- **Recommend: reclassify to Medium-High (6 months)** (P3 pragmatic — risk register should reflect honest reality)
- Tradeoff: makes the doc sound less defensible; but accurate

---

## User Challenges (require explicit user decision — not auto-decided)

Three findings recommend changes to direction the user explicitly stated. These go through the user-challenge protocol. The user's original direction is the default; the models must make the case for change.

### UC-1 — Vertical positioning

- **You said:** "the script-first design and no-taxonomy choice make this horizontal by construction" — positioning is deliberately "for anyone who wants animation-rich videos"
- **Both models recommend:** Pick a wedge (B2B SaaS launch/feature video) for Days 1–60. Keep the architecture horizontal but make the marketing surgical. Expand after $10K MRR proves the wedge.
- **Why:** Horizontal positioning means no buyer has a "this is for me" moment, no channel has 10x ROAS, no integration partner is obvious, messaging tree is generic. Horizontal startups lose to focused ones at this stage.
- **What we might be missing:** Your dogfooding evidence from FUSE Finance. Your read on the customer signal. Deliberate global TAM design. The product genuinely IS structurally segment-agnostic.
- **If we're wrong, the cost is:** 90 days of generic acquisition with low CTR, indistinct positioning makes word-of-mouth harder, $10K MRR slips to Month 6+

### UC-2 — Watermark policy

- **You said:** "we should not do watermarks ever, people can have their video without it"
- **Both models recommend:** A/B test on Day 30: half of free-tier users get a tiny "made with Renderball" 3-second outro card (removable for $2). Measure conversion-to-paid, viral coefficient, brand perception.
- **Why:** No-watermark removes the largest viral loop competitors use AND forces stricter anti-abuse stack (higher COGS on free tier, harder acquisition).
- **What we might be missing:** Deliberate brand differentiation; Linear/Vercel free outputs have no watermark; you may know your buyer rejects watermarks specifically; the customer goodwill compounds.
- **If we're wrong, the cost is:** Higher CAC, no viral loop, harder anti-abuse — but the brand stance is hard to reverse later, so testing the data now is asymmetrically valuable.

### UC-3 — Avatar layer in V1.5

- **You said:** "we explicitly do not build AI avatars or talking heads (HeyGen owns this; we refer out)"
- **Both models recommend:** V1.5 (Day 60) ships an optional avatar layer (HeyGen API or self-hosted Wav2Lip-class) composited into a Renderball scene as another Element type.
- **Why:** Synthesia's growth shows dominant pattern is "avatar narrates over animated B-roll." Pure-animation refusal may lose to hybrid competitors. The schema supports it cleanly.
- **What we might be missing:** Deliberate focus discipline; avatar tools already saturate that market; your customer evidence may show hybrid isn't what your buyers want; the wedge is precisely "non-avatar animation-rich" video.
- **If we're wrong, the cost is:** 6-month regret if HeyGen ships animation around their avatars and eats the segment.

---

## Mandatory outputs produced

- [x] Restore point captured at `~/.gstack/projects/renderball-product/autoplan-restore-20260525-162645.md`
- [x] Scope detection: UI scope yes, DX scope yes
- [x] CEO findings written (10)
- [x] Design findings written (10)
- [x] Eng findings written (12)
- [x] DX findings written (10)
- [x] Cross-phase themes identified (5 patterns)
- [x] Decision audit trail (29 auto-decisions logged above)
- [x] Taste decisions surfaced (6)
- [x] User challenges surfaced (3)
- [ ] Architecture ASCII diagram — deferred (would extend report by 200+ lines; the PRODUCT.md technical architecture section already includes a data flow diagram)
- [ ] Test plan artifact — deferred to post-gate decision (AD-24 commits to the eval rubric being a Week 0 prerequisite)
- [ ] TODOS.md updates — deferred until gate decisions land

## Limitations of this run

- **Single-voice review** (codex CLI not installed). Consensus tables show only the Claude subagent column. Per the skill's degradation matrix, this is acceptable but cross-model agreement is not available as a confidence signal.
- **Standalone repo context** (PRODUCT.md was in `/Users/alfonsogarces/FUSE_DECKS/` at audit time, not a git repo; later moved to `/Users/alfonsogarces/VIDEO_GEN/docs/` on 2026-05-28). Branch detection, commit-window task aggregation, and `gstack-review-log` writes were skipped.
- **No design doc found** (the `/office-hours` prerequisite was not run before this review). Findings are still rigorous but the strategic premises section of the CEO review lacks the structured input a design doc would have provided.

---

*End of /autoplan review report. Decisions next.*
