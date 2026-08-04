/**
 * Truncate text that is about to be PUT IN A PROMPT — at a word boundary,
 * never mid-token.
 *
 * This is not cosmetic. Measured 2026-08-04 with curl against the raw
 * endpoint: the Fireworks glm-5p2-fast router HANGS SERVER-SIDE — accepts the
 * request and never sends response headers, forever — on prompts that combine
 * a "create this element" instruction with a fragment cut mid-token. The same
 * text truncated at a word boundary answers in about a second. Both halves of
 * the trigger are individually harmless; it is the combination that hangs.
 *
 * The cost of getting this wrong is measured in TEN-MINUTE UNITS, because a
 * hung call burns its whole timeout and then its whole retry ladder:
 *   - editor generate: a 600s stall on the first element of every new document
 *     (the blank template's hint piece cut at "…fontFamily" every time);
 *   - builds: intermittent 37/56/66-minute builds sitting in the same history
 *     as 4-minute ones — the outliers were never a speed problem, they were
 *     this, hit by luck of where a 600-char cut landed.
 *
 * So: every truncation that feeds a prompt goes through here. An ellipsis
 * marks the cut so the model knows it is reading a fragment.
 */
export const promptDigest = (text: string, max = 150): string => {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  // Prefer the last space; fall back to a hard cut only when the window holds
  // no boundary at all (a single enormous token), where 40 keeps enough
  // context to be useful.
  const atWord = cut.slice(0, Math.max(cut.lastIndexOf(" "), 40));
  return `${atWord} …`;
};
