/**
 * Tests for the design-language crawl pass (screenshot + vision analysis).
 * Run: `npm test`. No network, no API key — fetch + the Anthropic client are
 * injected.
 */
import {
  captureSiteScreenshot,
  parseDesignLanguage,
  analyzeDesignLanguage,
  formatDesignLanguage,
} from "./design-language";

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

const fakeFetch = (body: unknown, ok = true): typeof fetch =>
  (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;

// ── captureSiteScreenshot (microlink) ────────────────────────────────────────
await check("returns the screenshot URL on a successful microlink response", async () => {
  const f = fakeFetch({ status: "success", data: { screenshot: { url: "https://cdn.microlink.io/shot.png" } } });
  const url = await captureSiteScreenshot("https://corgi.insure", { fetchImpl: f });
  assert(url === "https://cdn.microlink.io/shot.png", `got ${url}`);
});

await check("returns null when microlink status is not success", async () => {
  const f = fakeFetch({ status: "fail", data: {} });
  assert((await captureSiteScreenshot("https://x.com", { fetchImpl: f })) === null, "should be null");
});

await check("returns null on a non-ok HTTP response", async () => {
  const f = fakeFetch({ status: "success", data: { screenshot: { url: "https://x/y.png" } } }, false);
  assert((await captureSiteScreenshot("https://x.com", { fetchImpl: f })) === null, "non-ok → null");
});

await check("returns null when fetch throws (network/timeout)", async () => {
  const f = (async () => { throw new Error("timeout"); }) as unknown as typeof fetch;
  assert((await captureSiteScreenshot("https://x.com", { fetchImpl: f })) === null, "throw → null");
});

await check("returns null for a non-http url", async () => {
  assert((await captureSiteScreenshot("ftp://x", { fetchImpl: fakeFetch({}) })) === null, "non-http → null");
});

// ── parseDesignLanguage ──────────────────────────────────────────────────────
await check("parses a clean JSON object", () => {
  const dl = parseDesignLanguage('{"ethos":"calm fintech","typography":"high contrast, light weights","layout":"split, airy","shape":"rounded, soft shadows","imagery":"flat illustration","mood":["calm","precise","modern"]}');
  assert(dl !== null && dl.ethos === "calm fintech", `ethos: ${dl?.ethos}`);
  assert(dl!.mood.length === 3, `mood: ${JSON.stringify(dl!.mood)}`);
});

await check("tolerates code fences / surrounding prose", () => {
  const dl = parseDesignLanguage('Here you go:\n```json\n{"ethos":"bold","layout":"grid"}\n```\nthanks');
  assert(dl !== null && dl.ethos === "bold" && dl.layout === "grid", `got ${JSON.stringify(dl)}`);
});

await check("null when no substantive dimension is present", () => {
  assert(parseDesignLanguage('{"shape":"rounded"}') === null, "shape-only → null (needs ethos/typography/layout)");
  assert(parseDesignLanguage("not json at all") === null, "garbage → null");
});

await check("coerces a non-array mood + caps long strings", () => {
  const dl = parseDesignLanguage(`{"ethos":"${"x".repeat(400)}","layout":"y","mood":"nope"}`);
  assert(dl !== null && dl.ethos.length <= 240, `ethos should be capped, got ${dl?.ethos.length}`);
  assert(Array.isArray(dl!.mood) && dl!.mood.length === 0, "non-array mood → []");
});

// ── analyzeDesignLanguage (injected client) ──────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeClient = (text: string): any =>
  ({ messages: { create: async () => ({ content: [{ type: "text", text }] }) } });

await check("analyzes a vision-safe image via the injected client", async () => {
  const dl = await analyzeDesignLanguage("https://x.com/shot.png", {
    client: fakeClient('{"ethos":"editorial","typography":"serif display, tight","layout":"centered"}'),
  });
  assert(dl !== null && dl.ethos === "editorial", `got ${JSON.stringify(dl)}`);
});

await check("returns null for a non-vision-safe image URL (no client call)", async () => {
  let called = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c: any = { messages: { create: async () => { called = true; return { content: [] }; } } };
  const dl = await analyzeDesignLanguage("https://x.com/page.svg", { client: c });
  assert(dl === null && called === false, "svg is not vision-safe → null, no call");
});

// ── formatDesignLanguage ─────────────────────────────────────────────────────
await check("renders only the present rows, skips empties", () => {
  const out = formatDesignLanguage({ ethos: "calm", typography: "", layout: "split", shape: "", imagery: "", mood: ["a", "b"] });
  assert(/Design ethos: calm/.test(out), "ethos row");
  assert(/Layout \/ composition: split/.test(out), "layout row");
  assert(/Mood: a, b/.test(out), "mood row");
  assert(!/Type treatment/.test(out), "empty typography row should be skipped");
});

await check("empty / undefined design language → empty string", () => {
  assert(formatDesignLanguage(undefined) === "", "undefined → ''");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
