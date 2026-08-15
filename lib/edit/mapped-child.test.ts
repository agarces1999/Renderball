/**
 * Deleting one item of a MAPPED list. The founder hit this live: selecting a
 * product card and pressing Delete failed with `piece "s2.products.0" not
 * found in scene 2`, because the id exists only after the template evaluates.
 */
import { findMappedChildInScene, dropMappedIndex } from "./nested-piece";
import type { DecomposedScene } from "../agents/lego-decompose";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

const sceneWith = (body: string): DecomposedScene =>
  ({ sceneIndex: 2, pieces: [{ id: "s2.list", kind: "diegetic", body, openTag: "", file: "" }] }) as unknown as DecomposedScene;

const LIST = `<div className="stack">
  {PRODUCTS.map((item, i) => (
    <Piece id={\`s2.products.\${i}\`} key={i} kind="card">
      <Row label={item.label} />
    </Piece>
  ))}
</div>`;

console.log("mapped-child delete (list items are data, not blocks)");

check("resolves a mapped item the literal lookup cannot see", () => {
  const found = findMappedChildInScene(sceneWith(LIST), "s2.products.0");
  assert(!!found, "s2.products.0 must resolve");
  assert(found!.index === 0, `index 0, got ${found!.index}`);
  assert(LIST.slice(found!.mapAt).startsWith(".map("), "mapAt points at the .map( call");
});

check("filters the DATA, keeping the template intact", () => {
  const found = findMappedChildInScene(sceneWith(LIST), "s2.products.2")!;
  const out = dropMappedIndex(LIST, found.mapAt, found.index);
  assert(out.includes("PRODUCTS.filter((_rbItem, _rbIdx) => _rbIdx !== 2).map("), `filter inserted, got: ${out.slice(0, 120)}`);
  // The <Piece> template — the thing that renders EVERY item — must survive.
  assert(out.includes("<Piece id={`s2.products.${i}`}"), "the template block is untouched");
  assert((out.match(/<Piece /g) ?? []).length === 1, "no block was removed");
});

check("a second delete composes onto the first (indices follow what is rendered)", () => {
  const f1 = findMappedChildInScene(sceneWith(LIST), "s2.products.0")!;
  const once = dropMappedIndex(LIST, f1.mapAt, f1.index);
  const f2 = findMappedChildInScene(sceneWith(once), "s2.products.1")!;
  const twice = dropMappedIndex(once, f2.mapAt, f2.index);
  // The SECOND filter must run on the output of the first — i.e. sit closest
  // to .map( — so "the second one I can see" is what disappears.
  const iFirst = twice.indexOf("_rbIdx !== 0");
  const iSecond = twice.indexOf("_rbIdx !== 1");
  assert(iFirst >= 0 && iSecond > iFirst, "filters chain in application order");
  assert(twice.indexOf(".map(") > iSecond, "both filters precede .map(");
});

check("ignores ids that are not mapped items", () => {
  assert(findMappedChildInScene(sceneWith(LIST), "s2.list") === null, "a plain id does not resolve");
  assert(findMappedChildInScene(sceneWith(LIST), "s2.other.0") === null, "a different family does not resolve");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
