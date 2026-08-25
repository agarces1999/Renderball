//
// EMISSION GUARDS — fail at string-time, not render-time (founder lever #2,
// 2026-08-25).
//
// The expensive thing about a bad emission is not the fix, it is the
// DISCOVERY: a render-and-measure round costs 40-60s, so a defect that is
// visible in the emitted STRING should never survive to one. Two classes from
// the founder's first promoted-engine build qualify:
//
//   * external image URLs — the model mounted a favicon from the open web;
//     it decoded to zero pixels at render time and cost a full round plus a
//     wordmark swap. The rule is absolute: an element may reference only the
//     assets its brief provided (or data: URIs). Anything else is unreachable
//     by definition at render time (the render sandbox has no open internet).
//   * hollow decorations — throughline/connector motifs that paint nothing
//     (no fill, background, gradient, border, or image). Three were emitted,
//     measured, judged cluttering and blanked in one build. String-level ink
//     detection catches them in zero milliseconds.
//
// Both checks err toward NOT rejecting: a false rejection costs a real ~10s
// re-emission, so only unambiguous violations fire.
//

/** Literal http(s) image sources in an emitted body. Expression srcs
 *  (src={img.src}, src={LOGO_SRC}) and data: URIs are never collected —
 *  expressions resolve to script-provided values and data: is self-contained. */
export const collectLiteralImageSrcs = (body: string): string[] => {
  const out: string[] = [];
  const rx = /src\s*=\s*(?:\{\s*)?["'](https?:\/\/[^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(body)) !== null) out.push(m[1]);
  return out;
};

/** Literal srcs not present in the allowed set (exact match). */
export const findForeignImageSrcs = (body: string, allowed: ReadonlySet<string>): string[] =>
  collectLiteralImageSrcs(body).filter((src) => !allowed.has(src));

/** Every http(s) URL a scene's own JSON carries — the brief-provided asset
 *  universe, which is exactly what an element is allowed to mount. */
export const sceneImageAllowlist = (scene: unknown): Set<string> => {
  const out = new Set<string>();
  const rx = /https?:\/\/[^\s"'\\)]+/g;
  const json = JSON.stringify(scene ?? {});
  let m: RegExpExecArray | null;
  while ((m = rx.exec(json)) !== null) out.add(m[0]);
  return out;
};

/**
 * Does this emitted body PAINT anything, at string level? The render-measure
 * twin of this idea (paintsInk in render-truth-gates) reads computed styles;
 * this reads source. Deliberately generous: any fill/background/gradient/
 * border/shadow/image mention counts — only a body with NONE of them is
 * unambiguously hollow.
 */
export const bodyPaintsInk = (body: string): boolean =>
  /<(rect|circle|ellipse|path|polygon|polyline|line)\b/i.test(body) ||
  /background(Color|Image)?\s*[:=]/.test(body) ||
  /(linear|radial|conic)-gradient/.test(body) ||
  /\bborder(Top|Bottom|Left|Right)?\s*[:=]/.test(body) ||
  /boxShadow\s*[:=]/.test(body) ||
  /<img\b|<Img\b/.test(body) ||
  /\bfill\s*[:=]\s*["'{]/.test(body);
