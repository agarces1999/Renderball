# SCENE-QA — the scene review constitution

How to review a generated Renderball video, scene by scene, the way a human
creative director would — distilled from the 2026-06-09 human+agent QA session
(build `01KTQH4GC70VM6R4412Q729152`), which surfaced both systemic design
failures and a renderer bug that silently dropped user-approved content from
the exported MP4.

This document is the operating standard for **any** agent critiquing rendered
output: the scheduled dogfood loop (Step 3 of its task), ad-hoc QA sessions,
and pre-ship reviews. Follow the principles, then the protocol, exactly.

Two ground rules before anything else:

- **Critique the frames a viewer actually sees** — rendered MP4 frames, never
  the source code's intent and never the browser preview alone. The preview
  and the render have diverged before (see P11).
- **Judge each scene at maximum ink** (see P10). A scene mid-entrance or
  mid-exit is not evidence of a design failure.

---

## Principles

### P1 — 100% canvas, 100% of the time
No region of the frame is reserved as empty staging for a later payoff.
Payoffs are **state changes of elements already on screen** (a bar fills, a
number ticks up, a card flips its accent on) — not late arrivals into blank
space. Card and container interiors count as canvas too: a large empty panel
waiting for content is the same defect at smaller scale.

*Example:* a 16:9 scene holds its entire lower half blank for four seconds so
a chart can "land" at the 70% mark. Wrong. The chart's axes and labels are
present from the scene's first settled beat; the payoff is the bars growing.

### P2 — Text floors
Headline-dominant hierarchy with hard minimum sizes for everything else.
Ledes and bullets must be readable at video distance (a phone in a feed, a
projector across a room) — the lede is a **first-class element**, not fine
print under the headline.

*Example:* a 96px headline over a 16px lede at 1080p. On a phone the lede is
decoration, not language. The lede carries the argument; size it like it
matters (roughly a third of the headline, never caption-sized).

### P3 — Late-beat dwell
Any text must land no later than `sceneEnd − readingTime`. Reading time at
video pace is roughly `wordCount / 3` seconds, minimum 1s. Text that enters
later than that was never meant to be read — it is motion for motion's sake.

*Example:* a 9-word lede fades in 0.5s before the scene cuts. Nine words need
~3s of dwell; this lede effectively does not exist for the viewer. Either land
it 3s before the cut or cut the lede.

### P4 — Signature color = meaning
The brand accent marks **THE** focal element of the scene — the keyword, the
hero number, the CTA. It is a pointer, not a paint bucket. The moment it
outlines many containers it stops meaning anything.

*Example:* six feature cards, all six outlined in the brand emerald. The
accent now says "everything matters," which reads as "nothing matters."
Accent ONE thing — the featured card or the verb in the headline.

### P5 — Hierarchy over uniformity
Any grid or list needs a featured element. N identical cards is a defect, not
a layout. Vary size, accent, or treatment so the eye knows where to start.

*Example:* a 3×2 grid of six same-sized, same-styled capability cards. Promote
one to a double-width card with a live mock inside it; let the other five
support at smaller scale.

### P6 — Diegetic specificity
Product-shaped mocks beat abstract glyphs. If the brand is a developer tool,
show a real command palette with a real command; if it's an alerting product,
show the actual error toast; if it's analytics, show a dashboard with
plausible labels. And use **type-as-action** where the copy implies doing:
text that types itself into the command bar, not a static lightning-bolt icon
next to the word "fast."

*Example:* a scene about "instant setup" shows a generic sparkle glyph.
Replace it with the product's install command typing character-by-character
into a terminal mock and resolving to a success line.

### P7 — Copy economy
No line appears twice, and no fact is restated. The headline and the CTA pill
must not say the same thing; two scenes must not each introduce the same
claim as if new.

*Example:* headline "Ship in minutes" above a CTA pill that also reads "Ship
in minutes." The pill is an action surface — it should say "Start free" (the
action), not echo the headline (the claim).

### P8 — Charts earn their space
A chart appears only if it is labeled, sized to communicate, and shows a real
shape worth seeing. An unlabeled decorative sparkline is empty calories — cut
it and let the headline number carry the point.

*Example:* a 120px-wide 3-bar chart with no axis, no labels, no values. The
viewer learns nothing. Either grow it into a labeled comparison with a
headline number, or delete it and give the space back to the text.

### P9 — Claims are sacred
Every numeric on screen must be grounded in the crawl, verified brand
material, or the user's prompt. Treat precise-sounding stats as **fabricated
by default** until you find their source. A made-up "43%" is worse than no
number — it is the user's reputation on screen.

*Example:* the crawl says "faster deploys"; the scene says "43% faster
deploys." That 43% came from nowhere. Flag it as a claims violation even if
it looks great — especially if it looks great.

### P10 — Judge the FINISHED scene
Critique max-ink frames — the moment(s) where the scene has the most content
painted — sampled from **multiple frames per scene**, never one fixed
timestamp. Scenes build up AND exit; a single still at any fixed percentage
will catch some scenes mid-entrance and others mid-exit and misread both.

*Example:* the old 85%-timestamp still caught a scene during its exit
choreography and the critique reported "mostly empty frame — fill the
canvas." The scene was full for 80% of its duration. The critique was wrong;
the sampling was the bug.

### P11 — Preview/render parity
If the rendered frames look emptier than the code implies, **suspect the
renderer before the design**. The browser preview and the MP4 render are two
different execution paths and they have already diverged in production.

*Example:* the bug we shipped — in `Composition.tsx` Section1, elements with
CSS `animation-delay >= 2.3s` (starting at `opacity: 0` with a
`forwards`-fill fade) never painted in ANY rendered MP4 frame, while
elements with delays ≤ 0.75s in the same section rendered fine — and the
live preview played all of them. The user approved content the export
silently dropped. When a coded element never appears across all sampled
frames, that is a parity finding (renderer bug), not a design finding.

---

## Review protocol

Run this scene by scene, in order, then consolidate. Do not skip scenes and
do not batch the judgment.

### Inputs
- The max-ink frame samples and paint report produced by
  `scripts/dogfood-stills.mjs` (multiple sampled frames per scene with the
  max-ink frame identified, plus a per-scene paint report of elements that
  never painted in any sampled frame). If a manifest predates these fields,
  fall back to the settled `scene-<i>.png` stills — but say so in your
  findings, and weigh P10/P11 judgments accordingly.
- The script JSON (scene labels, registers, durations) and the build's own
  `warnings` from the run manifest.
- The generated source under `src/generated/<scriptId>/` — read it when
  frames and intent seem to disagree (P11).

### Per scene
1. **State what you see.** One or two plain sentences describing the max-ink
   frame(s): what is on canvas, where, at what visual weight. No judgment yet.
   This forces you to look before you score.
2. **Check parity first (P11).** Compare what you see against what the scene's
   code paints. If the paint report lists never-painted elements, or the
   frames are emptier than the code implies, record a parity finding and do
   NOT also score the missing content as a design failure (P1/P2) — one root
   cause, one finding.
3. **Judge against P1–P10**, in order. For each violated principle, write one
   finding.
4. **Format every finding as:**
   `scene <i> — <what is wrong> — <why it matters>`
   citing the principle number, e.g.
   `scene 3 — all five cards identical and emerald-outlined (P4, P5) — accent means nothing and the eye has no entry point`.

### After all scenes
5. **Consolidate into systemic learnings.** Group findings that share a root
   cause across scenes; rank by repetition count. Three scenes with unlabeled
   charts is one systemic learning, not three findings.
6. **Propose at most the top 2–3 generalizable fixes.** Prefer, strictly in
   this order: deterministic **gates** (detect the defect from generated
   code/geometry) > **prompt** changes (when the rule genuinely cannot be a
   gate) > one-off edits (almost never — they fix one brand, once). A fix
   that only repairs this brand's video is not a fix; it is a patch the next
   run will need again.
