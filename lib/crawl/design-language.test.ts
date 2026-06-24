/**
 * Tests for the design-language crawl pass (screenshot + vision analysis) and
 * the crawl-phase onUsage collectors (design-language, vision-brand palette,
 * logo agent) that feed cost accounting.
 * Run: `npm test`. No network, no API key — fetch + the Anthropic client are
 * injected.
 */
import {
  captureSiteScreenshot,
  parseDesignLanguage,
  analyzeDesignLanguage,
  extractDesignLanguage,
  formatDesignLanguage,
} from "./design-language";
import { findBrandLogo } from "./find-logo-agent";
import { VISION_MODEL } from "../anthropic";
import type { Usage } from "../usage";

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
// Fake responses carry a usage object (like the real SDK) so the onUsage
// collector tests below see plausible token counts.
const FAKE_USAGE = {
  input_tokens: 1200,
  output_tokens: 80,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};
// Native vision-call fake — returns the GLM-5V-Turbo shape ({ text, usage }).
const fakeVision = (text: string) => async () => ({ text, usage: FAKE_USAGE });

await check("analyzes a vision-safe image via the injected vision call", async () => {
  const dl = await analyzeDesignLanguage("https://x.com/shot.png", {
    visionCall: fakeVision('{"ethos":"editorial","typography":"serif display, tight","layout":"centered"}'),
  });
  assert(dl !== null && dl.ethos === "editorial", `got ${JSON.stringify(dl)}`);
});

await check("returns null for a non-vision-safe image URL (no vision call)", async () => {
  let called = false;
  const dl = await analyzeDesignLanguage("https://x.com/page.svg", {
    visionCall: async () => { called = true; return { text: "", usage: FAKE_USAGE }; },
  });
  assert(dl === null && called === false, "svg is not vision-safe → null, no call");
});

// ── onUsage collector (crawl cost accounting) ────────────────────────────────
// Each crawl-phase model call must surface its token usage to the caller so
// .data/usage.jsonl stops understating build cost. The collector fires once
// per completed API call with the resolved model — and never when the call is
// skipped (non-vision-safe image → zero usage, the logo-cache-hit property).
const collectUsage = (): { calls: { model: string; usage: Usage }[]; onUsage: (model: string, usage: Usage) => void } => {
  const calls: { model: string; usage: Usage }[] = [];
  return { calls, onUsage: (model, usage) => calls.push({ model, usage }) };
};

await check("analyzeDesignLanguage reports its model + usage to the collector", async () => {
  const { calls, onUsage } = collectUsage();
  const dl = await analyzeDesignLanguage("https://x.com/shot.png", {
    visionCall: fakeVision('{"ethos":"editorial","typography":"serif","layout":"centered"}'),
    onUsage,
  });
  assert(dl !== null, "analysis should still succeed");
  assert(calls.length === 1, `expected 1 usage call, got ${calls.length}`);
  assert(calls[0].model === VISION_MODEL, `model: ${calls[0].model}`);
  assert(calls[0].usage.input_tokens === 1200 && calls[0].usage.output_tokens === 80,
    `usage: ${JSON.stringify(calls[0].usage)}`);
});

await check("analyzeDesignLanguage: skipped image → collector never fires", async () => {
  const { calls, onUsage } = collectUsage();
  await analyzeDesignLanguage("https://x.com/page.svg", { visionCall: fakeVision("{}"), onUsage });
  assert(calls.length === 0, `no call → no usage, got ${calls.length}`);
});

await check("extractDesignLanguage threads the collector end-to-end", async () => {
  const { calls, onUsage } = collectUsage();
  const f = fakeFetch({ status: "success", data: { screenshot: { url: "https://cdn.microlink.io/shot.png" } } });
  const out = await extractDesignLanguage("https://corgi.insure", undefined, {
    fetchImpl: f,
    visionCall: fakeVision('{"ethos":"playful","typography":"chunky","layout":"grid"}'),
    onUsage,
  });
  assert(out.design_language?.ethos === "playful", `got ${JSON.stringify(out)}`);
  assert(calls.length === 1 && calls[0].model === VISION_MODEL,
    `expected 1 designLanguage call, got ${JSON.stringify(calls.map((c) => c.model))}`);
});

await check("findBrandLogo reports its model + usage to the collector", async () => {
  const { calls, onUsage } = collectUsage();
  // data: candidate → no HEAD probe, no network; the fake agent picks it by index.
  const result = await findBrandLogo(
    "corgi.insure",
    "Corgi",
    [{ url: "data:image/svg+xml;base64,bm90LXJlYWwtc3Zn", source: "inline-svg" }],
    {
      visionCall: async () => ({
        text: '{"chosen_index":1,"rationale":"the nav wordmark"}',
        usage: FAKE_USAGE,
      }),
      onUsage,
    },
  );
  assert(result.ok === true, `expected ok, got ${JSON.stringify(result)}`);
  assert(calls.length === 1, `expected 1 usage call (single round), got ${calls.length}`);
  assert(calls[0].model === VISION_MODEL, `model: ${calls[0].model}`);
  assert(calls[0].usage.output_tokens === 80, `usage: ${JSON.stringify(calls[0].usage)}`);
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
