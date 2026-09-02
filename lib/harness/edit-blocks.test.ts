import { strict as assert } from "assert";
import { applyEditBlocks, parseEditBlocks } from "./edit-blocks";

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void) => tests.push([name, fn]);

const FILE = `const PALETTE = { accent: "#c6613f", canvas: "#fcf8f7" };
const FONT_DISPLAY = '"Anthropic Sans", sans-serif';

export const Section0 = () => (
  <div style={{ background: PALETTE.canvas }}>
    <Piece id="s0.p1" kind="text">hello</Piece>
  </div>
);

export const Section1 = () => (
  <div style={{ background: PALETTE.canvas }}>
    <Piece id="s1.p1" kind="text">world</Piece>
  </div>
);`;

const wrap = (inner: string) => `Here are the fixes:\n\n\`\`\`tsx\n${inner}\n\`\`\`\nDone.`;

test("parses one block, prose- and fence-wrapped", () => {
  const b = parseEditBlocks(wrap(`<<<<<<< SEARCH\n    <Piece id="s0.p1" kind="text">hello</Piece>\n=======\n    <Piece id="s0.p1" kind="text">hi</Piece>\n>>>>>>> REPLACE`));
  assert.equal(b?.length, 1);
  assert.ok(b![0].search.includes('id="s0.p1"'));
});

test("parses multiple blocks in order", () => {
  const b = parseEditBlocks(`<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\nmid prose\n<<<<<<< SEARCH\nc\n=======\nd\n>>>>>>> REPLACE`);
  assert.equal(b?.length, 2);
  assert.deepEqual(b![1], { search: "c", replace: "d" });
});

test("malformed structure returns null (never partial)", () => {
  assert.equal(parseEditBlocks("<<<<<<< SEARCH\nx\n======="), null); // never closed
  assert.equal(parseEditBlocks("<<<<<<< SEARCH\nx\n<<<<<<< SEARCH\ny\n=======\nz\n>>>>>>> REPLACE"), null); // nested
  assert.equal(parseEditBlocks("no blocks at all"), null);
  assert.equal(parseEditBlocks("<<<<<<< SEARCH\n   \n=======\nz\n>>>>>>> REPLACE"), null); // empty anchor
});

test("applies a unique exact match", () => {
  const r = applyEditBlocks(FILE, [{ search: '    <Piece id="s0.p1" kind="text">hello</Piece>', replace: '    <Piece id="s0.p1" kind="text">hi</Piece>' }]);
  assert.ok(r.ok);
  if (r.ok) {
    assert.ok(r.code.includes(">hi<"));
    assert.ok(!r.code.includes(">hello<"));
    assert.ok(r.code.includes(">world<"), "untouched content untouched");
  }
});

test("ambiguous SEARCH refuses (the corruption guard)", () => {
  const r = applyEditBlocks(FILE, [{ search: "  <div style={{ background: PALETTE.canvas }}>", replace: "  <div>" }]);
  assert.ok(!r.ok);
  if (!r.ok) assert.match(r.reason, /2 places/);
});

test("missing SEARCH refuses; nothing else applied (all-or-nothing)", () => {
  const r = applyEditBlocks(FILE, [
    { search: 'id="s0.p1"', replace: 'id="s0.px"' },
    { search: "NOT IN THE FILE", replace: "whatever" },
  ]);
  assert.ok(!r.ok);
});

test("sequential blocks see earlier edits", () => {
  const pad = "// context\n".repeat(30);
  const r = applyEditBlocks(`${pad}aaa-TARGET-zzz\n${pad}`, [
    { search: "TARGET", replace: "MID" },
    { search: "aaa-MID-zzz", replace: "aaa-done-zzz" },
  ]);
  assert.ok(r.ok);
  if (r.ok) assert.ok(r.code.includes("aaa-done-zzz"));
});

test("deletion via empty replace works", () => {
  const pad = "// context\n".repeat(30);
  const r = applyEditBlocks(`${pad}keep\nDELETE ME\nkeep2\n${pad}`, [{ search: "DELETE ME\n", replace: "" }]);
  assert.ok(r.ok);
  if (r.ok) {
    assert.ok(!r.code.includes("DELETE ME"));
    assert.ok(r.code.includes("keep\nkeep2"));
  }
});

test("an edit set that guts the file is refused", () => {
  const r = applyEditBlocks(FILE, [{ search: FILE, replace: "tiny" }]);
  assert.ok(!r.ok);
});

test("$-sequences in replacement are literal (no replace-pattern injection)", () => {
  const r = applyEditBlocks("price: X", [{ search: "X", replace: "$100 & more $'" }]);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.code, "price: $100 & more $'");
});

let pass = 0;
let fail = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    pass++;
  } catch (err) {
    console.error(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`);
    fail++;
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
