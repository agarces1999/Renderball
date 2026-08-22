//
// Fitting a fixed-size slide into a flexible container — computed by the HOST.
//
// WHY THIS MOVED OUT OF THE IFRAME. The scene document used to scale itself: a `fit()`
// script inside the frame measured its own viewport and wrote `transform: scale(s)` as
// INLINE STYLE onto `.renderball-canvas`. Two consequences, both of which cost real
// debugging:
//
//   1. The editor lives in the PARENT document, so to turn a mouse position into a
//      canvas coordinate it had to reach into a foreign document, find the canvas, and
//      divide by a scale it could only discover by measuring. When that measurement
//      failed it fell back to 1 — a plausible-looking wrong answer that silently
//      halved every box the user drew (fixed 2026-08-22).
//   2. The morph path's ancestor sync copies `style` from a freshly-rendered document,
//      where `fit()` has never run and the canvas therefore carries NO transform.
//      Copying that absence onto the live canvas wiped the scale and the slide snapped
//      to 1:1 — "everything expanded again on the slide", reported twice.
//
// Both are the same root cause: the scale was a fact discovered from inside a document
// the editor does not own. Computing it in the host makes it a value the host SETS —
// it cannot be stale, cannot be unmeasurable, and cannot be erased by a DOM sync,
// because it no longer lives in the DOM being synced.
//
// The iframe element is then sized to the canvas exactly and scaled as a whole, so the
// document inside is always 1:1. Headless paths are unaffected: export-static already
// drives it at exactly canvas dimensions, where the old fit() computed a scale of 1.
//
const ENABLED = new Set(["on", "1", "true", "yes"]);

/**
 * Is the HOST responsible for scaling the slide?
 *
 * Default OFF: flipping this changes what three user-visible surfaces render (the
 * editor, the preview, the share viewer), and each has to stop expecting the document
 * to size itself before it can be true. `RB_HOST_SCALE=on` turns it on so the new path
 * can be driven and measured on a real deck while the shipped path stays untouched —
 * the same posture as the piece-spec and client-preview seams.
 *
 * When OFF the scene document keeps its own `fit()` and nothing below runs.
 */
export const hostScaleEnabled = (
  env: Record<string, string | undefined> = process.env,
): boolean => {
  // NEXT_PUBLIC_ is read first so the CLIENT can answer this without a prop threaded
  // through five components. Both names are accepted: the scene document is emitted
  // server-side (RB_HOST_SCALE), the frame component runs in the browser
  // (NEXT_PUBLIC_RB_HOST_SCALE), and a flip has to move both together or the document
  // and its host would disagree about who is scaling — which is double-scaling, or
  // none. Setting just one is a misconfiguration; `hostScaleDisagreement` below is how
  // a caller can notice.
  const raw = env.NEXT_PUBLIC_RB_HOST_SCALE ?? env.RB_HOST_SCALE ?? "";
  return ENABLED.has(String(raw).trim().toLowerCase());
};

/**
 * True when only ONE of the two flag names is set — the configuration that produces a
 * slide scaled twice or not at all. Cheap to check, and a silent half-flip is far
 * harder to diagnose from a screenshot than a loud warning at boot.
 */
export const hostScaleDisagreement = (
  env: Record<string, string | undefined> = process.env,
): boolean => {
  const on = (v: string | undefined) => ENABLED.has(String(v ?? "").trim().toLowerCase());
  const pub = env.NEXT_PUBLIC_RB_HOST_SCALE;
  const srv = env.RB_HOST_SCALE;
  if (pub === undefined || srv === undefined) return false; // only one configured at all
  return on(pub) !== on(srv);
};

export interface FrameFit {
  /** Uniform scale to apply to the frame element. */
  scale: number;
  /** Left offset, host px, that centres the scaled frame in its container. */
  left: number;
  /** Top offset, host px. */
  top: number;
  /** Rendered size of the scaled frame, host px — the container's used area. */
  width: number;
  height: number;
}

/**
 * Fit a `canvas`-sized slide into `container`, preserving aspect and centring.
 *
 * Returns null when either box is not yet laid out. NULL IS LOAD-BEARING: it is the
 * signal that no honest answer exists yet, and every caller that builds geometry must
 * refuse rather than substitute 1. `occupiedBounds` in the editor already words this
 * well — "No geometry beats wrong geometry."
 */
export const fitFrame = (
  container: { w: number; h: number },
  canvas: { w: number; h: number },
): FrameFit | null => {
  if (!(container.w > 0) || !(container.h > 0) || !(canvas.w > 0) || !(canvas.h > 0)) return null;
  const scale = Math.min(container.w / canvas.w, container.h / canvas.h);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const width = canvas.w * scale;
  const height = canvas.h * scale;
  return {
    scale,
    left: (container.w - width) / 2,
    top: (container.h - height) / 2,
    width,
    height,
  };
};

/**
 * Host-local point (relative to the container's top-left) → canvas coordinate.
 *
 * The inverse of the transform `fitFrame` describes: subtract the letterbox offset,
 * then divide by the scale. Returns null on a null fit for the same reason fitFrame
 * does — a caller must not place an element using a coordinate we cannot compute.
 */
export const hostToCanvas = (
  point: { x: number; y: number },
  fit: FrameFit | null,
): { x: number; y: number } | null => {
  if (!fit) return null;
  return { x: (point.x - fit.left) / fit.scale, y: (point.y - fit.top) / fit.scale };
};

/** Canvas coordinate → host-local point. The forward transform. */
export const canvasToHost = (
  point: { x: number; y: number },
  fit: FrameFit | null,
): { x: number; y: number } | null => {
  if (!fit) return null;
  return { x: point.x * fit.scale + fit.left, y: point.y * fit.scale + fit.top };
};
