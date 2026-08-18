/**
 * The unbound_copy survivor family (root-caused 2026-08-16): case-variant
 * echoes of a scene's eyebrow in captions and chrome. Unit-tests the two new
 * deterministic rungs + the honest detector fields, then REPLAYS the three
 * real stored survivor decks and requires the current engine to leave each
 * one clean.
 */
import { promises as fs } from "fs";
import { existsSync } from "fs";
import { transform } from "esbuild";
import {
  findUnboundCopy,
  bindLiteralCopyInPlace,
  stripChromeEyebrowEchoes,
} from "./quality-gates";

let passed = 0;
let failed = 0;
let skipped = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
// The replay half samples STORED BUILDS under gitignored src/generated —
// present on the long-lived checkout, absent on CI and fresh clones (this
// exact absence turned CI red twice, 2026-08-16, while the unit half was
// green). Absent fixture = unrunnable, not failed: skip LOUDLY, counted,
// same idiom as hero-contrast.test.ts.
const checkWithDeck = async (name: string, deck: string, fn: () => void | Promise<void>) => {
  if (!existsSync(`src/generated/${deck}/Composition.tsx`)) {
    skipped++;
    console.log(`  ↷ ${name}\n      SKIPPED — stored build src/generated/${deck} not on disk`);
    return;
  }
  await check(name, fn);
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const scenesWith = (content: Record<string, unknown>): any => [{ content }];

const run = async () => {
  console.log("unbound-copy repairs (survivor family)");

  await check("transform-normalized rung binds a case-variant under textTransform", () => {
    const code = `const Section0 = () => (<div>
      <span data-content-path="eyebrow">{c.eyebrow}</span>
      <div style={{ textTransform: "uppercase", color: "red" }}>The Reframe</div>
    </div>);`;
    const out = bindLiteralCopyInPlace(code, scenesWith({ eyebrow: "THE REFRAME" }));
    assert(out.code.includes(`textTransform: "uppercase", color: "red" }}>{c.eyebrow}<`), `not bound: ${out.code}`);
    assert(out.bound.length === 1 && out.bound[0].count === 1, "one bind event");
  });

  await check("no normalizing transform → case-variant is LEFT for the model", () => {
    const code = `const Section0 = () => (<div><div style={{ color: "red" }}>The Reframe</div></div>);`;
    const out = bindLiteralCopyInPlace(code, scenesWith({ eyebrow: "THE REFRAME" }));
    assert(out.code === code, "must not touch it — pixels would change");
  });

  await check("chrome-echo strip drops a case-variant category echoing the eyebrow", () => {
    const code = `const Chrome = (p: { category?: string }) => <div>{p.category}</div>;
const Section0 = () => (<div><Chrome category="The Pilot" /></div>);`;
    const out = stripChromeEyebrowEchoes(code, scenesWith({ eyebrow: "THE PILOT" }));
    assert(out.stripped.length === 1, "one strip");
    assert(out.code.includes("<Chrome />"), `prop gone: ${out.code}`);
  });

  await check("a NON-echo category is untouched; without optional decl nothing is stripped", () => {
    const code = `const Chrome = (p: { category?: string }) => <div>{p.category}</div>;
const Section0 = () => (<div><Chrome category="Q3 2025 Review" /></div>);`;
    const out = stripChromeEyebrowEchoes(code, scenesWith({ eyebrow: "THE PILOT" }));
    assert(out.stripped.length === 0 && out.code === code, "stable label kept");
    const req = `const Chrome = (p: { category: string }) => <div>{p.category}</div>;
const Section0 = () => (<div><Chrome category="The Pilot" /></div>);`;
    const out2 = stripChromeEyebrowEchoes(req, scenesWith({ eyebrow: "THE PILOT" }));
    assert(out2.stripped.length === 0, "required prop → never stripped (would not type-check)");
  });

  await check("detector reports the literal AS FOUND and its site", () => {
    const code = `const Section0 = () => (<div><Chrome category="The Pilot" /><p>hello</p></div>);`;
    const hits = findUnboundCopy(code, scenesWith({ eyebrow: "THE PILOT" }));
    assert(hits.length === 1, "flagged");
    assert(hits[0].site === "attribute", `site: ${hits[0].site}`);
    assert(hits[0].found === "The Pilot", `found: ${hits[0].found}`);
  });

  await check("scene-invariant furniture is exempt: tagline chrome on every page, one coinciding headline", () => {
    const code = `const Chrome = (p: { category?: string }) => <div>{p.category}</div>;
const Section0 = () => (<div><Chrome category="Investing for everyone" /><h1>{c.headline}</h1></div>);
const Section1 = () => (<div><Chrome category="Investing for everyone" /><h1>{c.headline}</h1></div>);`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scenes: any = [{ content: { headline: "Momentum" } }, { content: { headline: "Investing for everyone" } }];
    const hits = findUnboundCopy(code, scenes);
    assert(hits.length === 0, `stable label must not flag: ${JSON.stringify(hits)}`);
    const strip = stripChromeEyebrowEchoes(code, [
      { content: { eyebrow: "Momentum" } },
      { content: { eyebrow: "Investing for everyone" } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);
    assert(strip.stripped.length === 0, "stable label must not be stripped");
  });

  // ── THE REPLAY: three real survivor decks must come out clean ────────────
  const decks = [
    "01KZWE4CM7XS20NE5PD43WS4NK", // caption echo, textTransform context
    "01M05ZFQM60WNAG7F02HDA16NC", // Chrome category attribute echo
    "01KYE26Q8MR6MN68624P99RAAJ", // Chrome category attribute echo
  ];
  await checkWithDeck("replay 01KW048WG3…: invariant-tagline deck is clean WITHOUT repairs (false positive gone)", "01KW048WG3E399G5ZKS3JV9T16", async () => {
    const dir = "src/generated/01KW048WG3E399G5ZKS3JV9T16";
    const code = await fs.readFile(`${dir}/Composition.tsx`, "utf8");
    const script = JSON.parse(await fs.readFile(`${dir}/script.json`, "utf8"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hits = findUnboundCopy(code, script.scenes as any);
    assert(hits.length === 0, `must be exempt: ${JSON.stringify(hits)}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const strip = stripChromeEyebrowEchoes(code, script.scenes as any);
    assert(strip.stripped.length === 0, "stable tagline chrome untouched");
  });
  for (const d of decks) {
    await checkWithDeck(`replay ${d.slice(0, 10)}…: repaired, detector-clean, still compiles`, d, async () => {
      const dir = `src/generated/${d}`;
      const code = await fs.readFile(`${dir}/Composition.tsx`, "utf8");
      const script = JSON.parse(await fs.readFile(`${dir}/script.json`, "utf8"));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const scenes = script.scenes as any;
      const before = findUnboundCopy(code, scenes).filter((h) => h.field === "eyebrow");
      assert(before.length > 0, "precondition: the stored deck carries the defect");
      const bound = bindLiteralCopyInPlace(code, scenes);
      const stripped = stripChromeEyebrowEchoes(bound.code, scenes);
      const after = findUnboundCopy(stripped.code, scenes).filter((h) => h.field === "eyebrow");
      assert(after.length === 0, `still flagged after repairs: ${JSON.stringify(after)}`);
      assert(bound.bound.length + stripped.stripped.length > 0, "a repair actually ran");
      const compiled = await transform(stripped.code, { loader: "tsx" }).then(() => null).catch((e) => String(e));
      assert(compiled === null, `no longer compiles: ${compiled}`);
    });
  }

  console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped (stored-build fixtures absent)` : ""}`);
  if (failed > 0) process.exitCode = 1;
};
void run();
