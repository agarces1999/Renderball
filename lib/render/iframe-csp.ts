/**
 * Content-Security-Policy for the served composition document.
 *
 * The composition is LLM-authored code rendered into a page on OUR origin,
 * carrying the signed-in user's cookies. code-guard.ts stops hostile code
 * being written or resolving host modules; this is the second layer, for the
 * markup side — compositions legitimately use dangerouslySetInnerHTML
 * (assemble.ts, choreograph.ts), so injected markup can still reach the DOM.
 *
 * Why not `sandbox` on the <iframe> instead: the element editor drives the
 * document through `contentDocument` in a dozen places (selection, drag,
 * resize, inline text edit), which requires same-origin. The only sandbox
 * that preserves that is `allow-scripts allow-same-origin`, and a frame with
 * both can simply remove its own sandbox attribute — theatre, not a control.
 * A CSP on the response is enforced by the browser regardless.
 *
 * What this actually buys: `connect-src 'none'` and `form-action 'none'`
 * close scripted exfiltration (fetch/XHR/WebSocket/form post), and the
 * document needs neither — nothing in the served doc makes a runtime request.
 *
 * Known residual: `img-src https:` leaves an image-beacon channel open. It
 * stays permissive because compositions legitimately load imagery from
 * Pexels, R2, and logos crawled from arbitrary customer domains, so an
 * allowlist would break real decks. The primary control for that path is
 * code-guard refusing to emit the code that would build such a URL.
 */
export const COMPOSITION_CSP = [
  "default-src 'none'",
  // lottie-web is loaded from cdnjs by the served document; the mount code
  // and the choreography are inline <script> blocks we generate.
  "script-src 'unsafe-inline' https://cdnjs.cloudflare.com",
  // Every composition styles itself with inline style attributes and blocks.
  "style-src 'unsafe-inline' https:",
  "img-src https: data: blob:",
  "font-src https: data:",
  "media-src https: data: blob:",
  // The document makes no runtime requests — so nothing legitimate is lost,
  // and scripted exfiltration is closed.
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  // Framed by our own editor only (pairs with X-Frame-Options: SAMEORIGIN).
  "frame-ancestors 'self'",
].join("; ");

/** Response headers for any route serving a rendered composition document. */
export const compositionDocHeaders = (): Record<string, string> => ({
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Frame-Options": "SAMEORIGIN",
  "Content-Security-Policy": COMPOSITION_CSP,
  "X-Content-Type-Options": "nosniff",
});
