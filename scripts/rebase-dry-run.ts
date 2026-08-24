//
// C1 DRY RUN — would `Piece` becoming a real box break the decks already on disk?
//
// THE PLAN. Emitted Piece.tsx is `display: contents`, so it creates no box and
// layout-composer.ts's disjoint slot bounds are discarded; children position against
// the CANVAS instead. Giving the wrapper `position:absolute` at its slot with
// `overflow:hidden` would make cross-piece overlap structurally impossible rather than
// detected-and-repaired — but any content that currently sits OUTSIDE its assigned slot
// would be clipped the moment the box exists.
//
// So the question is not "can coordinates be subtracted" — they always can. It is
// whether each piece's real ink already fits the slot the composer assigned it.
//
// A FIRST VERSION OF THIS SCRIPT GOT THAT WRONG and is recorded so it is not rebuilt:
// it took each piece's own bounding box as the origin and asked whether rebasing went
// negative. Subtracting a minimum never goes negative, so it reported 100% clean — a
// tautology, not a measurement.
//
// This version compares MEASURED ink (.render-truth/rects-scene-N.json, produced by
// the gate pipeline in a real browser) against the slot composeSceneLayout actually
// issues for that scene's register. Only decks with stored measurements can be judged;
// the rest are reported as unknown rather than assumed fine.
//
//   npx tsx scripts/rebase-dry-run.ts
//
import { promises as fs } from "fs";
import path from "path";
import { composeSceneLayout } from "../lib/agents/layout-composer";

const ROOT = path.join(process.cwd(), "src", "generated");
/** Slack, canvas px: a hairline border or a shadow spilling a pixel is not a defect. */
const TOLERANCE = 2;

interface Rect { x: number; y: number; w: number; h: number; piece: string; pieceKind: string; text?: string; isImg?: boolean }

const main = async (): Promise<void> => {
  let decksJudged = 0;
  let decksUnmeasured = 0;
  let scenes = 0;
  let piecesJudged = 0;
  let fits = 0;
  let overflows = 0;
  let noSlot = 0;
  const worst: { deck: string; scene: number; piece: string; byPx: number }[] = [];

  for (const id of await fs.readdir(ROOT)) {
    const rt = path.join(ROOT, id, ".render-truth");
    const sp = path.join(ROOT, id, "script.json");
    if (!(await fs.stat(sp).catch(() => null))) continue;
    if (!(await fs.stat(rt).catch(() => null))?.isDirectory()) { decksUnmeasured++; continue; }

    let script: { aspect?: string; scenes?: Record<string, unknown>[] };
    try { script = JSON.parse(await fs.readFile(sp, "utf8")); } catch { decksUnmeasured++; continue; }
    const aspect = (script.aspect === "9:16" ? "9:16" : "16:9") as "16:9" | "9:16";
    let judgedHere = false;

    for (const f of await fs.readdir(rt)) {
      const m = /^rects-scene-(\d+)\.json$/.exec(f);
      if (!m) continue;
      const sceneIndex = Number(m[1]);
      const scene = script.scenes?.[sceneIndex];
      if (!scene) continue;

      let data: { elements?: Rect[] };
      try { data = JSON.parse(await fs.readFile(path.join(rt, f), "utf8")); } catch { continue; }

      let plan;
      try { plan = composeSceneLayout(scene as never, aspect); } catch { continue; }
      const slotFor = new Map<string, { x: number; y: number; w: number; h: number }>();
      for (const slot of plan.elements) slotFor.set(slot.id, slot.bounds);

      // Real ink per piece: union of its text/image leaves, the same definition the
      // occupancy work settled on. A container div spans the slide by construction and
      // would make every piece look like an overflow.
      const inkOf = new Map<string, { x1: number; y1: number; x2: number; y2: number }>();
      for (const r of data.elements ?? []) {
        if (!r.piece) continue;
        if (r.pieceKind === "atmosphere" || r.pieceKind === "chrome") continue;
        if (!((r.text && r.text.trim()) || r.isImg)) continue;
        if (r.w <= 2 || r.h <= 2) continue;
        const cur = inkOf.get(r.piece);
        const box = { x1: r.x, y1: r.y, x2: r.x + r.w, y2: r.y + r.h };
        inkOf.set(
          r.piece,
          cur
            ? { x1: Math.min(cur.x1, box.x1), y1: Math.min(cur.y1, box.y1), x2: Math.max(cur.x2, box.x2), y2: Math.max(cur.y2, box.y2) }
            : box,
        );
      }
      if (inkOf.size === 0) continue;
      scenes++;
      judgedHere = true;

      for (const [pieceId, ink] of inkOf) {
        // Piece ids are scene-prefixed ("s2.copy"); the composer issues role-only ids.
        const role = pieceId.replace(/^s\d+\./, "");
        const slot = slotFor.get(role);
        piecesJudged++;
        if (!slot) { noSlot++; continue; }
        const over = Math.max(
          slot.x - ink.x1,
          slot.y - ink.y1,
          ink.x2 - (slot.x + slot.w),
          ink.y2 - (slot.y + slot.h),
        );
        if (over <= TOLERANCE) fits++;
        else {
          overflows++;
          worst.push({ deck: id, scene: sceneIndex, piece: pieceId, byPx: Math.round(over) });
        }
      }
    }
    if (judgedHere) decksJudged++; else decksUnmeasured++;
  }

  console.log(`decks with stored measurements: ${decksJudged}`);
  console.log(`decks that cannot be judged:    ${decksUnmeasured}  (no .render-truth — unknown, not assumed fine)`);
  console.log(`scenes judged:                  ${scenes}`);
  console.log(`pieces judged:                  ${piecesJudged}\n`);
  const denom = Math.max(fits + overflows, 1);
  console.log(`ink already INSIDE its composer slot:  ${fits}  (${((100 * fits) / denom).toFixed(1)}%)`);
  console.log(`ink OUTSIDE its slot (would clip):     ${overflows}  (${((100 * overflows) / denom).toFixed(1)}%)`);
  console.log(`role the composer issues no slot for:  ${noSlot}`);

  if (worst.length) {
    console.log("\nworst overflows (px beyond the slot):");
    for (const w of worst.sort((a, b) => b.byPx - a.byPx).slice(0, 12)) {
      console.log(`  ${w.byPx.toString().padStart(5)}px  ${w.deck.slice(0, 10)}… s${w.scene} ${w.piece}`);
    }
  }
};

void main();
