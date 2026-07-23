// ../../../private/tmp/claude-501/-Users-alfonsogarces-VIDEO-GEN/8e5a1e8e-9206-4aec-b903-15b4bf81622b/scratchpad/size-calib.ts
import { readdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
var ROOT = "/Users/alfonsogarces/VIDEO_GEN/.data/dogfood";
var W = 1920;
var H = 1080;
var byKey = /* @__PURE__ */ new Map();
var focal = [];
for (const dir of readdirSync(ROOT)) {
  const p = join(ROOT, dir, "composition.json");
  if (!existsSync(p)) continue;
  const comps = JSON.parse(readFileSync(p, "utf8"));
  for (const k of Object.keys(comps)) {
    const els = comps[k].composition.elements ?? [];
    let r1 = null;
    let other = { a: 0, role: "-" };
    for (const e of els) {
      if (!e.bounds) continue;
      const a = e.bounds.w * e.bounds.h;
      const key = `${e.role}/fr${e.focalRank ?? "-"}`;
      const b = byKey.get(key) ?? { w: [], h: [], a: [] };
      b.w.push(e.bounds.w / W);
      b.h.push(e.bounds.h / H);
      b.a.push(a / (W * H));
      byKey.set(key, b);
      if (e.focalRank === 1) r1 = { a, role: e.role };
      else if (a > other.a) other = { a, role: e.role };
    }
    if (r1) focal.push({ rank1Area: r1.a / (W * H), maxOtherArea: other.a / (W * H), dir, s: Number(k), rank1Role: r1.role, winner: other.role });
  }
}
var pct = (v, p) => {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(p * (s.length - 1))];
};
console.log("key	n	w:min/p10/med	h:min/p10/med	area:min/p10/med");
for (const [k, b] of [...byKey.entries()].sort()) {
  if (b.w.length < 3) continue;
  console.log(`${k}	${b.w.length}	${pct(b.w, 0).toFixed(3)}/${pct(b.w, 0.1).toFixed(3)}/${pct(b.w, 0.5).toFixed(3)}	${pct(b.h, 0).toFixed(3)}/${pct(b.h, 0.1).toFixed(3)}/${pct(b.h, 0.5).toFixed(3)}	${pct(b.a, 0).toFixed(3)}/${pct(b.a, 0.1).toFixed(3)}/${pct(b.a, 0.5).toFixed(3)}`);
}
var viol = focal.filter((f) => f.maxOtherArea > f.rank1Area);
console.log(`
FOCAL DOMINANCE: ${focal.length} composed scenes with a rank-1 element.`);
console.log(`rank-1 is NOT the largest in ${viol.length} (${(100 * viol.length / focal.length).toFixed(1)}%)`);
for (const b of [0, 0.02, 0.05, 0.1, 0.2]) {
  const n = focal.filter((f) => f.maxOtherArea > f.rank1Area * (1 + b)).length;
  console.log(`  tie-band ${(b * 100).toFixed(0)}%: ${n} violations (${(100 * n / focal.length).toFixed(1)}%)`);
}
console.log("\nworst offenders (ratio other/rank1):");
for (const f of viol.sort((a, b) => b.maxOtherArea / b.rank1Area - a.maxOtherArea / a.rank1Area).slice(0, 12))
  console.log(`  ${(f.maxOtherArea / f.rank1Area).toFixed(2)}x  ${f.dir} s${f.s}  rank1=${f.rank1Role}(${f.rank1Area.toFixed(3)}) beaten by ${f.winner}(${f.maxOtherArea.toFixed(3)})`);
