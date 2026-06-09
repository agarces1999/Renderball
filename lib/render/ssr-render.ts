import { promises as fs } from "fs";
import path from "path";
import { createRequire } from "module";
import React from "react";
import * as esbuild from "esbuild";

/**
 * Server-side render gate (QA): does every Section{N} actually RENDER, not just
 * parse? The build pipeline's compile gate uses esbuild.transform (syntax only),
 * but the preview/MP4 path bundles + evals + SSRs the composition — a strictly
 * stronger check. Builds can pass transform yet throw at render ("Cannot read
 * properties of undefined (reading 'hex')") or export the wrong component name.
 *
 * This reuses the EXACT compile+eval+SSR steps the iframe preview route runs, so
 * "renders here" == "renders in the preview". It operates on a written genDir
 * (Composition.tsx + sibling shims on disk), mirroring the preview environment.
 */

// Same externals the iframe route uses — peer deps stay runtime require()s
// resolved against node_modules; only the local TS (Composition + shims) bundles.
const EXTERNALS = [
  "react",
  "react-dom",
  "react-dom/server",
  "recharts",
  "lucide-react",
  "shiki",
  "simple-icons",
  "simple-icons/icons",
  "remotion",
  "@remotion/lottie",
];

// A CJS require for react-dom/server + the eval'd bundle's externals.
// In the Next server bundle (CJS) eval("require") is the real require — the
// app-router static-analysis bypass, identical to the iframe route. Under the
// ESM test runner (scripts/run-tests.mjs) there is no `require` in scope, so
// fall back to createRequire anchored at the project root: same node_modules,
// same resolution. The Next path is untouched — eval("require") still wins
// whenever it resolves.
const nodeRequire: NodeRequire = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return eval("require") as NodeRequire;
  } catch {
    return createRequire(path.join(process.cwd(), "package.json"));
  }
})();

const { renderToStaticMarkup } = nodeRequire("react-dom/server") as {
  renderToStaticMarkup: (node: React.ReactNode) => string;
};

export interface RenderCheck {
  ok: boolean;
  errors: { scene: number; error: string }[];
}

/**
 * Bundle + eval the Composition once, then SSR every Section{N}. Returns the
 * first render error per scene (scene -1 = whole-file compile/eval failure).
 */
export const verifyScenesRender = async (
  genDir: string,
  sceneCount: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  script: any,
): Promise<RenderCheck> => {
  const compPath = path.join(genDir, "Composition.tsx");
  try {
    await fs.access(compPath);
  } catch {
    return { ok: false, errors: [{ scene: -1, error: "Composition.tsx missing" }] };
  }

  let bundle: string;
  try {
    const result = await esbuild.build({
      entryPoints: [compPath],
      bundle: true,
      format: "cjs",
      platform: "node",
      target: "node18",
      jsx: "automatic",
      write: false,
      external: EXTERNALS,
      logLevel: "silent",
    });
    bundle = result.outputFiles[0].text;
  } catch (err) {
    return {
      ok: false,
      errors: [{ scene: -1, error: `compile: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` }],
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const moduleObj: { exports: Record<string, any> } = { exports: {} };
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function("module", "exports", "require", bundle);
    fn(moduleObj, moduleObj.exports, nodeRequire);
  } catch (err) {
    return {
      ok: false,
      errors: [{ scene: -1, error: `eval: ${err instanceof Error ? err.message : String(err)}` }],
    };
  }

  const mod = moduleObj.exports;
  const errors: { scene: number; error: string }[] = [];
  for (let i = 0; i < sceneCount; i++) {
    const Section =
      [`Section${i}`, `Scene${i}Slide`, `Scene${i}`, `Slide${i}`]
        .map((n) => mod[n])
        .find((f) => typeof f === "function") as
        | React.ComponentType<{ script: unknown }>
        | undefined;
    if (!Section) {
      errors.push({ scene: i, error: `no Section${i} export (exports: ${Object.keys(mod).slice(0, 6).join(", ")})` });
      continue;
    }
    try {
      renderToStaticMarkup(React.createElement(Section, { script }));
    } catch (err) {
      errors.push({ scene: i, error: err instanceof Error ? err.message.slice(0, 140) : String(err) });
    }
  }
  return { ok: errors.length === 0, errors };
};
