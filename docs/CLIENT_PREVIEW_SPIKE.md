# Client-side preview — architecture spike (founder GO, 2026-08-19)

Goal: keystroke-live editing — text previews as the user types, zero server
round-trips in the typing loop. Server stays authoritative for measurement
gates, exports, and thumbnails.

## The one hard problem: parity

The research's warning (Framer/Webflow/Builder all live with this): the
moment the client renders one way and the server another, the quality gates
measure a deck the user never saw. Every design choice below serves parity.

## Architecture: one artifact, two executors

Do NOT build a second renderer. The sandbox already compiles each scene to a
CJS bundle (esbuild, ~5ms) that the server evaluates for SSR. The client
preview executes THE SAME BUNDLE:

1. Server compiles scene → bundle B (exists today, render-worker.cjs).
2. SSR path: evaluate B → static HTML (exists today; stays for measure/
   export/thumbs/share).
3. NEW client path: serve B (+ a pinned React runtime) into the existing
   sandboxed cross-origin iframe; hydrate the SSR HTML with live React.
   Parity holds because there is one compile artifact — divergence is
   limited to hydration mismatches, which are detectable, not silent.

Security: unchanged posture. LLM code already executes in the user's browser
inside this iframe as inline scripts (choreography); running the component
bundle there adds no new trust boundary. CSP stays same-origin + inline.

## Edit loop

- Text keystroke → postMessage {piecePath, value} → in-iframe bridge sets
  React state → live re-render (ms). Commit stays the existing edit-element
  POST; the morph path remains the fallback renderer for non-hydrated docs.
- Geometry keeps the optimistic-commit path (already 0ms).

## Parity gate (CI, zero tokens)

For each stored replay deck: SSR HTML vs client-hydrate-then-serialize DOM,
normalized diff must be empty (modulo data-react attrs + fit-pass inline
styles, which re-run identically via __rbRefit). Runs in the suite against
the stored corpus; any mismatch class blocks the flag flip.

## Phases

1. **Hydrate read-only** — DONE 2026-08-20 (f296414): bundle runs in-iframe,
   corpus parity 419 scenes / 0 mismatches. Behind RB_CLIENT_PREVIEW.
2. **Live text** — LANDED 2026-08-20, reshaped by a scouting finding: canvas
   typing was ALREADY live (contentEditable in the SSR DOM) and commits were
   already morph-first, so the React bridge solved a problem the editor
   didn't have. The real gap was autofit not tracking keystrokes — text
   overflowed its fitted box until commit. Shipped as a 120ms-throttled
   input listener that re-runs window.__rbRefit during text sessions
   (probe: qa/probe-live-refit.ts — fit stamp changes and font shrinks
   live, 38.75px→16px before commit). Unflagged: no bundle dependency.
3. **Full state bridge** — geometry/props live via hydrated React; morph
   retires on hydrated docs. Only if a concrete need appears (e.g. live
   preview of side-panel prompt edits before commit). RB_CLIENT_PREVIEW
   stays the gate.

## Known traps (from this codebase's own history)

- fit-text must not double-run against hydration (gate __rbRefit on
  hydration-complete).
- The iframe realm boundary: no instanceof across it, duck-type (drag lesson).
- Fonts must be loaded before first hydrate paint or fit metrics drift
  (measure-scene records browserVersion for the same reason).
- React runtime version pinned to the bundle's JSX transform.
