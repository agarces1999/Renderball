# Design System — Renderball

> The chrome is quiet on purpose. The loudest thing on screen should be the
> user's brand and their story, never Renderball's own UI.

## Product Context
- **What this is:** Renderball turns a short brief into an on-brand, animated launch video. It crawls the user's site, an agent writes a story-driven script, downstream agents build and render an animated frontend to MP4.
- **Who it's for:** Founders and marketers making launch / investor / social / sales videos who want agency-grade output without the agency.
- **Space:** AI-native video / creative generation. Peers: Runway, Pika, InVideo, Descript (video); Gamma, v0, Lovable (prompt-to-artifact UX).
- **Project type:** Web app with a creation flow plus a review/preview surface.
- **The one thing to remember:** "It told a story." The output feels authored, not assembled. Every design decision serves this.

## Core Motif — the crystal ball
"Renderball" = render (a graphics engine turning data into a lit image) + ball (a sphere). The mark is a **crystal ball**: a glass orb with a prismatic edge. The meaning is foresight. You **see your story's future before you commit to rendering it**, which is exactly what the story screen does. The orb is the logo, the front-door hero, and the generation state (it "clears" while the story computes).

### Orb recipe (CSS)
A translucent glass sphere on the cool void:
- Glass body: `radial-gradient(circle at 50% 50%, rgba(190,205,235,.10) 0%, rgba(22,28,44,.55) 68%, rgba(8,10,18,.9) 100%)`
- Internal glow (bottom-right): `radial-gradient(circle at 68% 74%, rgba(150,200,255,.30) 0%, transparent 58%)` (prismatic tint)
- Prismatic rim (pseudo-element, ring-masked, `mix-blend-mode: screen`): `conic-gradient(from 200deg, transparent, rgba(120,220,255,.4), rgba(180,130,255,.32), rgba(255,130,205,.3), transparent)`
- Specular highlight (pseudo-element top-left): small white blurred radial
- Cast glow: `box-shadow: 0 0 48px -8px rgba(150,200,255,.30)` plus inset shadows for depth
- Generation state: rotate the prismatic rim slowly (`7s linear infinite`); the body stays still.

## Aesthetic Direction
- **Direction:** Editorial instrument, render-viewport flavor. Cool, computational, glassy, restrained. Type-led.
- **Decoration level:** minimal. Type, space, and the orb do the work. No gradients-as-decoration, no blobs, no icon-in-colored-circle grids.
- **Mood:** A precision instrument that happens to be beautiful. Confident, quiet, a little futuristic. Linear's restraint, a render engine's coolness.
- **Reference posture:** closer to Runway's editorial seriousness than InVideo's template buffet. Never a thumbnail wall.

## Color
A developed cool greyscale carries the chrome; one emerald-green signal is the only chroma. **Light is the default**; dark is an alternate via `[data-theme="dark"]`. The greys do the quiet work, the green pops on every action, and neither fights the brand-color video preview.

**Accent token split** (so the green stays legible in both modes): `--accent` is the vivid green FILL (buttons, chips, dots) paired with `--accent-ink` for text on it. `--accent-text` is the green used as FOREGROUND text — deeper in light mode so it passes contrast on white. Components use `text-accent-text` for green text and `bg-accent` for green fills.

### Light (default) — cool greyscale
| Token | Hex | Use |
|---|---|---|
| `--canvas` | `#EAEDF1` | the page — cool light grey |
| `--surface` | `#FFFFFF` | raised: cards, panels |
| `--surface-2` | `#F5F7F9` | secondary surface, inputs |
| `--surface-3` | `#E1E5EB` | recessed / hover / the "turn" scene base |
| `--hairline` | `rgba(18,26,43,0.08)` | dividers, card borders |
| `--hairline-strong` | `rgba(18,26,43,0.16)` | inputs, emphasized borders |
| `--ink` | `#10141C` | primary text (near-black, cool) |
| `--ink-soft` | `#39424F` | secondary text |
| `--muted` | `#69707E` | tertiary / labels |
| `--faint` | `#99A0AD` | hints, disabled |
| `--accent` | `#00C28A` | green fill (buttons, chips, dots) |
| `--accent-ink` | `#032018` | text on the green fill |
| `--accent-text` | `#047857` | green as foreground text (≥4.5:1 on white) |
| `--accent-soft` | `rgba(0,194,138,0.12)` | active backgrounds, the "turn" scene tint |
| `--accent-line` | `rgba(0,194,138,0.42)` | active borders |

The grey ramp is the system: a cool light-grey canvas, white raised cards, a recessed grey for hover/inset, and a four-step ink ramp. Separation comes from canvas-grey vs card-white plus hairline borders.

### Dark (alternate, `[data-theme="dark"]`)
| Token | Hex |
|---|---|
| `--canvas` | `#0B0D12` |
| `--surface` | `#13161D` |
| `--surface-2` | `#181C24` |
| `--surface-3` | `#20242E` |
| `--ink` | `#ECEFF4` |
| `--ink-soft` | `#C4C9D4` |
| `--muted` | `#8990A0` |
| `--faint` | `#565D6E` |
| `--accent` / `--accent-text` | `#00E0A0` (vivid reads as both fill and text on dark) |
| `--accent-ink` | `#02160F` |

Green alternates explored, if the emerald ever needs swapping: `signal #25E06A`, `acid lime #B6FF3A`. Emerald is the lock.

- **Approach:** restrained. The emerald accent appears rarely (primary action, active state, the "turn" scene, role labels). Color is meaningful, not decorative. The rest is greyscale.
- **The crystal/prism** is the only place spectral color is allowed, and only on the orb's edge. The orb stays neutral glass; it does NOT take the green accent.

## Typography
The split is the point: a precise display face for the story, a neutral grotesque for the interface.

- **Display (story surfaces only):** **Cabinet Grotesk** (Fontshare). Logline, scene headlines, hero text. Geometric and precise, echoes the crystal's faceted clarity. Weights 500 / 700 / 800. Tight tracking (-0.015em to -0.02em).
- **UI + body:** **Geist** (Google Fonts). All labels, body copy, controls. Weights 400 / 500 / 600. Excellent tabular figures.
- **Mono (technical / diegetic):** **Geist Mono**. Scene numbers, durations, timings, render metadata, eyebrows.
- **Never** use the display face for body, or mono for long copy.
- **Loading:** Cabinet Grotesk via Fontshare CDN (`api.fontshare.com/v2/css?f[]=cabinet-grotesk@...`); Geist + Geist Mono via Google Fonts. Self-host before GA for performance + reliability.

### Type scale (px)
| Role | Size / line-height | Face |
|---|---|---|
| Hero / logline | 30-56 / 1.04 | Cabinet Grotesk 600 |
| Scene headline | 23 / 1.12 | Cabinet Grotesk 600 |
| Section heading | 18-20 / 1.3 | Geist 600 |
| Body | 15-16.5 / 1.55 | Geist 400 |
| Label / role | 12.5-13 / 1.4 | Geist 500-600 |
| Eyebrow / mono meta | 11-12 / 1.4, .14-.18em tracking, uppercase | Geist Mono 500 |

## Spacing
- **Base unit:** 8px.
- **Density:** spacious on creation/story surfaces (editorial breathing room), comfortable in the app shell.
- **Scale:** 2xs 2 · xs 4 · sm 8 · md 16 · lg 24 · xl 32 · 2xl 48 · 3xl 64.

## Layout
- **Approach:** hybrid. The app shell is grid-disciplined (predictable rail + canvas). The story/creation surfaces are editorial (asymmetric, generous margins, a vertical scene sequence).
- **Max content width:** 1180px.
- **Border radius:** sm 8 · md 12 · lg 18 · full 9999. Cards md, frames lg, pills full. No uniform bubble-radius on everything.
- **The story screen:** main story column + a quiet 280px "Brand & format" rail, pre-filled from the crawl.

## Motion
- **Approach:** intentional and restrained. This is a motion product, so the app's own motion must have taste, but it must never compete with the video preview.
- **Signature:** the crystal orb forms / clears as the generation state (rim rotates slowly). Story cards stagger in as the script streams.
- **Easing:** enter ease-out, exit ease-in, move ease-in-out. No bounce in the chrome.
- **Duration:** micro 80-120ms · short 160-240ms · medium 260-420ms · long 420-700ms (reserve long for the orb / hero only).

## Landing — the canvas performs (locked 2026-07-24, founder brief + /design-consultation)

**Positioning thesis:** every AI tool's landing sells the input (a prompt box);
Renderball's sells the surface where work finishes. The landing IS the editor
performing. Evidence: v0/Gamma lead with "ask the box"; Cursor/Framer can only
show static screenshots of their editors. Our output is real DOM, so the page
itself can generate — a claim chat-output competitors structurally cannot copy.

**Tagline (lock):** "Design should not be prompted. It should be drawn."
Two-voice synthesis (2026-07-24): the founder's original word was
"visualized"; the independent design voice argued — and the consultation
agreed — that "drawn" is the verb only this product owns (drawing the
rectangle IS the interface), while "visualized" is what every AI company
claims. The founder's original sentence lives on as the meta description.
One-string revert if the founder disagrees. The second line wears a live
emerald selection frame + corner handles + a mono dimension tag: the tagline
presents as a just-generated element. Eyebrow above it in mono: THE FIRST
AI-NATIVE DESIGN EDITOR.

**Hero opener — the prompt-box funeral:** the canvas first shows the
category's altar (a centered "Describe your deck…" input), selects it like an
object (mono tag: `prompt — legacy input`), and DELETES it; the first marquee
draws in its place. The positioning argument performed in three seconds,
no copy needed.

**Honesty rules (from the outside voice, adopted):** precomputed
generations carry a mono `sandbox` label; no fake spinners; every timestamp
and token figure on the page comes from a real recorded session (the 4:37
flarebit deck build; real ledger token counts). Every claim on the page must
be demonstrated on the page or cut. Session clock in mono ticks from first
scroll.

**Shipped 2026-07-24 (was deferred):** the two activation ideas from the
consultation are live. (1) **The sandbox beat** — from the moment the first
scripted artifact lands until the deck beat, the band is a real canvas: the
visitor drags a real marquee ("your turn — draw here"), picks from
precomputed intents (kpi tile / bar chart / pull-quote), and the element
materializes instantly from a local sandbox set — zero LLM calls, mono
`sandbox` label, and the editor's bounds discipline (the user's box is law;
sub-24px drags are stray clicks). Visitor boxes hold the BAND contract too
(clamped below the band edge — their generations never touch the copy
either). The scripted artifacts are draggable with the selection-handle
affordance; visitor drags compose additively so the beats stay pure
functions of scroll. The intent picker is chips, never a text input — the
no-prompt-box rule holds. (2) **Persistence into activation** — the
visitor's canvas (boxes, intents, drags) serializes to localStorage; after
sign-in, /new offers "Continue what you started", which seeds the brief
prompt from their intents in words they can edit (the honest smallest
version — no forged document), with a mono `start clean` escape hatch.
Reduced-motion and mobile visitors get the same sandbox in a bounded panel
inside the static story (no theatrics — enter animations are killed under
reduced motion).

**Hard rules:**
- NO prompt box anywhere on the landing. Not the hero, not the footer
  (Framer caves at the bottom; we don't). The only inputs on screen are
  diegetic — props inside the canvas performance.
- Everything that "generates" is REAL DOM appearing with system easings —
  never video, never Lottie. The medium is the proof.
- Light canvas default (subverts the dark-AI-tool trend; Cursor-adjacent,
  distinct from Framer/Linear). Dark stays available via tokens.
- Emerald discipline holds: accent appears only on the marquee stroke, the
  CTA, and generation highlights. The performed brand-swap beat may tint
  DEMO content with a demo-brand color; chrome never borrows it.
- Orb = the seed. It sits at canvas origin and "clears" as beats generate.
  Meaning shifts from video-era foresight to: the seed that renders.
- Reduced motion / no-JS: the composed final state renders statically with
  the caption stack; no sticky theatrics.
- CTA is "Open the editor" and routes to /new — through sign-in when logged
  out, straight in when logged in. Signed-in visitors hitting / redirect to
  /new, not the gallery. Editor companies drop you in the tool.

**Layout contract (founder review 2026-07-24, supersedes the outside
voice's left-placed hero):** hero text is CENTERED in the upper region;
the performance runs in a dedicated canvas band BELOW it (BAND const in
LandingCanvas.tsx). Text and generations never overlap — the band edge is
a hard line. The brand-extraction chip row renders as a status line under
the band, not between text and canvas. Generated artifacts must be worth
generating: the KPI tile carries a delta chip + sparkline, the chart has
an axis, value and quarter labels, the title block is a real typographic
lockup. Plain grey boxes are not proof of taste.

**Scroll narrative (sticky stage, ~5 beats):**
1. SEED — blank dot-grid canvas, orb pulsing; tagline stages itself; the
   second line generates inside a drawn marquee.
2. DRAW — a marquee rectangle draws, a mono prompt types ("a KPI tile
   showing 3.2× faster"), a real KPI tile pops at exactly those bounds.
   Claim: Draw a box. Say what goes there. It exists.
3. BRAND — a URL chip lands; palette/font chips extract from it; the demo
   content re-tints live. Claim: Paste a URL. It's already on-brand.
4. REAL — selection handles appear, the tile drags/resizes, a caption gets
   an inline text caret, mono coords tick. Claim: Real elements, not
   screenshots.
5. DECK + CLOSE — the canvas becomes slide 1 of a rail; slides 2–5
   generate; mono timer. Then the canvas clears and one final marquee draws
   with the CTA generated inside it. Ledger line: editing is free ·
   generation is metered · first 1M tokens free.

**Below the fold (quiet, server-rendered):** three claim columns
(draw/brand/real), usage-based pricing (free 1M tokens, then per-token —
NEVER a flat $/mo figure), deck-era FAQ, legal links + support contact
(processor-review requirements stay).

## UX Flow — fluid v1 (the redesign)
The old 5-step upfront wizard (site → format → colors → shape → prompt, before showing anything) is replaced. The whole category moved to intent-first generation; config-before-creation is the friction. New flow leads with the prompt and makes the **story** the first artifact the user sees and shapes.

1. **Front door (one screen).** One prompt ("What's the story?") plus a URL field and smart-defaulted format/length chips you can ignore. The crawl fires in the background while the user types. No auto/manual fork upfront; default is "AI drafts it," and "write it myself" is an edit affordance later.
2. **Render the story (generation state).** The crystal clears while a cheap, fast pass (Sonnet script generator) drafts the narrative and scenes.
3. **The story appears (hero moment).** Logline in Cabinet Grotesk, then scenes as a vertical sequence whose headlines read top-to-bottom as a story. The "turn" scene is tinted with the accent. This is the "it told a story" beat, and it lands before any expensive build.
4. **Shape the story (cheap-edit checkpoint).** Drag to reorder, click a headline to rewrite, nudge tone/length, regenerate, or take it over manually. A collapsed "Brand & format" rail (logo, palette, aspect, length) sits to the side, pre-filled from the crawl. One click to adjust, zero clicks to accept.
5. **Build it.** One loud action ("Build the video"). The expensive Opus design + choreography + render runs with honest per-scene progress. The wait is earned because the story is already approved.
6. **Preview + iterate per scene.** The animated preview. Click a scene, say what to change, it regenerates (per-scene regen already exists). Then export to MP4.

### Flow principles
- **Config is refinement, not a gate.** Format, colors, duration are crawl-defaulted side controls, never upfront steps.
  - **Approved exception — brand identity (Alfonso, 2026-07-07):** the brand
    kit IS a gate. The logo is required (upload, or one-click confirmation of
    the crawled mark); the scanned palette must be user-confirmed (editable
    first); font upload is optional with a license attestation. Rationale:
    dead/blank logo assets were the #1 shipped-defect class (QA 2026-07-06),
    and identity must be locked by the user, never silently guessed. Enforced
    in lib/brand-kit.ts (form + submitBrief + /api/preview/build).
- **Story before render.** Always show and let the user approve the narrative before spending expensive compute.
- **The chrome recedes.** When a brand-color preview is on screen, the app UI goes quiet so the work is the loudest thing.

## Decisions Log
| Date | Decision | Rationale |
|---|---|---|
| 2026-06-01 | Initial design system + fluid v1 UX created | /design-consultation. Memorable thing: "it told a story." |
| 2026-06-01 | Motif: crystal ball | "Renderball" = render + ball; crystal ball = see your story before you build it. Foresight maps to the story-first flow. |
| 2026-06-01 | Palette: developed cool-graphite greyscale + one emerald-green signal #00E0A0 | Warm-editorial and periwinkle-blue accents rejected. Greyscale-plus-one-green is restrained and premium: greys carry the chrome, green is the only chroma, neither fights the brand-color preview. Orb stays neutral prismatic glass, separate from the green. |
| 2026-06-01 | Display: Cabinet Grotesk; UI: Geist; Mono: Geist Mono | Fraunces (literary serif) rejected. Cabinet's geometric precision echoes the crystal facets and reads "engineered instrument." |
| 2026-06-01 | Flow: story-first, kill the 5-step upfront wizard | Category moved to intent-first generation; config-before-creation is the friction; the story is the hook and should be the first artifact. |
| 2026-06-02 | Default mode flipped to LIGHT; light greyscale developed; accent split into fill (`--accent`) vs text (`--accent-text`) | Light is now the default (dark moved to `[data-theme="dark"]`). Light greys built into a real ramp (grey canvas, white cards, recessed grey). Vivid emerald fails contrast as text on white, so green-as-text deepens to `#047857` while green fills stay vivid. |
| 2026-06-06 | Front door (`/new`) adopts an emerald "brand field": a white-dominant green mesh background, frosted "opaquely transparent" glass panels, a green-tinted crystal orb with a slowly rotating rim, and a visual screen-ratio format picker (little screens drawn at true 9:16 / 1:1 / 16:9 proportions) | **DELIBERATE, user-approved deviation** from the core rules "no gradients-as-decoration," "the emerald is the only chroma and appears rarely," and "the chrome is quiet." Scoped to `/new` only via the `.brand-field` and `.glass` classes in `globals.css` — every other surface keeps the greyscale chrome. The front door shows no user content yet, so a branded moment here does not fight a brand-color video preview. QA: this screen is intentionally off the base spec; do not flag. |
| 2026-06-06 | Built the flow's remaining screens: a shared quiet app header (crystal-ball mark + "Renderball" wordmark, "Your videos" + "New video"), a "Your videos" gallery at `/videos`, an on-brand build ceremony (crystal orb + honest per-scene progress), and a reskinned preview playback surface | Completes the create → review → build → preview → export loop and gives returning users a home base (surfaces `listBriefs`). Replaced off-brand developer UI — the yellow "build preview" box and raw `gray-900` / `amber` / `emerald-600` controls — with the design tokens. |
| 2026-06-06 | Quiet chrome enforced on `/review` and `/preview`; the emerald-glass treatment stays exclusive to `/new`; MP4 export consolidated to a single point (preview) | Applies the "chrome recedes when a brand-color preview is on screen" rule so the user's video is the loudest thing. Removed the duplicate "Render MP4" action from `/review` (export lives at the end of the flow); fixed scenes rendering "Untitled scene" by promoting the best available scene text (headline → role → label). |
| 2026-07-24 | Landing sandbox beat + persistence into activation shipped (the consultation's two deferred ideas) | The band accepts real visitor marquees from the first landed artifact until the deck beat; precomputed intents materialize instantly (zero LLM, mono `sandbox` label, user box is law, clamped to the BAND contract); the scripted artifacts drag with the handle affordance, additively over the pure scroll beats. Canvas state persists to localStorage; `/new` offers "Continue what you started" (seeds the brief prompt in editable words) with a mono `start clean` hatch. Picker is chips only — the no-prompt-box rule holds. |
