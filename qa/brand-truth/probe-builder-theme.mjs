// EVIDENCE PROBE 3 — the site builder's own THEME SETTINGS.
//
// On a Squarespace 7.1 site the merchant picks a palette in the editor and the
// page ships it as `--accent-hsl: 14, 89%, 55%` style variables; a Shopify Dawn
// theme ships `--color-base-accent-1` / `--color-button`. Those are not template
// defaults — they are the small business's OWN brand choice, recorded by the
// builder. That makes them a first-class truth source for exactly the segment
// (42% of the corpus) the picker gets wrong.
//
// Usage: node probe-builder-theme.mjs hosts.txt out.json
import { readFileSync, writeFileSync } from "fs";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const get = (u, ms = 20000) =>
  fetch(u, { headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(ms) });
const abs = (r, b) => {
  try {
    return new URL(r, b).toString();
  } catch {
    return null;
  }
};

const hslToHex = (h, s, l) => {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to2 = (x) =>
    Math.round(Math.max(0, Math.min(1, x)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to2(f(0))}${to2(f(8))}${to2(f(4))}`;
};

const TOKEN_RX =
  /--(accent|darkAccent|lightAccent|safeLightAccent|safeDarkAccent|primaryButton[A-Za-z]*|color-base-accent-1|color-base-accent-2|color-button|color-accent|siteBackgroundColor|black|white)[A-Za-z-]*\s*:\s*([^;}{]+)/g;

const run = async (host) => {
  const rec = { host, tokens: [], buttonRules: [], logo: null };
  const root = `https://${host}/`;
  let html = "";
  try {
    const r = await get(root);
    html = await r.text();
    rec.finalUrl = r.url;
  } catch (e) {
    rec.error = String(e.message ?? e);
    return rec;
  }
  const inline = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");
  const links = [
    ...new Set(
      [...html.matchAll(/<link\s[^>]*>/gi)]
        .filter((m) => /rel=["'][^"']*stylesheet/i.test(m[0]))
        .map((m) => abs(m[0].match(/href=["']([^"']+)["']/i)?.[1] ?? "", root))
        .filter(Boolean),
    ),
  ].slice(0, 12);
  const sheets = await Promise.all(
    links.map(async (l) => {
      try {
        const r = await get(l, 15000);
        return r.ok ? (await r.text()).slice(0, 1_500_000) : "";
      } catch {
        return "";
      }
    }),
  );
  const css = [inline, ...sheets].join("\n");
  rec.cssBytes = css.length;

  const seen = new Set();
  for (const m of css.matchAll(TOKEN_RX)) {
    const decl = m[0].split(":")[0].trim();
    const raw = m[2].trim().slice(0, 60);
    const key = `${decl}=${raw}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Squarespace writes the triple bare so it can be used inside hsl()
    const hsl = raw.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)%\s*,\s*(\d+(?:\.\d+)?)%$/);
    const hex = hsl ? hslToHex(+hsl[1], +hsl[2], +hsl[3]) : (raw.match(/#[0-9a-fA-F]{6}\b/)?.[0] ?? null);
    rec.tokens.push({ decl, raw, hex });
  }

  // Whatever paints the primary button, whether or not it came from a token.
  for (const m of css.matchAll(
    /([^{}]{0,120}(?:button|btn|cta)[^{}]{0,120})\{([^}]{0,300}?)background(?:-color)?\s*:\s*([^;}]+)/gi,
  )) {
    const val = m[3].trim();
    if (!/#[0-9a-fA-F]{3,8}|rgb|hsl|var\(/.test(val)) continue;
    rec.buttonRules.push(`${m[1].trim().slice(0, 70)} => ${val.slice(0, 60)}`);
    if (rec.buttonRules.length >= 14) break;
  }

  const logo =
    html.match(/<img[^>]+(?:class|id)=["'][^"']*logo[^"']*["'][^>]*src=["']([^"']+)["']/i)?.[1] ??
    html.match(/<img[^>]+src=["']([^"']*logo[^"']*)["']/i)?.[1] ??
    null;
  rec.logo = logo ? abs(logo, root) : null;
  return rec;
};

const hosts = readFileSync(process.argv[2], "utf8")
  .split("\n")
  .map((s) => s.trim())
  .filter((s) => s && !s.startsWith("#"));
const out = [];
let i = 0;
await Promise.all(
  Array.from({ length: 5 }, async () => {
    while (i < hosts.length) {
      const h = hosts[i++];
      out.push(await run(h).catch((e) => ({ host: h, error: String(e.message ?? e) })));
      process.stderr.write(".");
    }
  }),
);
out.sort((a, b) => hosts.indexOf(a.host) - hosts.indexOf(b.host));
writeFileSync(process.argv[3], JSON.stringify(out, null, 2));
process.stderr.write(`\nwrote ${out.length}\n`);
