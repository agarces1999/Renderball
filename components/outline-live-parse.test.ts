/**
 * The stream parser behind the typing cards: JSON string values pulled from
 * a truncated, escape-laden model stream. The cases that matter are the ones
 * a live stream actually produces — cut mid-string, cut mid-escape, quotes
 * and unicode inside the text, and prose that merely MENTIONS the key.
 */
import { extractStreamStrings, parseOutlineCards } from "./BlankDocumentPanel";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("outline-live parse (typing cards from a raw stream)");

check("complete values extract in order", () => {
  const buf = `{"scenes":[{"id":"scene_0","label":"The abandoned cart","content":{"lede":"A third leave."}},{"id":"scene_1","label":"The turn","content":{"lede":"Conversion, not credit."}}]}`;
  const cards = parseOutlineCards(buf);
  assert(cards.length === 2, `2 cards, got ${cards.length}`);
  assert(cards[0].label === "The abandoned cart" && cards[0].lede === "A third leave.", "card 1");
  assert(cards[1].label === "The turn" && cards[1].lede === "Conversion, not credit.", "card 2");
});

check("a string cut mid-word yields the partial tail (that IS the typing)", () => {
  const buf = `{"scenes":[{"id":"scene_0","label":"The abando`;
  const cards = parseOutlineCards(buf);
  assert(cards.length === 1 && cards[0].label === "The abando", `partial label, got ${JSON.stringify(cards)}`);
});

check("a stream cut mid-escape does not corrupt the text", () => {
  const buf = `{"scenes":[{"label":"Fast \\`;
  const [label] = extractStreamStrings(buf, "label");
  assert(label === "Fast ", `dangling backslash dropped, got ${JSON.stringify(label)}`);
});

check("escaped quotes and unicode decode; newlines become spaces", () => {
  const buf = `{"label":"Say \\"yes\\" \\u2014 now\\nplease"}`;
  const [label] = extractStreamStrings(buf, "label");
  assert(label === 'Say "yes" — now please', `got ${JSON.stringify(label)}`);
});

check("prose mentioning the key inside another string does not create a card", () => {
  // Inside a JSON string, quotes arrive escaped — \"label\" — so the pattern
  // cannot match; the [{,] prefix guards the rest.
  const buf = `{"visual_concept":"A chart whose \\"label\\": text sits on the axis","label":"Real page"}`;
  const labels = extractStreamStrings(buf, "label");
  assert(labels.length === 1 && labels[0] === "Real page", `only the real key, got ${JSON.stringify(labels)}`);
});

check("lede arriving before its label still renders a card (order-independent pairing)", () => {
  const buf = `{"scenes":[{"id":"scene_0","content":{"lede":"First words."}`;
  const cards = parseOutlineCards(buf);
  assert(cards.length === 1 && cards[0].lede === "First words." && cards[0].label === "", "lede-first card");
});

check("nested labels inside content do NOT become phantom pages", () => {
  // KPI tiles carry their own "label" keys; watched live: a 4-page ask
  // rendered 5 cards ("Pilot"/"Quarter"/"Stage" were tile labels).
  const buf = `{"scenes":[{"id":"scene_0","label":"The Quarter in Numbers","content":{"lede":"Real page.","stats":[{"label":"Pilot","value":"1"},{"label":"Quarter","value":"Q3"}]}},{"id":"scene_1","label":"The Ask","content":{"lede":"Intros."}}]}`;
  const cards = parseOutlineCards(buf);
  assert(cards.length === 2, `2 pages, got ${cards.length}: ${JSON.stringify(cards.map((c) => c.label))}`);
  assert(cards[0].label === "The Quarter in Numbers" && cards[1].label === "The Ask", "scene labels only");
});

check("preamble before the first scene id produces no card", () => {
  const buf = `{"config":{"label":"decorative"},"narrative":{"arc":"..."},"scenes":[{"id":"scene_0","label":"Open`;
  const cards = parseOutlineCards(buf);
  assert(cards.length === 1 && cards[0].label === "Open", `got ${JSON.stringify(cards)}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
