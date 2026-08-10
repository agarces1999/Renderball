// EVIDENCE PROBE 2 — for sites whose CSS custom properties said nothing.
//
// Two independent questions, answered off the site's OWN bytes (HTML + every
// stylesheet + the first JS chunks, which is where a Tailwind/JS-styled site
// actually keeps its colours):
//   1. WHICH SATURATED COLOUR DOES THIS SITE SERVE MOST? — frequency rank.
//   2. DOES A REMEMBERED BRAND HEX ACTUALLY APPEAR? — hypothesis, confirmed or
//      not against real bytes rather than asserted from memory.
//
// Again: the favicon is not consulted. That is the fixer's signal.
//
// Usage: node probe-frequency.mjs candidates.json out.json
import { readFileSync, writeFileSync } from "fs";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const get = (url, ms = 15000) =>
  fetch(url, { headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(ms) });
const abs = (ref, base) => {
  try {
    return new URL(ref, base).toString();
  } catch {
    return null;
  }
};

const norm = (hx) => {
  const h = hx.toLowerCase();
  return h.length === 4 ? `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}` : h.slice(0, 7);
};
const chromaOf = (hex) => {
  const r = parseInt(hex.slice(1, 3), 16),
    g = parseInt(hex.slice(3, 5), 16),
    b = parseInt(hex.slice(5, 7), 16);
  return Math.max(r, g, b) - Math.min(r, g, b);
};

const run = async ({ host, candidates = [] }) => {
  const rec = { host, candidates: {}, topSaturated: [], bytes: 0, sources: 0 };
  const root = `https://${host}/`;
  let html = "";
  try {
    const r = await get(root);
    html = await r.text();
  } catch (e) {
    rec.error = String(e.message ?? e);
    return rec;
  }
  const urls = [
    ...new Set(
      [...html.matchAll(/<link\s[^>]*>/gi)]
        .filter((m) => /rel=["'][^"']*stylesheet/i.test(m[0]))
        .map((m) => abs(m[0].match(/href=["']([^"']+)["']/i)?.[1] ?? "", root))
        .filter(Boolean),
    ),
  ].slice(0, 14);
  const js = [
    ...new Set(
      [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)]
        .map((m) => abs(m[1], root))
        .filter((u) => u && /\.js(\?|$)/i.test(u)),
    ),
  ].slice(0, 14);

  const bodies = [html];
  await Promise.all(
    [...urls, ...js].map(async (u) => {
      try {
        const r = await get(u, 12000);
        if (!r.ok) return;
        const t = await r.text();
        bodies.push(t.slice(0, 1_200_000));
      } catch {
        /* a missing chunk is missing evidence, not a failure */
      }
    }),
  );
  const all = bodies.join("\n");
  rec.bytes = all.length;
  rec.sources = bodies.length;

  const counts = new Map();
  for (const m of all.matchAll(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)) {
    const h = norm(m[0]);
    if (chromaOf(h) < 40) continue;
    counts.set(h, (counts.get(h) ?? 0) + 1);
  }
  // rgb(r,g,b) written out is the same colour by another name
  for (const m of all.matchAll(/rgba?\(\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})/g)) {
    const to2 = (n) => Math.min(255, parseInt(n, 10)).toString(16).padStart(2, "0");
    const h = `#${to2(m[1])}${to2(m[2])}${to2(m[3])}`;
    if (chromaOf(h) < 40) continue;
    counts.set(h, (counts.get(h) ?? 0) + 1);
  }
  rec.topSaturated = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 18)
    .map(([hex, n]) => ({ hex, n }));

  for (const c of candidates) {
    const bare = c.replace("#", "").toLowerCase();
    const r = parseInt(bare.slice(0, 2), 16),
      g = parseInt(bare.slice(2, 4), 16),
      b = parseInt(bare.slice(4, 6), 16);
    const hexHits = (all.match(new RegExp(`#${bare}\\b`, "gi")) ?? []).length;
    const rgbHits = (all.match(new RegExp(`rgba?\\(\\s*${r}\\s*[,\\s]\\s*${g}\\s*[,\\s]\\s*${b}`, "g")) ?? [])
      .length;
    rec.candidates[c] = { hexHits, rgbHits };
  }
  return rec;
};

const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
const out = [];
let i = 0;
await Promise.all(
  Array.from({ length: 5 }, async () => {
    while (i < input.length) {
      const job = input[i++];
      const r = await run(job).catch((e) => ({ host: job.host, error: String(e.message ?? e) }));
      out.push(r);
      process.stderr.write(`${r.error ? "x" : "."}${r.host} `);
    }
  }),
);
out.sort((a, b) => input.findIndex((j) => j.host === a.host) - input.findIndex((j) => j.host === b.host));
writeFileSync(process.argv[3], JSON.stringify(out, null, 2));
process.stderr.write(`\nwrote ${out.length}\n`);
