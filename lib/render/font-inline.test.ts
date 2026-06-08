/**
 * Tests for the font-inline pass (cross-origin @font-face → same-origin data:).
 *
 * The corgi.insure build hot-linked the brand font from the brand CDN, which
 * sends no CORS header, so the @font-face failed in both the preview iframe and
 * the Remotion render and the headline fell back to the generic. inlineFontFaces
 * downloads the font once at build time and rewrites the url() to a data: URL so
 * it loads same-origin everywhere. These lock the rewrite + the dead-URL safety.
 *
 * Run: `npm test`. No API key, no network (fetch is injected).
 */
import { makeFontFetcher, inlineFontFaces } from "./font-inline";
import * as esbuild from "esbuild";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : err}`);
  }
};
const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg);
};
const compileErr = async (code: string): Promise<string | null> => {
  try {
    await esbuild.transform(code, { loader: "tsx" });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message.split("\n").slice(0, 2).join(" ") : String(e);
  }
};

// A fake fetch returning fixed bytes for any URL — no network.
const okFetch =
  (bytes: number[]): typeof fetch =>
  (async () =>
    ({
      ok: true,
      arrayBuffer: async () => new Uint8Array(bytes).buffer,
    }) as unknown as Response) as unknown as typeof fetch;

// The real corgi @font-face line (single quotes around url() so the rewritten
// data: URL stays inside a valid string literal for the compile check).
const CORGI_CODE =
  'const BRAND_FONTS_CSS = `@font-face { font-family: "f37Bolton"; ' +
  "src: url('https://corgi.insure/media/f37_bolton_light-s.p.0o6osq.otf?dpl=dpl_27aPEbX') " +
  'format("opentype"); font-display: block; }`;';

// ── The rewrite: cross-origin font URL → data: URL ───────────────────────
await check("rewrites a cross-origin .otf (with ?dpl= query) to a data: URL", async () => {
  const fetchFont = makeFontFetcher({ fetchImpl: okFetch([0, 1, 2, 3]) });
  const out = await inlineFontFaces(CORGI_CODE, fetchFont);
  assert(out.inlined.length === 1, `expected 1 inlined, got ${out.inlined.length}`);
  assert(out.failed.length === 0, `expected 0 failed, got ${out.failed.length}`);
  assert(!out.code.includes("corgi.insure"), "remote corgi URL should be gone");
  assert(out.code.includes("data:font/otf;base64,"), "should contain an otf data: URL");
});

await check("the rewritten composition still compiles", async () => {
  const fetchFont = makeFontFetcher({ fetchImpl: okFetch([0, 1, 2, 3]) });
  const out = await inlineFontFaces(CORGI_CODE, fetchFont);
  const err = await compileErr(out.code);
  assert(err === null, `rewritten code did not compile: ${err}`);
});

// ── Dead-URL safety: a font that won't fetch keeps its remote URL ─────────
await check("a font that fails to fetch is LEFT as the remote URL (never crashes)", async () => {
  const nullFetch = async () => null;
  const out = await inlineFontFaces(CORGI_CODE, nullFetch);
  assert(out.inlined.length === 0, "nothing inlined");
  assert(out.failed.length === 1, `expected 1 failed, got ${out.failed.length}`);
  assert(out.code === CORGI_CODE, "code is unchanged when the fetch fails");
});

// ── Only @font-face fonts are touched — image url()s are left alone ───────
await check("non-font URLs (a Pexels .jpeg) are not matched or rewritten", async () => {
  const code =
    CORGI_CODE +
    '\nconst HERO = "https://images.pexels.com/photos/123/x.jpeg?auto=compress";';
  let calledWith: string[] = [];
  const fetchFont = async (u: string) => {
    calledWith.push(u);
    return "data:font/otf;base64,AAEC";
  };
  const out = await inlineFontFaces(code, fetchFont);
  assert(
    out.code.includes("images.pexels.com/photos/123/x.jpeg"),
    "the image URL must be untouched",
  );
  assert(
    calledWith.length === 1 && calledWith[0].includes("corgi.insure"),
    `only the font URL should be fetched, got ${JSON.stringify(calledWith)}`,
  );
});

await check("code with no font URLs is returned unchanged", async () => {
  const code = 'const x = "https://images.pexels.com/photos/1/y.png";';
  const out = await inlineFontFaces(code, async () => "data:font/otf;base64,Z");
  assert(out.code === code, "unchanged");
  assert(out.inlined.length === 0 && out.failed.length === 0, "no font work");
});

// ── makeFontFetcher: MIME per extension, base64 body, caching, null cases ──
await check("MIME is correct per extension (woff2 / woff / otf / ttf)", async () => {
  const f = makeFontFetcher({ fetchImpl: okFetch([1, 2, 3]) });
  const b64 = Buffer.from([1, 2, 3]).toString("base64");
  assert((await f("https://x.com/a.woff2")) === `data:font/woff2;base64,${b64}`, "woff2");
  assert((await f("https://x.com/a.woff")) === `data:font/woff;base64,${b64}`, "woff");
  assert((await f("https://x.com/a.otf")) === `data:font/otf;base64,${b64}`, "otf");
  assert((await f("https://x.com/a.ttf")) === `data:font/ttf;base64,${b64}`, "ttf");
  // Query string after the extension must not break MIME detection.
  assert(
    (await f("https://x.com/a.woff2?dpl=abc")) === `data:font/woff2;base64,${b64}`,
    "woff2 + query",
  );
});

await check("makeFontFetcher caches per URL (one download even if asked twice)", async () => {
  let calls = 0;
  const counting: typeof fetch = (async () => {
    calls++;
    return {
      ok: true,
      arrayBuffer: async () => new Uint8Array([9]).buffer,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  const f = makeFontFetcher({ fetchImpl: counting });
  await f("https://x.com/a.woff2");
  await f("https://x.com/a.woff2");
  assert(calls === 1, `expected 1 fetch, got ${calls}`);
});

await check("makeFontFetcher returns null for a non-http (data:) src", async () => {
  const f = makeFontFetcher({ fetchImpl: okFetch([1]) });
  assert((await f("data:font/woff2;base64,AAAA")) === null, "data: → null");
});

await check("makeFontFetcher returns null on a non-ok response (dead URL)", async () => {
  const dead: typeof fetch = (async () =>
    ({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) }) as unknown as Response) as unknown as typeof fetch;
  const f = makeFontFetcher({ fetchImpl: dead });
  assert((await f("https://x.com/gone.otf")) === null, "404 → null");
});

await check("makeFontFetcher returns null on an empty body", async () => {
  const f = makeFontFetcher({ fetchImpl: okFetch([]) });
  assert((await f("https://x.com/empty.otf")) === null, "0 bytes → null");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
