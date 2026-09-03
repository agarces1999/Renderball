# The Harness Program — measurements, verdict, doctrine

**Status (2026-08-27): measurement phase CLOSED. Production UNCHANGED (still
cast + box contract). Next phase: build the harness behind a flag.**
Evidence repo: `qa/harness-lab/disney-fable` (own git history, sealed
commits — gitignored, never in this repo's history). Campaign cost: ~$4.

## The mandate (founder, 2026-08-25)

> "this is a real engineering problem, lets aim for fable quality, at <5min,
> and cost can exceed 5 USD. We can even change the business model but lets
> try getting to top quality... THIS WILL DETERMINE OUR PRODUCT"

Supersedes the earlier <$2 constraint. Fireworks-served models required for
prod; the harness itself must be model-portable.

## The decisive experiment (2026-08-27)

Five engines, one brief (Disney+ exec strategy, 6 slides, ZERO numbers in
brief), blind gallery, founder ranking `A>D>C>B>E`:

| Rank | Engine | Condition | Time / cost |
|---|---|---|---|
| 1 | **Qwen3.8-Max** | one call + context pack + 8k thinking cap | ~2min / ~$0.30 |
| 2 | **GLM-5.2-fast** | one call + context pack + 8k thinking cap | ~2min / ~$0.25 |
| 3 | Fable (Claude) first pass | M1 protocol, NO context pack (predates it) | 5m30s |
| 4 | DeepSeek-V4-Pro | one call + context pack, provider defaults | ~2min / ~$0.20 |
| 5 | **Production engine** | full cast pipeline, box contract, vision gate | 12.7min / $1.87 |

**The controlled pair: GLM-5.2-fast is both the prod build model AND arm D.**
Same model, same brief, same day — last place inside the pipeline, second
place as a one-call author. The architecture, not the model, is the variable.

Machine critic (Kimi K2.6, pairwise intent-anchored, sealed before the
founder's verdict): `glm > qwen > deepseek > fable-r1 > product-engine` —
**8/10 pairwise agreement with the founder; both misses adjacent swaps.**
Calibration artifacts: `m5-verdict-sealed.json`, `m5-calibration.json`.

### Known confounds (honest limits)
- Model × pack × thinking-dial are mixed across arms. Clean claims only:
  (1) every packed one-call arm beat the multi-call engine; (2) packed cheap
  models beat the unpacked strong model in blind judgment.
- Qwen/GLM decks came from a second invocation (same prompt, thinking cap
  added after pure one-shots truncated). DeepSeek is the only pure-default
  single-invocation Fireworks deck.
- n=1 brief, n=1 judge (founder). The protocol costs ~$4/afternoon —
  **replicate on 1–2 more briefs during the build before full commitment.**
- Fable/Sonnet WITH the pack: unmeasured, blocked on founder's Anthropic key.

## Why the engine loses (mechanisms, each visible in the outputs)

1. **Composition is global; the pipeline has no owner for it.** Arm E flipped
   dark→light mid-deck. No fragment can see the deck.
2. **Compliance spend vs design spend.** Pipeline tokens go to gates/retries;
   gates only subtract defects, they cannot add intent. One-call thinking goes
   to design decisions.
3. **The schema manufactures truth violations.** E invented "190M
   subscribers", "EST. 1923", "06/06" — stat-shaped components demanding
   numbers a numberless brief couldn't supply, *despite* a prompt-level ban.
   Prompt rules do not hold; validators are required.
4. **Intent dilutes across hops** (brief → outline → plan → piece prompts).
   The leaf call never reads the client's words.
5. **Brand-blindness is plumbing.** The crawl never runs for briefed topics →
   literal "Brand" placeholder. The pack injects retrieved facts directly.

## Doctrine (founder, 2026-08-27): bet on models, not compensating architecture

Two-class test for every proposed component:
- **Substitutes for the model's judgment** (decomposition, spatial gates,
  repair ladders, per-piece prompts, box placement): **never build again.**
  Ages into negative value with every model release.
- **Feeds / frees / checks the model** (retrieved brand facts, output
  validators, render-look-revise loop, thinking dial, renderer, editor):
  fine — appreciates with model quality.
- The one-question test: *"does this still make sense if the model is 10×
  better?"*
- The author is a **socket**: pack = plain text, contract = a file format,
  model swap = config. Re-run the 5-arm blind protocol on each notable model
  release instead of debating.
- "Bet on models" ≠ "wait for models": current Fireworks models already
  cleared the founder's bar with the thin harness.

## The harness spec (every number measured, none guessed)

1. **Author = ONE strong call.** Whole deck as one self-contained TSX
   (Section0..N, 1920×1080, inline styles, deterministic, no external URLs).
   ~14–25k output tokens with bounded thinking. **Budgets are PER-MODEL,
   set by trace review, not one global constant:** Qwen 8k (trace shows it
   uses ~2k — 4× headroom, calm completion); **GLM needs ≥16k** (at 8k the
   serving layer truncated it MID-PLAN — garbled forced-transition marker in
   the trace — and its #2 deck shipped on a chopped plan); DeepSeek provider
   default. Kimi K3 is OUT with mechanism: it thinks in the CONTENT channel
   (reasoning empty; 96KB of slide-planning prose, still planning page 5 at
   char 40k) — an unbounded planner that never emits, not a weak designer.
   Trace receipts: qa/harness-lab/m2-diag-*.raw.json.
2. **Context pack (~11KB, the load-bearing artifact).** Brief verbatim +
   file contract + truth rules + **retrieved brand facts** (real logo bytes
   from the crawl, real hexes — brand is a fact to fetch, not a style to
   imagine) + 4 composition directives (one identity; one purposeful graphic
   device per page born from that page's argument; occupy the canvas;
   executive register). Reference pack: `qa/harness-lab/m2-prompt.txt`.
3. **Loop.** Render (~1s/page warm via `measureScenes`) → calibrated
   comparative critic → ONE surgical revision (M1-measured: ≤15% of file).
   Revision application must **verify bytes on disk** (three edit-script
   crashes in the lab printed "ok" for edits that never landed).
4. **Truth validators, mechanical.** Numeral whitelist vs brief; logo-presence
   check; palette conformance. M4 is the proof prompts don't hold.
5. **Critic = comparative + intent-anchored ONLY.** Absolute rubrics are dead
   (M5 v1: everything scores ~9). Kimi K2.6 pairwise reached 8/10 founder
   agreement — good enough to drive in-loop revisions; humans own final rank.
   Ops notes: `maxTokens ≥ 8192` (judgment thinking ate 2048 → empty
   verdicts), parse JSON from the reasoning stream
   (`extractJsonFromReasoning`, zai-vision.ts).
6. **Editability decoupled from generation.** The LEGO editor does NOT
   require LEGO generation: author as one mind → decompose AFTER approval
   into editable elements (the decompose layer already exists).

Envelope check: ~2min author + renders + critic + one revision ≈ **well under
5min at well under $1/deck** — before Fable/Sonnet arms are even priced.

## Reuse map

- **Keeps (feeds/frees/checks class):** renderer + `measureScenes`, editor +
  decompose, brand crawl (now feeding the pack), R2 durability, spend
  breaker/ledger, code jail, vision transport, build UX (ceremony/heartbeat).
- **Dies at author-swap time (substitutes class):** composer plan, cast
  element waves, box contract as an authoring mechanism, gate/repair ladders.
- **Prod today:** unchanged (cast + box contract). The harness ships behind a
  flag, wins its own A/B, then takes the authoring path.

## M1 — the process being industrialized (receipts in the lab repo)

| Measure | Loma | Disney+ (pre-registered) |
|---|---|---|
| Brief → first render | 5m27s | 5m30s |
| First-pass authoring | ~6.2k tok / 22.2kB | 8,676 tok (one Write) / 18.6kB |
| Cycles to bar | 1 | 1 |
| Revision size | ~10% | 34+/9− ≈ 10% |

Calibration lesson: sealed self-grades missed **brand-evocation** entirely
(founder's blind note "nothing to the disney+ brand") → brand facts became a
retrieved input + a critic axis, and the fix rounds (celestial identity, real
wordmark) produced the pack's brand section.

## Open items

- **Fable + Sonnet arms with the pack** — needs founder's Anthropic API key.
- **M6 pages-at-bar** — founder flags unshippable pages per deck (optional,
  starts the longitudinal quality metric).
- **Replication** — same protocol on 1–2 more briefs during the build.
- Harness build itself: pack assembly from crawl, author socket, loop runner,
  validators, decompose-on-approve, flag + A/B vs prod.
- **Trace review is a standing protocol step** (2026-08-27, founder-prompted):
  every author eval saves raw responses and READS the reasoning — checking the
  pack is engaged, the budget has headroom, no truncation markers, no
  fake-it planning. Outcome data alone missed that GLM was being squeezed.

## Experiment hygiene: transport and sink load are MODEL variables (2026-09-01)

Measured during the stream-critics A/B (evidence: qa/harness-lab/
ab-stream-critics-2026-09-01 + ab2 + probe-stream-vs-call/probe-sink-load):

- Fireworks serves qwen3p8-max `stream:true` with **25–35% more content** than
  the byte-identical non-streamed request (3v3, every streamed call longer).
- **Consumer-side load during the stream** (heavy per-delta work + concurrent
  vision calls on the account) correlated with longer completions three
  separate times (4/4, 4/4, 3/3 pairs). Cause unobservable from outside.

Rules derived:
1. Any A/B whose arms differ in transport (castCall vs castStream) or in
   per-delta sink weight is comparing MODELS, not mechanisms. Hold both
   constant across arms, always.
2. Sinks on paid streams stay feather-light and throttled (the ceremony
   voice-over: latest-line side-channel, 2s throttle, ≥800-char scan gate).
3. Round-1 verdicts on any contaminated comparison are archived as
   CONTAMINATED, never cited as clean.

**2026-09-02 followup — the transport length effect did not replicate.** A
12-call probe ({call,stream} × {default,explicit sampling} × 3) showed
overlapping distributions and no reliable direction (default-call mean 2556tok
vs default-stream 2152; explicit arms reversed). The original 6/6 "stream
writes 25-35% more" was sampling variance. Rules 1-3 above STAND as cheap
experiment hygiene, but no transport effect is established. Per-call length
variance on identical requests (1710-2911tok observed) dominates everything;
n≥8 matched pairs or it isn't a finding.

## A/B protocol rules (2026-09-02, ab6/ab7 lessons — binding for engine experiments)

1. **n≥8 matched pairs or it is not a finding** (three single-pair "patterns"
   died this week under replication). One pair may only ever kill an obviously
   broken arm, never crown one.
2. **Interleave arms** (ABBA…) — never all-of-A-then-all-of-B: fleet drift,
   prefix-cache warmth and local warm-state are order-locked confounds.
3. **Replica pinning is a confound**: x-session-affinity keys per scriptId, so
   each arm's whole build lands on ONE Fireworks replica. At small n, replica
   identity rides the flag. Note it in every writeup; strip the header only in
   lab probes that need replica-independence.
4. **Hold transport + sink load constant across arms** (see the 2026-09-01
   section above).
5. **Archive BEFORE anything else, per build**: harness-trace, timeline, code,
   warnings — and now revision-before.tsx + revision-reply.txt (persisted by
   the pipeline itself since 2026-09-02). Raw author streams still are not
   persisted; capture them in the runner when stream mechanics are the subject.
6. **Lab scripts await flushSpend() before process.exit** — fire-and-forget
   ledger writes lose tail rows on prompt exit (observed: probe-6's second
   call, 13.8k tokens, missing from SpendRecord).
7. **Deletion/cleanup of experiment decks needs its own explicit founder
   confirmation at the moment of deletion** — never inherited from the plan.

## Motion (founder, 2026-09-03: "for launch let's allow motion … definitely a differentiator")

Decks move. The author gets a MOTION block in the pack (`lib/harness/pack.ts`)
and the editor gets **Animate** next to Regenerate (`lib/agents/regenerate-piece.ts`
ANIMATE_SYSTEM via `regenerateElement({ mode: "animate" })`,
`/api/preview/animate-element`). Doctrine-clean: the model authors the
choreography; code only feeds the contract and checks the one invariant that
keeps every measuring surface honest.

**The invariant — the static inline style IS the final designed state.**
Entrances use `animation-fill-mode: backwards`; the hidden pose lives only in
the keyframes' from-frame; nothing static is `opacity: 0` or offset. Why this
exact rule and not "fill-mode: forwards": everything that MEASURES a page
reads it *settled* (`animation-delay: -100000s`, `lib/render/settle-css.ts`) —
layout gates (`measure-scene`), export (`export-static`), thumbnails
(`thumbnail` → export), the critic's screenshots, and post-edit editor
reloads — and a forwards-filled animation also outranks inline styles in the
cascade, which would defeat the editor's live drag (it moves nodes by inline
`transform`). The editor additionally pins a node's painted pose before a drag
(`livePieceNodes`) so even a disobedient author cannot break the gesture.

Where motion plays: a page's first visit in the editor (post-edit reloads and
in-place morphs land settled — the editor settles the live document itself
once the entrance has finished, `settleAfterEntrance`), the presenting mode,
and the share viewer (`settle=1` still available). Reduced-motion viewers get
every page at rest via a media rule in the scene document. Validators strip
`<style>` blocks and at-rule template literals before numeral scanning
(keyframe percentages are not claims).

Per-element Animate writes the piece's own `@keyframes` in a `<style>` inside
the piece (uniquely prefixed by piece id) — self-contained, so the
zero-neighbor guarantee and undo/rollback hold unchanged. Provenance keeps the
motion ask in its own `motion` field. Ledger op `animate-element`, stage
`edit.animate`.

**First motion build (heist outline, 2026-09-03, $0.68, 806s) — what it
taught.** The author obeyed the invariant to the letter (8 keyframes, 45
animated elements, 39 `backwards`, 0 `forwards`/`both`, 0 static-hidden, no
media queries) but rendered the keyframes `<style>` on page 1 only — the
pack's "a single `<style>` rendered once" read as once per DECK — so pages
2-5 shipped static with animation properties pointing at nothing. The same
sentence had governed `@font-face` since 2026-08-31; 1 of 6 corpus decks
carries a `page === 1 && <style>` guard, i.e. brand fonts on page 1 only.
Three fixes: the pack now says every page, each page being its own document;
`validators.findStyleNotOnEveryPage` (static reachability, one level of
indirection) patches the `<DeckStyle/>`-in-Section0 shape before render; and
the SSR gate reports per-page markup facts (`RenderCheck.facts`) so build.ts
patches from rendered truth — the only thing that sees a page-index guard.
Second lesson: the first author attempt died at exactly 30,000 tokens
("missing exports") — motion adds ~3k output tokens per 5 pages (18,952 →
24,614 on the same outline) and thinking (≤8k) + code for 6-8 single-breath
pages now sums past 30k; `AUTHOR_MAX_TOKENS` is 40k (Fireworks accepts 40k
and 64k for qwen3p8-max, probed). Editor lesson: Chrome drops a finished CSS
animation from `getAnimations()`, so replay restarts motion by toggling
`animation` on the elements, and settle-after-entrance awaits only finite
animations (loops never finish).
