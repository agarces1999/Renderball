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

## Phases (each independently shippable, all behind RB_CLIENT_PREVIEW)

1. **Hydrate read-only** — prove the bundle runs in-iframe and the parity
   gate holds on the corpus. No UX change. (~3-4 days)
2. **Live text** — the bridge + keystroke path for bound copy fields; commit
   unchanged. This is the felt win. (~3-4 days)
3. **Full state bridge** — geometry/props live too; morph retires on
   hydrated docs. (~1 week, only if 2 proves worth it)

## Known traps (from this codebase's own history)

- fit-text must not double-run against hydration (gate __rbRefit on
  hydration-complete).
- The iframe realm boundary: no instanceof across it, duck-type (drag lesson).
- Fonts must be loaded before first hydrate paint or fit metrics drift
  (measure-scene records browserVersion for the same reason).
- React runtime version pinned to the bundle's JSX transform.
