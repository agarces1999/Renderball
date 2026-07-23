/**
 * Render-path integration test (QA A2) — the SSR gate, end-to-end.
 *
 * Run: `npm test` or `node scripts/run-tests.mjs lib/render/render-gate.test.ts`
 * (from the repo root — fixtures resolve via process.cwd(), the same
 * assumption scripts/run-tests.mjs already makes). No API key, no network.
 *
 * Every empirically shipped bug (lucide undefined-icon crash, monochrome
 * output, bare stat scene) was RENDER-time — past every parse/compile gate.
 * verifyScenesRender is the only check between "compiles" and "white screen",
 * and until now nothing covered it: this test writes a realistic 2-scene
 * generated dir to a temp location via writeGeneratedFiles (the exact
 * artifact layout the pipeline emits), then bundles + evals + SSRs it the
 * way the preview/MP4 path does. Fixtures live in lib/render/__fixtures__/
 * (committed — src/generated/ is gitignored) as .txt so tsc skips them;
 * they are compiled at test time by the gate's own esbuild step.
 */
import { existsSync, readFileSync } from "fs";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import type { Script } from "../../src/schema";
import { writeGeneratedFiles } from "./build-wrapper";
import { verifyScenesRender, type RenderCheck } from "./ssr-render";

let passed = 0;
let failed = 0;
// Async variant of the check() pattern (quality-gates.test.ts) — the gate
// itself is async, so each check is awaited at top level.
const check = async (name: string, fn: () => Promise<void>) => {
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

// ── Fixtures: hand-written generated output, structured like the real thing ──
const FIXTURES = path.join(process.cwd(), "lib", "render", "__fixtures__");
if (!existsSync(FIXTURES)) {
  throw new Error(
    `fixtures not found at ${FIXTURES} — run tests from the repo root`,
  );
}
const GOOD_CODE = readFileSync(path.join(FIXTURES, "good-composition.tsx.txt"), "utf-8");
const CRASH_CODE = readFileSync(path.join(FIXTURES, "crash-composition.tsx.txt"), "utf-8");
const SCRIPT = JSON.parse(
  readFileSync(path.join(FIXTURES, "script.json"), "utf-8"),
) as Script;

// Each genDir is a throwaway temp dir — same layout as src/generated/<id>/,
// written by the SAME writeGeneratedFiles the preview + MP4 paths use.
const tempDirs: string[] = [];
const makeGenDir = async (code: string): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rb-render-gate-"));
  tempDirs.push(dir);
  await writeGeneratedFiles(dir, { designCode: code, code, script: SCRIPT });
  return dir;
};

try {
  // ── 1: the artifact layout the pipeline emits ─────────────────────────────
  const goodDir = await makeGenDir(GOOD_CODE);

  await check("writeGeneratedFiles emits the full generated-dir layout", async () => {
    for (const f of [
      "Composition.tsx",
      "Composition.design.tsx",
      "index.tsx",
      "script.json",
      "Img.tsx",
      "Video.tsx",
      "Lottie.tsx",
      "BrandChrome.tsx",
      "warnings.json",
    ]) {
      assert(existsSync(path.join(goodDir, f)), `missing ${f} in genDir`);
    }
    // The Remotion wrapper sequences both scenes and registers the root.
    const index = await fs.readFile(path.join(goodDir, "index.tsx"), "utf-8");
    assert(index.includes("pickSection(Sections, 0)"), "index.tsx missing scene 0 sequence");
    assert(index.includes("pickSection(Sections, 1)"), "index.tsx missing scene 1 sequence");
    assert(index.includes("registerRoot(Root)"), "index.tsx missing registerRoot");
  });

  // ── 2: GOOD fixture — bundles, evals, and SSRs clean ──────────────────────
  await check("good 2-scene composition passes the SSR gate (ok: true)", async () => {
    const out = await verifyScenesRender(goodDir, SCRIPT.scenes.length, SCRIPT);
    assert(
      out.ok && out.errors.length === 0,
      `expected ok, got ${JSON.stringify(out.errors)}`,
    );
  });

  // ── 3: CRASH fixture — the 87c785f lucide undefined-icon bug class ────────
  await check("invalid lucide icon in scene 1 fails the gate AT scene 1", async () => {
    const crashDir = await makeGenDir(CRASH_CODE);
    // React dev-mode logs an "invalid element type" console.error before
    // throwing — that's the expected crash, not a test failure. Mute it so
    // the test output stays readable.
    const realError = console.error;
    console.error = () => {};
    let out: RenderCheck;
    try {
      out = await verifyScenesRender(crashDir, SCRIPT.scenes.length, SCRIPT);
    } finally {
      console.error = realError;
    }
    assert(!out.ok, "gate passed a composition that white-screens at render");
    // The clean scene 0 must NOT be blamed — attribution is per scene, not
    // whole-file (a whole-file failure would report scene -1).
    assert(
      !out.errors.some((e) => e.scene === 0 || e.scene === -1),
      `clean scene blamed: ${JSON.stringify(out.errors)}`,
    );
    const sceneOne = out.errors.find((e) => e.scene === 1);
    assert(!!sceneOne, `scene 1 not identified: ${JSON.stringify(out.errors)}`);
    // React's render error for an undefined component type.
    assert(
      /element type is invalid|undefined/i.test(sceneOne!.error),
      `unhelpful error message: ${sceneOne!.error}`,
    );
  });

  // ── 3b: the 01KY86J312SRPDXY6D58MSXJ81 class — an undefined VALUE identifier
  // in a piece body (`rows.map(...)`, `rows` declared nowhere). Compiles clean
  // (esbuild is syntax-only) and throws ReferenceError at render. The cast path
  // now runs THIS gate after its quality loop (fail closed) — this case locks
  // that the gate actually catches the class, with per-scene attribution.
  await check("undefined value identifier (`rows`) fails the gate AT its scene", async () => {
    const undefValueDir = await makeGenDir(
      `import React from "react";
export const Section0: React.FC<{ script: unknown }> = () => <div>fine</div>;
export const Section1: React.FC<{ script: unknown }> = () => (
  <div>{rows.map((row: any, i: number) => <span key={i}>{row.title}</span>)}</div>
);
`,
    );
    const realError = console.error;
    console.error = () => {};
    let out: RenderCheck;
    try {
      out = await verifyScenesRender(undefValueDir, SCRIPT.scenes.length, SCRIPT);
    } finally {
      console.error = realError;
    }
    assert(!out.ok, "gate passed a composition whose scene throws ReferenceError at render");
    assert(
      !out.errors.some((e) => e.scene === 0 || e.scene === -1),
      `clean scene blamed: ${JSON.stringify(out.errors)}`,
    );
    const sceneOne = out.errors.find((e) => e.scene === 1);
    assert(!!sceneOne, `scene 1 not identified: ${JSON.stringify(out.errors)}`);
    assert(
      /rows is not defined/.test(sceneOne!.error),
      `expected the ReferenceError text, got: ${sceneOne!.error}`,
    );
  });

  // ── 4: missing Composition.tsx — whole-file failure, scene -1 ─────────────
  await check("missing Composition.tsx reports scene -1 with a clear message", async () => {
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "rb-render-gate-"));
    tempDirs.push(emptyDir);
    const out = await verifyScenesRender(emptyDir, 2, SCRIPT);
    assert(!out.ok, "gate passed an empty genDir");
    assert(
      out.errors.length === 1 && out.errors[0].scene === -1,
      `expected one scene -1 error, got ${JSON.stringify(out.errors)}`,
    );
    assert(/Composition\.tsx missing/.test(out.errors[0].error), `got: ${out.errors[0].error}`);
  });

  // ── 5: syntax error — compile failure, scene -1, "compile:" prefix ────────
  await check("syntax error reports scene -1 with a compile: message", async () => {
    const brokenDir = await makeGenDir(
      `import React from "react";\nexport const Section0 = ( => {`,
    );
    const out = await verifyScenesRender(brokenDir, 1, SCRIPT);
    assert(!out.ok, "gate passed unparseable code");
    assert(
      out.errors.length === 1 && out.errors[0].scene === -1,
      `expected one scene -1 error, got ${JSON.stringify(out.errors)}`,
    );
    assert(/^compile:/.test(out.errors[0].error), `got: ${out.errors[0].error}`);
  });

  // ── 6: missing Section export — names the gap + lists what IS exported ────
  await check("a scene with no Section export is identified by index", async () => {
    // Ask the 2-scene fixture to verify 3 scenes: scene 2 has no component.
    const out = await verifyScenesRender(goodDir, 3, SCRIPT);
    assert(!out.ok, "gate passed a missing section");
    assert(
      out.errors.length === 1 && out.errors[0].scene === 2,
      `expected only scene 2 to fail, got ${JSON.stringify(out.errors)}`,
    );
    assert(
      /no Section2 export/.test(out.errors[0].error) &&
        out.errors[0].error.includes("Section0"),
      `message should name the gap and list real exports, got: ${out.errors[0].error}`,
    );
  });

  // ── 7: naming-drift tolerance — Scene{i}Slide resolves like Section{i} ────
  await check("Scene0Slide naming drift is accepted by the gate", async () => {
    const driftDir = await makeGenDir(
      `import React from "react";
export const Scene0Slide: React.FC<{ script: unknown }> = () => <div>drift</div>;
`,
    );
    const out = await verifyScenesRender(driftDir, 1, SCRIPT);
    assert(out.ok, `expected ok, got ${JSON.stringify(out.errors)}`);
  });
} finally {
  await Promise.all(
    tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })),
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
