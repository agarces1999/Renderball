// The measuring rig: load the REAL readSiteBrand / resolveBrandIdentity out of
// the repo, with the network underneath them recorded once and replayed after.
//
// WHY REPLAY. A live-only scorer measures two things at once — the picker and
// whatever the CDN served this minute. Cloudflare and Stripe both A/B their
// homepages; posthog's docs bundle changes daily. If the number moves after a
// fix you must be able to say the fix moved it. So every byte the crawl pulls
// is recorded to disk on the first run and replayed byte-identically after,
// and a URL the new code asks for that isn't in the cache is fetched live and
// added (reported as a MISS, so a fix that reads new sources is visible rather
// than starved).
//
// The interception point is lib/crawl/ssrf-guard's safeFetch: it is the single
// door every crawl fetch goes through, and it uses undici's fetch rather than
// globalThis.fetch, so patching the global would silently do nothing — the
// exact class of "the wire quietly dropped it" bug that blinded the vision
// layer once already. An esbuild alias proves the interception instead.
import * as esbuild from "esbuild";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";

const HERE = dirname(new URL(import.meta.url).pathname);
// qa/brand-truth/ -> repo root. Derived, not hardcoded: this rig now lives in
// the repo it measures, and a pinned absolute path only works on one laptop.
export const REPO = join(HERE, "..", "..");
export const CACHE_DIR = process.env.RB_TRUTH_CACHE
  ? (process.env.RB_TRUTH_CACHE.startsWith("/") ? process.env.RB_TRUTH_CACHE : join(HERE, process.env.RB_TRUTH_CACHE))
  : join(HERE, "cache");

const keyOf = (url) => createHash("sha256").update(url).digest("hex").slice(0, 32);

export const stats = { hits: 0, misses: 0, errors: 0 };

const readCache = (url) => {
  if (process.env.RB_TRUTH_REFETCH === "1") return null;
  const f = join(CACHE_DIR, `${keyOf(url)}.json.gz`);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(gunzipSync(readFileSync(f)).toString("utf8"));
  } catch {
    return null;
  }
};

const writeCache = (url, rec) => {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(join(CACHE_DIR, `${keyOf(url)}.json.gz`), gzipSync(Buffer.from(JSON.stringify(rec))));
};

// Exposed to the bundled shim through globalThis — esbuild's alias target is a
// virtual module, so a global is the honest way to hand it a closure.
globalThis.__RB_TRUTH_FETCH__ = async (realSafeFetch, rawUrl, init) => {
  if (rawUrl.startsWith("data:")) return realSafeFetch(rawUrl, init);
  const hit = readCache(rawUrl);
  if (hit) {
    stats.hits++;
    if (hit.error) throw new Error(hit.error);
    return new Response(hit.body === null ? null : Buffer.from(hit.body, "base64"), {
      status: hit.status,
      headers: hit.headers,
    });
  }
  stats.misses++;
  if (process.env.RB_TRUTH_OFFLINE === "1") throw new Error(`offline: no cache for ${rawUrl}`);
  try {
    const res = await realSafeFetch(rawUrl, init);
    const buf = Buffer.from(await res.arrayBuffer());
    const headers = {};
    for (const [k, v] of res.headers.entries()) {
      if (/^(content-type|content-encoding|location)$/i.test(k)) headers[k] = v;
    }
    writeCache(rawUrl, { status: res.status, headers, body: buf.toString("base64") });
    return new Response(buf, { status: res.status, headers });
  } catch (err) {
    // A THROWN error is NOT cached, deliberately. A 403/404 is a real answer
    // from a real server and replays honestly; a DNS blip or a timeout is
    // weather, and writing it to disk would freeze one bad minute into every
    // future baseline. Failures are retried on each run — they are cheap
    // precisely because there are few of them.
    stats.errors++;
    throw err;
  }
};

const SHIM = `
import * as __real from ${JSON.stringify(join(REPO, "lib/crawl/ssrf-guard.ts"))};
export * from ${JSON.stringify(join(REPO, "lib/crawl/ssrf-guard.ts"))};
export const safeFetch = (url, init = {}) =>
  globalThis.__RB_TRUTH_FETCH__(__real.safeFetch, url, init);
`;

const ENTRY = `
export { readSiteBrand, normalizeSiteUrl } from ${JSON.stringify(join(REPO, "lib/documents/site-brand.ts"))};
export { resolveBrandIdentity, pickSignatureColor, signatureWithLogoFallback } from ${JSON.stringify(join(REPO, "lib/crawl/brand-identity.ts"))};
`;

/** Build (or rebuild) the bundle and import it. Rebuilt every run so a fix to
 *  the picker is picked up without anyone remembering to clear a cache. */
export const loadPicker = async () => {
  const work = join(REPO, "node_modules", ".cache", "rb-truth");
  mkdirSync(work, { recursive: true });
  const shimPath = join(work, "ssrf-shim.ts");
  writeFileSync(shimPath, SHIM);
  const entryPath = join(work, "entry.ts");
  writeFileSync(entryPath, ENTRY);

  const aliasPlugin = {
    name: "alias-ssrf-guard",
    setup(build) {
      build.onResolve({ filter: /(^|\/)ssrf-guard$/ }, (args) => {
        // The shim itself must resolve to the real module, or we recurse.
        if (args.importer === shimPath) return null;
        return { path: shimPath };
      });
    },
  };

  const out = await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node18",
    packages: "external",
    plugins: [aliasPlugin],
    write: false,
    logLevel: "silent",
  });
  const file = join(work, `bundle-${Date.now()}.mjs`);
  writeFileSync(file, out.outputFiles[0].text);
  return import(pathToFileURL(file).href);
};
