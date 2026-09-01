import { strict as assert } from "assert";
import { SectionWatcher, finalSigs, sectionSig, splitSections } from "./stream-sections";

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

const DECK = `import React from "react";
import { Piece } from "./Piece";

const PALETTE = { accent: "#e61e4d", canvas: "#ffffff" };
const FONT_BODY = '"Inter", sans-serif';
const Chrome: React.FC<{ page: number }> = ({ page }) => <div>{page}</div>;

export const Section0: React.FC<{ script?: unknown }> = () => (
  <div style={{ background: PALETTE.canvas }}>
    <Piece id="s0.p1" kind="text">one</Piece>
    <Chrome page={1} />
  </div>
);

export const Section1: React.FC<{ script?: unknown }> = () => (
  <div style={{ fontFamily: FONT_BODY }}>
    <Piece id="s1.p1" kind="text">two</Piece>
  </div>
);

export const Section2: React.FC<{ script?: unknown }> = () => (
  <div>
    <Piece id="s2.p1" kind="text">three</Piece>
  </div>
);`;

const STREAM = `Here is the deck you asked for.

\`\`\`tsx
${DECK}
\`\`\`

Done.`;

test("splitSections recovers preamble + every section", () => {
  const { preamble, sections } = splitSections(DECK);
  assert.ok(preamble.includes("const PALETTE"));
  assert.ok(!preamble.includes("Section0"));
  assert.equal(sections.size, 3);
  assert.ok(sections.get(1)!.startsWith("export const Section1"));
  assert.ok(!sections.get(1)!.includes("Section2"));
});

test("THE JOIN INVARIANT: prefix-derived sig === full-file-derived sig, every page", () => {
  const full = finalSigs(DECK, 3);
  const { sections } = splitSections(DECK);
  for (let k = 0; k < 3; k++) {
    // The prefix a streaming cut would produce: everything up to section k's end.
    const cutAt = k + 1 < 3 ? DECK.indexOf(`export const Section${k + 1}`) : DECK.length;
    const prefix = DECK.slice(0, cutAt).trimEnd();
    const p = splitSections(prefix);
    assert.equal(
      sectionSig(p.preamble, p.sections.get(k)!),
      full[k],
      `page ${k + 1} sig must match across prefix/full derivation`,
    );
  }
});

test("watcher emits each section once, with renderable prefixes, under arbitrary chunking", async () => {
  for (const chunkSize of [1, 7, 50, 5000]) {
    const w = new SectionWatcher();
    const got: number[] = [];
    let acc = "";
    for (let i = 0; i < STREAM.length; i += chunkSize) {
      acc += STREAM.slice(i, i + chunkSize);
      for (const s of w.feed(acc)) {
        got.push(s.index);
        assert.ok(s.prefixCode.startsWith("import React"), "prefix starts at the deck code");
        assert.ok(s.prefixCode.includes(`export const Section${s.index}`));
        assert.ok(!s.prefixCode.includes(`export const Section${s.index + 1}`), "prefix stops before the next section");
      }
    }
    assert.deepEqual(got, [0, 1, 2], `chunkSize=${chunkSize}`);
  }
});

test("sections 0..k-1 complete BEFORE the stream ends (the whole point)", () => {
  const w = new SectionWatcher();
  // Feed only up to the middle of Section2's body — no fence close in sight.
  const partial = STREAM.slice(0, STREAM.indexOf('id="s2.p1"'));
  const got = w.feed(partial).map((s) => s.index);
  assert.deepEqual(got, [0, 1], "pages 1-2 are ready while page 3 is still streaming");
});

test("a decoy fence before the deck fence is ignored", () => {
  const decoy = "Plan:\n```\nnot the deck\n```\n" + STREAM;
  const w = new SectionWatcher();
  const got = w.feed(decoy).map((s) => s.index);
  assert.deepEqual(got, [0, 1, 2]);
});

test("watcher sig equals the final file's sig for every emitted section", () => {
  const w = new SectionWatcher();
  const emitted = w.feed(STREAM);
  const full = finalSigs(DECK, 3);
  for (const s of emitted) assert.equal(s.sig, full[s.index], `page ${s.index + 1}`);
});

test("reset drops emitted state — a retry's stream starts clean", () => {
  const w = new SectionWatcher();
  assert.equal(w.feed(STREAM).length, 3);
  assert.equal(w.feed(STREAM).length, 0, "no re-emission on repeat feeds");
  w.reset();
  assert.equal(w.feed(STREAM).length, 3, "a fresh attempt emits again");
});

test("finalSigs marks missing exports null instead of inventing a sig", () => {
  const sigs = finalSigs(DECK, 5);
  assert.equal(sigs.filter(Boolean).length, 3);
  assert.equal(sigs[3], null);
  assert.equal(sigs[4], null);
});

let pass = 0;
let fail = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    pass++;
  } catch (err) {
    console.error(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`);
    fail++;
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
