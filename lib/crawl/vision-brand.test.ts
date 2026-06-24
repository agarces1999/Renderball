/**
 * Tests for the vision-brand color-role extraction. The load-bearing check:
 * extractBrandColorRoles parses the vision response into discrete roles, with
 * the page CANVAS background kept distinct from the signature accent — so the
 * canvas color can become a hard constraint downstream instead of being lost in
 * a flat palette. The Anthropic client is injected; no key, no network.
 *
 * Run: `npm test`.
 */
import { extractBrandColorRoles, snapHexToPixels } from "./vision-brand";

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

const FAKE_USAGE = {
  input_tokens: 1200,
  output_tokens: 40,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};
// Inject the vision CALL (native GLM-5V-Turbo in prod) — returns canned text.
const fakeVision = (text: string) => async () => ({ text, usage: FAKE_USAGE });

const IMG = "https://x.com/hero.png";

await check("parses a clean roles object (background distinct from accent)", async () => {
  const roles = await extractBrandColorRoles(IMG, {
    visionCall: fakeVision(
      '{"background":"#440b12","text":"#ffffff","accent":"#ec6839","supporting":["#f4e9df"]}',
    ),
  });
  assert(roles.background === "#440b12", `background: ${roles.background}`);
  assert(roles.text === "#ffffff", `text: ${roles.text}`);
  assert(roles.accent === "#ec6839", `accent: ${roles.accent}`);
  assert(
    roles.accent !== roles.background,
    "canvas background must not be conflated with the signature accent",
  );
  assert(
    roles.supporting.length === 1 && roles.supporting[0] === "#f4e9df",
    `supporting: ${JSON.stringify(roles.supporting)}`,
  );
});

await check("tolerates prose / markdown fences around the JSON object", async () => {
  const roles = await extractBrandColorRoles(IMG, {
    visionCall: fakeVision(
      'Here are the colors:\n```json\n{"background":"#1A1A2E","accent":"#E94560"}\n```\nThat\'s it.',
    ),
  });
  assert(roles.background === "#1a1a2e", `background (lowercased): ${roles.background}`);
  assert(roles.accent === "#e94560", `accent: ${roles.accent}`);
  assert(roles.supporting.length === 0, "no supporting key → empty array");
});

await check("omits roles it can't identify; never throws on a partial object", async () => {
  const roles = await extractBrandColorRoles(IMG, {
    visionCall: fakeVision('{"background":"#0d1b2a"}'),
  });
  assert(roles.background === "#0d1b2a", `background: ${roles.background}`);
  assert(roles.accent === undefined && roles.text === undefined, "absent roles stay undefined");
  assert(Array.isArray(roles.supporting) && roles.supporting.length === 0, "supporting defaults to []");
});

await check("unparseable response degrades to {supporting:[]}", async () => {
  const roles = await extractBrandColorRoles(IMG, {
    visionCall: fakeVision("sorry, I can't read this image"),
  });
  assert(roles.background === undefined, "no hex → no background");
  assert(roles.supporting.length === 0, "best-effort empty roles");
});

await check("non-vision-safe URL → empty roles, no vision call", async () => {
  let called = false;
  const roles = await extractBrandColorRoles("https://x.com/page.svg", {
    visionCall: async () => {
      called = true;
      return { text: "", usage: FAKE_USAGE };
    },
  });
  assert(roles.supporting.length === 0 && called === false, "svg is not vision-safe → no call");
});

// ── snapHexToPixels ──────────────────────────────────────────────────
await check("snapHexToPixels corrects a near hand-estimated hex onto its cluster", () => {
  // Vision estimated #3d1625; the real homepage cluster is #440b12 (within snap).
  const snapped = snapHexToPixels("#3d1625", ["#440b12", "#ec6839", "#ffffff"]);
  assert(snapped === "#440b12", `snapped to nearest cluster: ${snapped}`);
});

await check("snapHexToPixels keeps the vision value when no cluster is close", () => {
  // A small accent pixels never captured → no nearby cluster → keep as-is.
  const kept = snapHexToPixels("#ec6839", ["#440b12", "#ffffff"]);
  assert(kept === "#ec6839", `kept vision value: ${kept}`);
});

await check("snapHexToPixels with an empty pixel palette is a no-op", () => {
  assert(snapHexToPixels("#440b12", []) === "#440b12", "no pixels → unchanged");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
