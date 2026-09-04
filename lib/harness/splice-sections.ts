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
  // Module-level declarations the reply put BEFORE its first section (a new
  // helper the rewritten page needs): hoisted in front of the original's first
  // section, so the page does not reference an identifier that never made it
  // in (heist-fastv2-1: "revision broke a render" — exactly this).
  const preface = fresh.length ? body.slice(0, fresh[0].start) : "";
  const hoisted = preface
    .split("\n")
    .filter((l) => /^(?:const|let|function|type|interface)\s/.test(l) || /^\s+/.test(l) || /^[}\])];]?\s*$/.test(l))
    .join("\n")
    .trim();
  const hoist = hoisted && /^(?:const|let|function|type|interface)\s/m.test(hoisted) && !/^import\s/m.test(preface) ? `${hoisted}\n\n` : "";
  const repl = new Map<number, string>();
  for (const idx of wanted) {
    const f = fresh.find((s) => s.index === idx);
    const o = orig.find((s) => s.index === idx);
    // No renaming here (unlike the parallel author's page pass): the reviser
    // sees the whole file, so a section returned under another number IS that
    // other page's content — splicing it in would duplicate a page.
    if (!f || !o) return { ok: false, reason: `Section${idx} missing from the reply` };
    const text = body.slice(f.start, f.end).trimEnd() + "\n\n";
    if (text.length < 400 || text.length < (o.end - o.start) * 0.4) return { ok: false, reason: `Section${idx} re-emission implausibly small` };
    repl.set(idx, text);
  }
  let out = "";
  let cursor = 0;
  for (const [i, o] of orig.entries()) {
    out += code.slice(cursor, o.start);
    if (i === 0 && hoist) out += hoist;
    out += repl.get(o.index) ?? code.slice(o.start, o.end);
    cursor = o.end;
  }
  out += code.slice(cursor);
  const exported = sectionSpans(out).map((s) => s.index).sort((a, b) => a - b).join(",");
  const expected = orig.map((s) => s.index).sort((a, b) => a - b).join(",");
  if (exported !== expected) return { ok: false, reason: "splice lost or duplicated a section export" };
  return { ok: true, code: out, replaced: wanted };
};


/**
 * Which pages a set of defect details live on (page-scoped patch,
 * RB_PATCH_SCOPE=section, 2026-09-04 — the founder's "no search/replace"
 * alternative: the unit of every fix is a page). A detail that only occurs
 * in the module preamble (a logo const, a shared helper) has no page →
 * null → the caller falls back to the full-file patch.
 */
export const pagesForDetails = (code: string, details: string[]): number[] | null => {
  const spans = sectionSpans(code);
  if (!spans.length) return null;
  const pages = new Set<number>();
  for (const d of details) {
    const needle = d.trim();
    if (!needle) continue;
    let found = false;
    for (const sp of spans) {
      if (code.slice(sp.start, sp.end).includes(needle)) {
        pages.add(sp.index);
        found = true;
      }
    }
    if (!found) return null; // lives outside every section (preamble) or is not literal
  }
  return [...pages].sort((a, b) => a - b);
};
