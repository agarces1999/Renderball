import { strict as assert } from "assert";
import { promptDigest } from "./safe-truncate";

/**
 * These assertions are worth ten minutes each, literally: a mid-token cut in a
 * create-element prompt hangs the Fireworks router forever, and the caller
 * burns its whole timeout plus retry ladder before giving up. Proven by curl
 * bisection on 2026-08-04 — same text, boundary-cut, answers in ~1s.
 */
const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void) => tests.push([name, fn]);

test("never ends mid-token — the property the whole file exists for", () => {
  // The exact shape that hung: JSX cut inside an attribute name.
  const jsx = `<div style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)", textAlign: "center", color: PALETTE.muted, fontFamily: FONT_MONO, fontSize: 28 }}>`;
  const out = promptDigest(jsx, 150);
  assert(out.endsWith(" …"), `must mark the cut: ${JSON.stringify(out.slice(-20))}`);
  const body = out.slice(0, -2).trimEnd();
  // The last thing before the ellipsis is a complete whitespace-delimited
  // token from the source, not a fragment of one.
  const lastToken = body.split(" ").pop() ?? "";
  assert(jsx.split(/\s+/).includes(lastToken), `"${lastToken}" is a fragment, not a whole token`);
});

test("short text passes through untouched, with no ellipsis", () => {
  assert.equal(promptDigest("a small caption", 150), "a small caption");
});

test("whitespace collapses so a prompt line stays one line", () => {
  assert.equal(promptDigest("a\n  b\t c", 150), "a b c");
});

test("a single enormous token still yields something usable", () => {
  const blob = "x".repeat(400);
  const out = promptDigest(blob, 150);
  assert(out.length <= 152, `stays bounded: ${out.length}`);
  assert(out.endsWith(" …"), "still marks the cut");
});

test("null and undefined are text-shaped, not crashes", () => {
  assert.equal(promptDigest(undefined as unknown as string), "");
  assert.equal(promptDigest(null as unknown as string), "");
});

test("the cut respects the caller's max", () => {
  const words = Array.from({ length: 300 }, (_, i) => `word${i}`).join(" ");
  assert(promptDigest(words, 600).length <= 602, "600-char callers (cast-build) stay bounded");
  assert(promptDigest(words, 150).length <= 152, "150-char callers (sibling context) stay bounded");
});

let pass = 0;
let fail = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    pass++;
  } catch (e) {
    console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`);
    fail++;
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
