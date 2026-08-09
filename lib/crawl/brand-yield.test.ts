/**
 * The product must not claim brand work it did not do.
 *
 * Three shipped defects are locked here, all from the same root: a
 * full-looking BrandIdentity is returned no matter how little evidence went
 * in, and every consumer read that shape as proof.
 *
 *  1. The no-role font fallbacks omitted their CSS generic, so the design
 *     prompt emitted `const FONT_DISPLAY = '"Inter", undefined';` under a
 *     "use VERBATIM" header. Shipped in deck 01KY7ZGC4MVDD5J1DSB35GAW5T.
 *  2. With only a bare URL (the normal state since the pivot moved the front
 *     door to /api/documents/new, which never crawls) the LOCKED brand-identity
 *     block was emitted anyway, instructing a wordmark of the literal "Brand".
 *  3. `BrandExtract.ok` means the fetch returned, not that a brand came back.
 *
 * Run: `node scripts/run-tests.mjs lib/crawl/brand-yield.test.ts`.
 * Deterministic — no network, no model calls.
 */
import {
  resolveBrandIdentity,
  brandExtractYield,
  fontStackFor,
} from "./brand-identity";
import { buildAgentInputFromBrief, buildScaffoldUserMessage } from "../agents/pipeline";
import type { Script } from "../../src/schema";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
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

// ── A real CSS font-family grammar check ────────────────────────────────────
//
// Why this is stricter than "does it parse": measured in Chrome (2026-08-09),
// `el.style.fontFamily = '"Inter", undefined'` is ACCEPTED and reads back as
// `Inter, undefined` — `undefined` is a legal <custom-ident>, so a bare parse
// check passes on the exact bug. What is actually broken is that the last slot
// is no longer a GENERIC family: with the named face unavailable, that stack
// renders at the width of `serif` (449.72px in the probe) instead of
// `sans-serif` (498.16px). So the bar here is the full grammar AND a generic
// terminator — the property the shipped deck violated.
const CSS_GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
]);
// CSS-wide keywords are never valid as a <family-name>.
const CSS_WIDE_KEYWORDS = new Set(["inherit", "initial", "unset", "revert", "revert-layer", "default"]);
const CUSTOM_IDENT = /^-?[A-Za-z_ -￿][A-Za-z0-9_ -￿-]*$/;

/** Every comma-separated component is a valid <family-name>. */
const isWellFormedFontList = (value: string): boolean => {
  const parts = value.split(",").map((p) => p.trim());
  if (parts.length === 0 || parts.some((p) => p === "")) return false;
  return parts.every((p) => {
    if (/^"[^"]+"$/.test(p) || /^'[^']+'$/.test(p)) return true; // <string> family
    const words = p.split(/\s+/);
    return (
      words.every((w) => CUSTOM_IDENT.test(w)) &&
      !words.some((w) => CSS_WIDE_KEYWORDS.has(w.toLowerCase()))
    );
  });
};

/** …and the stack ENDS in a real generic family, so an unloadable face still
 *  lands on the right kind of type. This is what `undefined` was occupying. */
const endsInGenericFamily = (value: string): boolean => {
  const parts = value.split(",").map((p) => p.trim());
  return CSS_GENERIC_FAMILIES.has(parts[parts.length - 1] ?? "");
};

const assertUsableFontStack = (label: string, value: string) => {
  assert(isWellFormedFontList(value), `${label}: not a well-formed font list — ${JSON.stringify(value)}`);
  assert(
    endsInGenericFamily(value),
    `${label}: no CSS generic family in the last slot — ${JSON.stringify(value)} (an unloadable named face falls to the UA default)`,
  );
};

// The validator itself must be able to say no, or it proves nothing.
check("validator rejects the exact string that shipped", () => {
  assert(
    isWellFormedFontList('"Inter", undefined'),
    "sanity: the shipped string IS well-formed CSS — that is why a parse check missed it",
  );
  assert(!endsInGenericFamily('"Inter", undefined'), "validator accepted `undefined` as a generic family");
  assert(!isWellFormedFontList('"Inter", '), "validator accepted an empty trailing slot");
  assert(!isWellFormedFontList('"Inter", 1px'), "validator accepted a non-ident component");
  assert(!isWellFormedFontList('"Inter", inherit'), "validator accepted a CSS-wide keyword as a family");
  assert(endsInGenericFamily('"Inter", sans-serif'), "validator rejected a correct stack");
  assert(endsInGenericFamily('"HubSpot Serif", serif'), "validator rejected a correct serif stack");
});

// ── 1. The font stack the agent is told to copy verbatim ────────────────────

check("no font roles at all → display/body stacks are still usable CSS", () => {
  // The shipped case: an extract with a palette but an empty font list, so no
  // role classifies and both display and body take the no-role fallback.
  const id = resolveBrandIdentity({ url: "https://acme.com", palette: ["#0078a8"] });
  assertUsableFontStack("FONT_DISPLAY", fontStackFor(id.fonts.display));
  assertUsableFontStack("FONT_BODY", fontStackFor(id.fonts.body));
  assert(id.fonts.display.generic === "sans-serif", `display generic: ${id.fonts.display.generic}`);
  assert(id.fonts.body.generic === "sans-serif", `body generic: ${id.fonts.body.generic}`);
});

check("no extract at all → display/body stacks are still usable CSS", () => {
  const id = resolveBrandIdentity(undefined);
  assertUsableFontStack("FONT_DISPLAY", fontStackFor(id.fonts.display));
  assertUsableFontStack("FONT_BODY", fontStackFor(id.fonts.body));
});

check("a real brand face keeps its style-matched generic", () => {
  const id = resolveBrandIdentity({
    url: "https://acme.com",
    fonts: [{ family: "Fraunces", src: "https://acme.com/fraunces.woff2", weight: "400" }],
    font_roles: { display: "Fraunces", body: "Fraunces" },
  });
  assertUsableFontStack("FONT_DISPLAY", fontStackFor(id.fonts.display));
  assert(id.fonts.display.generic === "serif", `a serif face must stay serif, got ${id.fonts.display.generic}`);
  assert(id.fonts.display.fallback === false, "a loadable brand face is not a fallback");
});

check("fontStackFor never emits `undefined` even for a role missing its generic", () => {
  // Belt and braces at the emission site: the string is copied verbatim into
  // the deck, so this function must be total.
  const stack = fontStackFor({ family: "Neue Montreal" } as { family: string; generic?: string });
  assertUsableFontStack("hand-built role", stack);
});

// ── The prompt line the model actually copies ───────────────────────────────

const SCRIPT: Script = {
  id: "01TEST",
  brief: { purpose: "test", cta: "Start" },
  scenes: [
    {
      label: "Opening",
      description: "the opening",
      start_seconds: 0,
      end_seconds: 5,
      content: { headline: "Hello" },
    },
    {
      label: "Close",
      description: "the close",
      start_seconds: 5,
      end_seconds: 10,
      content: { headline: "Bye" },
    },
  ],
  assets: { images: [], fonts: [] },
  config: { duration_seconds: 10, aspect_ratio: "16:9" },
  brand_kit_id: null,
} as unknown as Script;

/** Pull the `const FONT_X = '...'` lines the prompt tells the agent to copy. */
const fontConstsIn = (prompt: string): Array<{ name: string; stack: string }> =>
  [...prompt.matchAll(/const (FONT_[A-Z]+) = '([^']*)'/g)].map((m) => ({
    name: m[1],
    stack: m[2],
  }));

check("the emitted prompt never carries a broken font stack", () => {
  const input = buildAgentInputFromBrief({
    brand_kit_url: "https://acme.com",
    brand_extract: {
      url: "https://acme.com",
      title: "Acme",
      palette: ["#0078a8", "#1a2332"],
      fonts: [], // no @font-face survived — the shipped deck's exact shape
      ok: true,
      fetched_at: new Date().toISOString(),
    },
  }, SCRIPT);
  const prompt = buildScaffoldUserMessage(input);
  const consts = fontConstsIn(prompt);
  assert(consts.length >= 2, `expected FONT_* constants in the prompt, found ${consts.length}`);
  // Scoped to the brand block on purpose: the design-constraints section
  // legitimately says "undefined components crash", so a whole-prompt scan
  // would fail for the wrong reason and teach the next person to delete it.
  const brandBlock = prompt.slice(prompt.indexOf("## Brand context"), prompt.indexOf("## CON"));
  assert(brandBlock.length > 0, "no brand block in the prompt");
  assert(!/undefined/.test(brandBlock), `brand block carries the literal token \`undefined\`:\n${brandBlock}`);
  for (const c of consts) assertUsableFontStack(c.name, c.stack);
});

// ── 2. The LOCKED block, and the wordmark "Brand" ───────────────────────────

check("bare URL, no crawl → no LOCKED identity block is emitted", () => {
  const input = buildAgentInputFromBrief({ brand_kit_url: "https://stripe.com" }, SCRIPT);
  const prompt = buildScaffoldUserMessage(input);
  assert(
    !/LOCKED brand identity/.test(prompt),
    "a LOCKED identity was asserted for a brand nothing was read from",
  );
  assert(
    /NO BRAND IDENTITY WAS EXTRACTED/.test(prompt),
    "the absence was not stated — silence still makes the agent invent a mark",
  );
});

check("bare URL → the agent is never told to letter the word \"Brand\"", () => {
  for (const url of ["https://stripe.com", "https://acme.co.uk", "notaurl"]) {
    const input = buildAgentInputFromBrief({ brand_kit_url: url }, SCRIPT);
    const prompt = buildScaffoldUserMessage(input);
    assert(
      !/WORDMARK as styled text: "Brand"/.test(prompt),
      `${url}: the prompt instructs the literal wordmark "Brand"`,
    );
  }
});

check("bare URL → the hostname becomes the name, because the user gave us it", () => {
  const input = buildAgentInputFromBrief({ brand_kit_url: "https://stripe.com/pricing" }, SCRIPT);
  assert(
    input.brand_identity?.wordmark.text === "Stripe",
    `expected "Stripe", got ${JSON.stringify(input.brand_identity?.wordmark.text)}`,
  );
  assert(input.brand_identity?.wordmark.placeholder === false, "a hostname-derived name is not a placeholder");
  assert(/NAME "Stripe"/.test(buildScaffoldUserMessage(input)), "the one real fact was not passed through");
});

check("nothing at all — no URL, no extract → wordmark is flagged a placeholder", () => {
  const id = resolveBrandIdentity({});
  assert(id.wordmark.placeholder === true, "the \"Brand\" last resort must be flagged");
  assert(id.yield.name === false, "yield.name must be false when no name was observed");
});

check("a user-uploaded logo still earns the LOCKED block", () => {
  // No palette, no fonts, no title — but the user's own file is real brand
  // evidence and must not be swept into the "nothing was extracted" branch.
  const input = buildAgentInputFromBrief({
    brand_kit_url: "https://acme.com",
    brand_files: [
      { name: "logo.png", url: "https://cdn.example.com/logo.png", mime: "image/png", is_logo: true },
    ],
  }, SCRIPT);
  const prompt = buildScaffoldUserMessage(input);
  assert(/LOCKED brand identity/.test(prompt), "an uploaded logo lost its LOCKED block");
  assert(/logo\.png/.test(prompt), "the uploaded logo URL never reached the prompt");
});

check("a real crawl still gets the LOCKED block (the fix is not a blanket mute)", () => {
  const input = buildAgentInputFromBrief({
    brand_kit_url: "https://acme.com",
    brand_extract: {
      url: "https://acme.com",
      title: "Acme",
      palette: ["#0078a8", "#1a2332"],
      ok: true,
      fetched_at: new Date().toISOString(),
    },
  }, SCRIPT);
  const prompt = buildScaffoldUserMessage(input);
  assert(/LOCKED brand identity/.test(prompt), "a brand with a real signature colour lost its LOCKED block");
  assert(!/NO BRAND IDENTITY WAS EXTRACTED/.test(prompt), "a real brand was described as unextracted");
});

// ── 3. Yield: `ok` is a transport fact, not a content fact ──────────────────

check("ok:true with an all-grey palette and no fonts → NOT loaded", () => {
  // A Webflow-boilerplate crawl: it returned, it parsed, it yielded nothing.
  const y = brandExtractYield({
    url: "https://corgi.example",
    title: "Corgi",
    palette: ["#f6f6f6", "#e8e8e8", "#c7c7c7", "#6b6b6b", "#1c1c1e"],
    fonts: [],
    ok: true,
  });
  assert(y.color === false, "greys must not count as a brand colour");
  assert(y.font === false, "a curated fallback must not count as a brand font");
  assert(y.loaded === false, "an extract that yielded nothing reported as loaded");
});

check("ok:true with an EMPTY palette → NOT loaded", () => {
  const y = brandExtractYield({ url: "https://acme.com", title: "Acme", palette: [], ok: true });
  assert(y.loaded === false, "an empty palette reported as a loaded brand");
  assert(y.name === true, "the name was still observed (hostname) even with no palette");
});

check("a chromatic palette alone clears the bar", () => {
  const y = brandExtractYield({ url: "https://stripe.com", palette: ["#635bff", "#0a2540"], ok: true });
  assert(y.color === true, "#635bff is a brand colour");
  assert(y.loaded === true, "colour alone should clear the bar");
});

check("a real brand FONT alone clears the bar, with no colour at all", () => {
  const y = brandExtractYield({
    url: "https://mono.example",
    palette: ["#ffffff", "#000000"],
    fonts: [{ family: "Fraunces", src: "https://mono.example/f.woff2", weight: "400" }],
    font_roles: { display: "Fraunces" },
    ok: true,
  });
  assert(y.color === false, "black and white are not a brand colour");
  assert(y.font === true, "a loadable @font-face family is a brand font");
  assert(y.loaded === true, "font alone should clear the bar");
});

check("a LOGO alone does not clear the bar — the look is colour and type", () => {
  const y = brandExtractYield({
    url: "https://acme.com",
    logo_hd: "https://acme.com/logo.png",
    logo_confidence: 0.9,
    palette: [],
    ok: true,
  });
  assert(y.logo === true, "the logo was not seen");
  assert(y.loaded === false, "a logo alone reported as a loaded brand");
});

check("ok:false yields nothing, whatever else the object carries", () => {
  const y = brandExtractYield({
    url: "https://down.example",
    palette: ["#635bff"], // stale fields from a previous attempt must not count
    ok: false,
  });
  assert(y.loaded === false && y.color === false, `a failed crawl reported yield: ${JSON.stringify(y)}`);
});

check("undefined extract yields nothing", () => {
  assert(brandExtractYield(undefined).loaded === false, "undefined reported as loaded");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
