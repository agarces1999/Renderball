//
// The deterministic decomposer + reassembler (LEGO engine M1b). NO LLM.
//
// The design agent emits a monolithic Composition.tsx whose module preamble is
// VARIABLE (a PALETTE object, agent-named font/keyframe consts like ANIMATIONS_CSS,
// an EASE_OUT, a Chrome/lastWordAccent helper) and whose pieces SELF-POSITION inside
// transparent Piece markers. So a faithful, lossless split cannot reconstruct a
// "clean theme" from a fixed schema — it captures verbatim:
//
//   decompose(code) -> {
//     preamble,   // everything before the first `export const Section0`
//     scenes: [{ sceneIndex,
//       template, // the Section source with each Piece block replaced by an RB:id slot
//       pieces: [{ id, kind, throughline?, openTag, body }] }],
//     tail,       // the `export const Generated` alias onward
//   }
//
// reassemble(d) fills each slot back with openTag + body + close, so with NO edits
// it is BYTE-IDENTICAL to the input (the round-trip proof). Editing or regenerating
// ONE piece rewrites only its body; the template, preamble, and every sibling piece
// are untouched — the structural zero-neighbor guarantee, as a data fact. The
// per-piece body is the editable unit the assembler re-inlines.
//
// Parsing stays positional (like section-splice.ts, AST-free): Section boundaries
// from sectionRanges, then a balanced Piece scan (M1 pieces do not nest, so the next
// close tag closes the current piece).
//
import { sectionRanges } from "./section-splice";

export interface DecomposedPiece {
  id: string;
  kind: string;
  throughline?: string;
  // The verbatim opening tag, stored so reassembly is byte-exact regardless of
  // attribute order or spacing.
  openTag: string;
  // The piece's inner JSX (self-positioned) — the editable / regeneratable unit.
  body: string;
}

export interface DecomposedScene {
  sceneIndex: number;
  // The Section source with each piece replaced by an RB:id comment slot.
  template: string;
  pieces: DecomposedPiece[];
}

export interface Decomposed {
  preamble: string;
  scenes: DecomposedScene[];
  tail: string;
}

const PIECE_OPEN_RX = /<Piece\b[^>]*>/g;
const CLOSE = "</Piece>";
const SLOT_OPEN = "{/*RB:";
const SLOT_CLOSE = "*/}";

const attr = (tag: string, name: string): string | undefined => {
  const m = tag.match(new RegExp("\\b" + name + '\\s*=\\s*"([^"]*)"'));
  return m ? m[1] : undefined;
};

const slot = (id: string): string => SLOT_OPEN + id + SLOT_CLOSE;

export const decompose = (code: string): Decomposed => {
  const ranges = sectionRanges(code);
  if (ranges.length === 0) return { preamble: code, scenes: [], tail: "" };

  const preamble = code.slice(0, ranges[0].start);
  const tail = code.slice(ranges[ranges.length - 1].end);

  const scenes: DecomposedScene[] = ranges.map((r) => {
    const src = code.slice(r.start, r.end);
    const pieces: DecomposedPiece[] = [];
    let template = "";
    let cursor = 0;
    PIECE_OPEN_RX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PIECE_OPEN_RX.exec(src))) {
      const openTag = m[0];
      const bodyStart = m.index + openTag.length;
      const closeIdx = src.indexOf(CLOSE, bodyStart);
      if (closeIdx === -1) break; // malformed open tag with no close — leave the rest verbatim
      const body = src.slice(bodyStart, closeIdx);
      const id = attr(openTag, "id") ?? "s" + r.index + ".p" + pieces.length;
      pieces.push({
        id,
        kind: attr(openTag, "kind") ?? "diegetic",
        throughline: attr(openTag, "throughline"),
        openTag,
        body,
      });
      template += src.slice(cursor, m.index) + slot(id);
      cursor = closeIdx + CLOSE.length;
      PIECE_OPEN_RX.lastIndex = cursor;
    }
    template += src.slice(cursor);
    return { sceneIndex: r.index, template, pieces };
  });

  return { preamble, scenes, tail };
};

// Reassemble a Composition.tsx from a Decomposed tree. bodyOf supplies the
// (possibly edited / regenerated) body for a piece; omit it to use the captured
// body verbatim (the byte-identical round trip). A piece whose slot is absent from
// the template is skipped (it was deleted from the manifest).
export const reassemble = (
  d: Decomposed,
  bodyOf?: (sceneIndex: number, piece: DecomposedPiece) => string,
): string => {
  const sections = d.scenes.map((s) => {
    let out = s.template;
    for (const p of s.pieces) {
      const body = bodyOf ? bodyOf(s.sceneIndex, p) : p.body;
      out = out.replace(slot(p.id), p.openTag + body + CLOSE);
    }
    return out;
  });
  return d.preamble + sections.join("") + d.tail;
};

// Total pieces across all scenes — convenience for diagnostics / manifests.
export const pieceCount = (d: Decomposed): number =>
  d.scenes.reduce((n, s) => n + s.pieces.length, 0);
