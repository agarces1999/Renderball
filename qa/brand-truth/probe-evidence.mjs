// EVIDENCE PROBE — not the scorer, not the extractor.
//
// Its only job is to put facts on the table so a human can adjudicate a truth
// value: the site's own brand CSS token, the header logo SVG's fill, the
// declared display face, and which site builder (if any) served the page.
//
// It deliberately does NOT look at the favicon. The favicon is the signal the
// FIXER is about to start using; deriving truth from it would make the truth
// set agree with the fix by construction.
//
// Usage: node probe-evidence.mjs hosts.txt out.json
import { writeFileSync, readFileSync } from "fs";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const get = async (url, ms = 15000, accept = "text/html,application/xhtml+xml,*/*") => {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: accept },
    redirect: "follow",
    signal: AbortSignal.timeout(ms),
  });
  return res;
};

const abs = (ref, base) => {
  try {
    return new URL(ref, base).toString();
  } catch {
    return null;
  }
};

const detectBuilder = (html, headers, finalUrl) => {
  const h = html.slice(0, 400_000);
  const hits = [];
  if (/cdn\.shopify\.com|Shopify\.theme|shopify-features|myshopify\.com/i.test(h)) hits.push("shopify");
  if (/Static\.SQUARESPACE_CONTEXT|squarespace-cdn\.com|assets\.squarespace\.com/i.test(h))
    hits.push("squarespace");
  if (/static\.parastorage\.com|wixstatic\.com|X-Wix-|wix-code/i.test(h)) hits.push("wix");
  if (/webflow\.js|data-wf-page|assets\.website-files\.com|cdn\.prod\.website-files\.com/i.test(h))
    hits.push("webflow");
  if (/framerusercontent\.com|__framer/i.test(h)) hits.push("framer");
  if (/wp-content\/|wp-includes\//i.test(h)) hits.push("wordpress");
  if (/bigcommerce|cdn11\.bigcommerce/i.test(h)) hits.push("bigcommerce");
  if (/\/_next\/static/i.test(h)) hits.push("nextjs");
  if (headers["x-shopid"] || headers["x-shopify-stage"]) hits.push("shopify(header)");
  if (/squarespace/i.test(headers["server"] ?? "")) hits.push("squarespace(header)");
  if (/\.myshopify\.com|\.squarespace\.com|\.wixsite\.com/i.test(finalUrl)) hits.push("builder(host)");
  return [...new Set(hits)];
};

// CSS custom properties whose NAME says "this is the brand colour". Ranked so a
// human reading the dump sees the strongest naming first.
const BRAND_NAME_RX =
  /^--(?:[a-z0-9-]*)?(?:brand|accent|primary|cta|highlight|theme|main-?colou?r|link)[a-z0-9-]*$/i;

const collectVars = (css) => {
  const out = new Map();
  for (const m of css.matchAll(/(--[a-zA-Z0-9_-]+)\s*:\s*([^;}{]+)[;}]/g)) {
    const name = m[1].trim();
    const val = m[2].trim();
    if (!out.has(name)) out.set(name, val);
  }
  return out;
};

const HEX = /#[0-9a-fA-F]{3,8}\b/;
const isColorish = (v) => HEX.test(v) || /\b(?:rgba?|hsla?|oklch|lab|color)\s*\(/i.test(v);

const resolveVar = (val, vars, depth = 0) => {
  if (depth > 4) return val;
  const m = val.match(/var\(\s*(--[a-zA-Z0-9_-]+)\s*(?:,([^)]*))?\)/);
  if (!m) return val;
  const next = vars.get(m[1]) ?? (m[2] ?? "").trim();
  if (!next) return val;
  return resolveVar(next, vars, depth + 1);
};

// Inline <svg> that sits inside a header/nav/link-to-home — the wordmark.
const headerSvgs = (html) => {
  const out = [];
  const region = html.slice(0, 200_000);
  for (const m of region.matchAll(/<svg[\s\S]{0,8000}?<\/svg>/gi)) {
    const svg = m[0];
    const fills = [
      ...new Set(
        [...svg.matchAll(/(?:fill|stop-color|stroke)\s*[:=]\s*["']?(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\))/gi)].map(
          (x) => x[1].toLowerCase(),
        ),
      ),
    ];
    const chromatic = fills.filter((f) => {
      const hx = f.startsWith("#") ? f : null;
      if (!hx) return true;
      const c = hx.length === 4 ? `#${hx[1]}${hx[1]}${hx[2]}${hx[2]}${hx[3]}${hx[3]}` : hx.slice(0, 7);
      const r = parseInt(c.slice(1, 3), 16),
        g = parseInt(c.slice(3, 5), 16),
        b = parseInt(c.slice(5, 7), 16);
      const mx = Math.max(r, g, b),
        mn = Math.min(r, g, b);
      return mx - mn > 24;
    });
    if (fills.length) out.push({ len: svg.length, fills: fills.slice(0, 12), chromatic: chromatic.slice(0, 8) });
    if (out.length >= 8) break;
  }
  return out;
};

const fontEvidence = (css, html) => {
  const faces = [
    ...new Set(
      [...css.matchAll(/@font-face[^}]*?font-family\s*:\s*(["']?)([^;"']+)\1/gi)].map((m) => m[2].trim()),
    ),
  ];
  const h1 = [
    ...new Set(
      [...css.matchAll(/(^|[},])\s*([^{}]*\b(?:h1|display|heading|hero|title)[^{}]*)\{[^}]*?font-family\s*:\s*([^;}]+)/gi)].map(
        (m) => `${m[2].trim().slice(0, 60)} => ${m[3].trim().slice(0, 90)}`,
      ),
    ),
  ].slice(0, 8);
  const google = [
    ...new Set([...html.matchAll(/fonts\.googleapis\.com\/css2?\?([^"']+)/gi)].flatMap((m) =>
      [...m[1].matchAll(/family=([^&:]+)/g)].map((f) => decodeURIComponent(f[1]).replace(/\+/g, " ")),
    )),
  ];
  const bodyRule = [
    ...new Set(
      [...css.matchAll(/(?:^|[,{}])\s*(?:body|html|:root)\s*\{[^}]*?font-family\s*:\s*([^;}]+)/gi)].map((m) =>
        m[1].trim().slice(0, 110),
      ),
    ),
  ].slice(0, 4);
  return { faces: faces.slice(0, 25), h1, google, bodyRule };
};

const probe = async (host) => {
  const url = `https://${host}/`;
  const rec = { host, url };
  let res;
  try {
    res = await get(url);
  } catch (e) {
    rec.error = `fetch: ${e.message}`;
    return rec;
  }
  rec.status = res.status;
  rec.finalUrl = res.url;
  const headers = Object.fromEntries([...res.headers.entries()]);
  rec.contentType = headers["content-type"];
  if (!res.ok) {
    rec.error = `HTTP ${res.status}`;
    return rec;
  }
  const html = await res.text();
  rec.htmlBytes = html.length;
  rec.builder = detectBuilder(html, headers, res.url);
  rec.themeColor = html.match(/<meta[^>]+name=["']theme-color["'][^>]*content=["']([^"']+)["']/i)?.[1];
  rec.title = html.match(/<title[^>]*>([\s\S]{0,120}?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim();

  const inline = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");
  const links = [
    ...new Set(
      [...html.matchAll(/<link\s[^>]*>/gi)]
        .filter((m) => /rel=["'][^"']*stylesheet/i.test(m[0]))
        .map((m) => abs(m[0].match(/href=["']([^"']+)["']/i)?.[1] ?? "", res.url))
        .filter(Boolean),
    ),
  ].slice(0, 12);
  rec.cssLinks = links.length;
  const sheets = await Promise.all(
    links.map(async (l) => {
      try {
        const r = await get(l, 12000, "text/css,*/*");
        if (!r.ok) return "";
        const t = await r.text();
        return t.slice(0, 900_000);
      } catch {
        return "";
      }
    }),
  );
  const css = [inline, ...sheets].join("\n");
  rec.cssBytes = css.length;

  const vars = collectVars(css);
  const branded = [];
  for (const [name, val] of vars) {
    if (!BRAND_NAME_RX.test(name)) continue;
    const resolved = resolveVar(val, vars);
    if (!isColorish(resolved)) continue;
    branded.push({ name, value: val.slice(0, 60), resolved: resolved.slice(0, 60) });
  }
  rec.brandVars = branded.slice(0, 30);

  // Any var at all whose VALUE is a saturated colour — useful when the naming
  // convention is opaque (Squarespace/Wix emit --color_12 style names).
  const satVars = [];
  for (const [name, val] of vars) {
    const resolved = resolveVar(val, vars);
    const hx = resolved.match(/#[0-9a-fA-F]{6}\b/)?.[0];
    if (!hx) continue;
    const r = parseInt(hx.slice(1, 3), 16),
      g = parseInt(hx.slice(3, 5), 16),
      b = parseInt(hx.slice(5, 7), 16);
    const mx = Math.max(r, g, b),
      mn = Math.min(r, g, b);
    if (mx - mn < 40) continue;
    satVars.push({ name, hex: hx.toLowerCase(), chroma: mx - mn });
  }
  rec.saturatedVars = satVars.sort((a, b) => b.chroma - a.chroma).slice(0, 14);

  rec.headerSvgs = headerSvgs(html);
  rec.fonts = fontEvidence(css, html);
  return rec;
};

const hosts = readFileSync(process.argv[2], "utf8")
  .split("\n")
  .map((s) => s.trim())
  .filter((s) => s && !s.startsWith("#"));

const out = [];
const CONC = 6;
let i = 0;
await Promise.all(
  Array.from({ length: CONC }, async () => {
    while (i < hosts.length) {
      const h = hosts[i++];
      const t = Date.now();
      const r = await probe(h).catch((e) => ({ host: h, error: String(e.message ?? e) }));
      r.ms = Date.now() - t;
      out.push(r);
      process.stderr.write(`${r.error ? "x" : "."}${h} `);
    }
  }),
);
out.sort((a, b) => hosts.indexOf(a.host) - hosts.indexOf(b.host));
writeFileSync(process.argv[3], JSON.stringify(out, null, 2));
process.stderr.write(`\nwrote ${out.length} → ${process.argv[3]}\n`);
