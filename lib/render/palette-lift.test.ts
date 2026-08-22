//
// Safe palette lifting.
//
// The fixture preamble is verbatim from 01KY7ZGC4MVDD5J1DSB35GAW5T — the deck behind
// "the element on the right is bad on visibility". Its warnings.json recorded exactly
// one contrast entry, { fg: "#64748b", bg: "#f1f5f9", ratio: 4.3 }, and its preamble
// declares `slate: "#64748b"`.
//
// Most of these tests are about REFUSING. A token lift is a global edit made because
// one local node failed, so the interesting cases are the ones where it must not
// happen: another node on a dark surface, an unusable parse, an ambiguous anchor.
//
import { parsePalette, judgeTokenLift, patchPaletteToken, normaliseHex, liftWashedPaletteTokens, type InkSample } from "./palette-lift";
import { contrastRatio } from "../agents/contrast";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("\n▶ palette-lift");

/** Verbatim from the deck's manifest preamble. */
const PREAMBLE = `// ─── Palette (crawled, no invented hex) ───────────────────
const PALETTE = {
  white: "#ffffff",
  ink: "#1a2332",
  navy: "#21296a",
  signature: "#0078a8",
  sky: "#3388ff",
  cyan: "#70ddf0",
  slate: "#64748b",
  mist: "#e2e8f0",
  steel: "#94a3b8",
} as const;

const BRAND_LIGHT = PALETTE.white;
const BRAND_INK = PALETTE.ink;
`;

const sample = (over: Partial<InkSample> = {}): InkSample => ({
  scene: 0, pieceId: "s0.copy", ink: "#64748b", backdrop: "#f1f5f9",
  ratio: contrastRatio("#64748b", "#f1f5f9"), ...over,
});

check("the real preamble parses to its nine tokens", () => {
  const p = parsePalette(PREAMBLE);
  assert(p.length === 9, `expected 9 tokens, got ${p.length}: ${p.map((x) => x.token).join(",")}`);
  const slate = p.find((x) => x.token === "slate");
  assert(slate?.hex === "#64748b", `slate wrong: ${JSON.stringify(slate)}`);
});

check("THE FOUNDER CASE: slate lifts, and the guard allows it", () => {
  const v = judgeTokenLift({ token: "slate", hex: "#64748b" }, [sample()]);
  assert(v.safe, `refused: ${JSON.stringify(v)}`);
  if (!v.safe) return;
  assert(contrastRatio(v.to, "#f1f5f9") >= 4.5, `lift does not clear AA: ${v.to}`);
});

check("REFUSED when one token is used on surfaces that pull in opposite directions", () => {
  // slate on a near-white panel wants to go DARKER; the same slate on near-black
  // wants to go LIGHTER. (slate cannot clear AA on any dark surface at all — its
  // luminance is 0.17, so even pure black only reaches 4.4 — which is precisely why
  // one token cannot serve both, and why the lift must not happen.)
  const users = [
    sample(),
    sample({ scene: 3, pieceId: "s3.mock", backdrop: "#111827", ratio: contrastRatio("#64748b", "#111827") }),
  ];
  const v = judgeTokenLift({ token: "slate", hex: "#64748b" }, users);
  assert(!v.safe, `should have refused: ${JSON.stringify(v)}`);
  if (v.safe) return;
  // The reason must be concrete — a named node with real before/after numbers, so a
  // human reading the build log can check the arithmetic rather than trust it.
  assert(/s\d+\/s\d+\.\w+/.test(v.reason), `reason should name a node: ${v.reason}`);
  assert(/\d\.\d{2} to \d\.\d{2}/.test(v.reason), `reason should show the regression: ${v.reason}`);
  assert(v.to !== null, "a refusal should still report the hex it wanted, for the regen path");
});

check("a node ALREADY failing that the lift cannot rescue is not counted as broken", () => {
  // On a mid backdrop this node fails before and after. We did not make it worse, so
  // it must not veto a lift that rescues the others.
  const users = [
    sample(),
    sample({ scene: 2, pieceId: "s2.hint", backdrop: "#7a8494", ratio: contrastRatio("#64748b", "#7a8494") }),
  ];
  const v = judgeTokenLift({ token: "slate", hex: "#64748b" }, users);
  assert(v.safe, `should have allowed: ${JSON.stringify(v)}`);
});

check("a token nothing uses is refused — silence is not safety", () => {
  const v = judgeTokenLift({ token: "cyan", hex: "#70ddf0" }, [sample()]);
  assert(!v.safe && /no measured node/.test((v as { reason: string }).reason), JSON.stringify(v));
});

check("a token whose nodes all pass is left alone", () => {
  const users = [sample({ ink: "#1a2332", ratio: contrastRatio("#1a2332", "#ffffff"), backdrop: "#ffffff" })];
  const v = judgeTokenLift({ token: "ink", hex: "#1a2332" }, users);
  assert(!v.safe && /nothing failing/.test((v as { reason: string }).reason), JSON.stringify(v));
});

check("the worst offender drives the lift, not the mildest", () => {
  const users = [
    sample({ backdrop: "#f1f5f9", ratio: contrastRatio("#64748b", "#f1f5f9") }), // ~4.34
    sample({ scene: 1, pieceId: "s1.meta", backdrop: "#e2e8f0", ratio: contrastRatio("#64748b", "#e2e8f0") }), // lower
  ];
  const v = judgeTokenLift({ token: "slate", hex: "#64748b" }, users);
  assert(v.safe, `refused: ${JSON.stringify(v)}`);
  if (!v.safe) return;
  // Clearing the WORST backdrop must also clear the milder one.
  for (const u of users) assert(contrastRatio(v.to, u.backdrop) >= 4.5, `${u.pieceId} still fails with ${v.to}`);
});

check("patching writes only the PALETTE entry, not other uses of the same hex", () => {
  const withDuplicate = PREAMBLE + `\nconst SHADOW = "0 2px 8px #64748b";\n`;
  const out = patchPaletteToken(withDuplicate, "slate", "#64748b", "#627188");
  assert(out !== null, "patch returned null");
  if (!out) return;
  assert(/slate:\s*"#627188"/.test(out), "token not updated");
  assert(out.includes(`const SHADOW = "0 2px 8px #64748b"`), "clobbered an unrelated use of the hex");
  assert(!/slate:\s*"#64748b"/.test(out), "old value survived");
});

check("an anchor that is not found exactly once refuses to patch", () => {
  assert(patchPaletteToken(PREAMBLE, "slate", "#000000", "#111111") === null, "patched a hex that is not there");
  const twice = PREAMBLE + `\nconst OTHER = { slate: "#64748b" };\n`;
  assert(patchPaletteToken(twice, "slate", "#64748b", "#627188") === null, "patched an ambiguous anchor");
});

check("a preamble with no PALETTE block yields no tokens rather than throwing", () => {
  assert(parsePalette("const x = 1;").length === 0, "should be empty");
  assert(parsePalette("").length === 0, "should be empty");
});

check("3-digit hex normalises so measured ink matches the palette", () => {
  assert(normaliseHex("#ABC") === "#aabbcc", normaliseHex("#ABC"));
  const v = judgeTokenLift({ token: "g", hex: "#999" }, [
    sample({ ink: "#999999", backdrop: "#ffffff", ratio: contrastRatio("#999999", "#ffffff") }),
  ]);
  assert(v.safe, `short hex should still match a measured node: ${JSON.stringify(v)}`);
});

// ── the IO half, with injected deps (no build, no filesystem) ────────────────

const runLift = async (samples: InkSample[], preamble = PREAMBLE, commitOk = true) => {
  const written: { preamble: string }[] = [];
  const commits: string[] = [];
  const events = await liftWashedPaletteTokens(
    "/fake/genDir",
    samples,
    {
      readManifest: async () => ({ preamble }),
      writeManifest: async (_g, m) => { written.push(m as unknown as { preamble: string }); },
      commit: async (_g, msg) => { commits.push(msg); return commitOk ? { ok: true } : { ok: false, error: "tsc exploded" }; },
    },
  );
  return { events, written, commits };
};

await (async () => {
  const r = await runLift([sample()]);
  check("IO: the founder case is applied, written, and committed", () => {
    const applied = r.events.filter((e) => e.applied);
    assert(applied.length === 1 && applied[0].token === "slate", JSON.stringify(r.events));
    assert(r.written.length === 1, "manifest not written");
    assert(/slate:\s*"#(?!64748b)/.test(r.written[0].preamble), "preamble not updated");
    assert(r.commits.length === 1, "never committed — the store would change and the render would not");
  });

  const r2 = await runLift([
    sample(),
    sample({ scene: 3, pieceId: "s3.mock", backdrop: "#111827", ratio: contrastRatio("#64748b", "#111827") }),
  ]);
  check("IO: a refused lift writes nothing at all", () => {
    assert(r2.events.every((e) => !e.applied), JSON.stringify(r2.events));
    assert(r2.written.length === 0 && r2.commits.length === 0, "refused but still wrote");
    assert(r2.events.some((e) => e.to !== null), "refusal must still name the target hex");
  });

  const r3 = await runLift([sample({ ink: "#1a2332", backdrop: "#ffffff", ratio: 15 })]);
  check("IO: nothing failing means nothing touched", () => {
    assert(r3.events.length === 0 && r3.written.length === 0 && r3.commits.length === 0, JSON.stringify(r3.events));
  });

  const r4 = await runLift([sample()], PREAMBLE, false);
  check("IO: a failed commit un-marks the lift rather than claiming success", () => {
    assert(r4.events.every((e) => !e.applied), `still reported applied: ${JSON.stringify(r4.events)}`);
    assert(r4.events.some((e) => /commit failed/.test(e.reason ?? "")), JSON.stringify(r4.events));
  });

  const r5 = await runLift([sample()], "const x = 1;");
  check("IO: a preamble with no palette is a no-op, not a throw", () => {
    assert(r5.events.length === 0 && r5.written.length === 0, JSON.stringify(r5.events));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
