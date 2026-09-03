/**
 * Section-scoped revision splice (RB_REVISE_SCOPE=section; 10x program,
 * 2026-09-04).
 *
 * The full-file revision re-emits ~17k tokens (160-190s — as long as the
 * author call) to change one or two pages. Here the model re-emits ONLY the
 * flagged `export const SectionN` components — complete pages, with full
 * compositional freedom inside each — and they are spliced over the
 * originals. This is deliberately NOT the block-scale edit-block revision the
 * founder rejected (ab6, 2026-09-02: "a bunch of blank spaces"): a whole page
 * is the unit, so composition-scale weaknesses get composition-scale answers.
 *
 * Safety: only the FLAGGED indices are taken from the reply (a model that
 * emits the whole file anyway cannot drift the pages the critics did not
 * flag); a missing or implausibly small section, or a splice that loses an
 * export, refuses — and the caller falls through to today's full-file path.
 */

export interface SectionSpan {
  index: number;
  start: number;
  end: number;
}

/** Byte spans of every `export const SectionN` in a deck file, in file order. */
export const sectionSpans = (code: string): SectionSpan[] => {
  const heads = [...code.matchAll(/^export const Section(\d+)\b/gm)].map((m) => ({ index: Number(m[1]), start: m.index ?? 0 }));
  return heads.map((h, i) => ({ index: h.index, start: h.start, end: i + 1 < heads.length ? heads[i + 1].start : code.length }));
};

export type SpliceResult = { ok: true; code: string; replaced: number[] } | { ok: false; reason: string };

export const spliceSections = (code: string, reply: string, flagged: number[]): SpliceResult => {
  const fenced = [...reply.matchAll(/```(?:tsx|typescript|jsx|ts)?\s*\n([\s\S]*?)```/g)].map((x) => x[1]);
  const body = fenced.length ? fenced.join("\n\n") : reply;
  const fresh = sectionSpans(body);
  const orig = sectionSpans(code);
  if (!orig.length) return { ok: false, reason: "no sections in the original" };
  const wanted = [...new Set(flagged)].sort((a, b) => a - b);
  if (!wanted.length) return { ok: false, reason: "nothing flagged" };
  const repl = new Map<number, string>();
  for (const idx of wanted) {
    const f = fresh.find((s) => s.index === idx);
    const o = orig.find((s) => s.index === idx);
    if (!f || !o) return { ok: false, reason: `Section${idx} missing from the reply` };
    const text = body.slice(f.start, f.end).trimEnd() + "\n\n";
    if (text.length < 400 || text.length < (o.end - o.start) * 0.4) return { ok: false, reason: `Section${idx} re-emission implausibly small` };
    repl.set(idx, text);
  }
  let out = "";
  let cursor = 0;
  for (const o of orig) {
    out += code.slice(cursor, o.start);
    out += repl.get(o.index) ?? code.slice(o.start, o.end);
    cursor = o.end;
  }
  out += code.slice(cursor);
  const exported = sectionSpans(out).map((s) => s.index).sort((a, b) => a - b).join(",");
  const expected = orig.map((s) => s.index).sort((a, b) => a - b).join(",");
  if (exported !== expected) return { ok: false, reason: "splice lost or duplicated a section export" };
  return { ok: true, code: out, replaced: wanted };
};
