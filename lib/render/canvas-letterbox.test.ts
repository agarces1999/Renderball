/**
 * The canvas must never show a black letterbox.
 *
 * WHY THIS EXISTS: the founder screenshotted black pillarbox bars beside his
 * deck. Two independent causes, both live at once, both measured in a real
 * browser at /dev/edit before the fix:
 *
 *   1. `lib/render/scene-iframe.ts` painted the scene document `#000`. That
 *      document is letterboxed inside somebody else's frame, so the colour it
 *      declares is the colour of the BARS — measured black at every viewport,
 *      including a 4px rim at heights where the aspect was exactly right.
 *   2. `components/EditorShell.tsx` capped the frame's width with
 *      `calc(100vh * w/h)`. The stage never gets 100vh; it gets what is left
 *      after the shell padding, toolbar, gaps and any banner (~141px, more with
 *      a banner). So the cap never bound, `max-h-full` clamped the height
 *      instead, and — measured, not assumed — Chrome does not pull the other
 *      axis back when one axis of an aspect-ratio box is clamped. The frame
 *      went to 1.90:1 at a 700px viewport, 2.61:1 with a banner at 620px, and
 *      the 342px of exposed frame is where the black came from.
 *
 * Geometry needs a browser and lives in the manual measurement (ratios at
 * viewport heights 1000/800/700/620, with and without a banner). What THIS
 * test holds is the contract that made the geometry correct, because both
 * regressions are one plausible-looking edit away: a colour on the scene doc,
 * or a viewport unit back in the frame's cap.
 */
import { mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { pathToFileURL } from "url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as esbuild from "esbuild";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`);
  }
};
const assert = (c: boolean, m: string) => {
  if (!c) throw new Error(m);
};

console.log("canvas letterbox (no host may be forced to show black bars)");

/* ── 1. the scene document owns no background ─────────────────────────────── */

// Read as source, not imported: scene-iframe.ts pulls react-dom/server through
// a top-level `eval("require")` to dodge Next's app-router static check, and
// that trick throws the moment the module is loaded as a plain ESM bundle.
const sceneIframeSrc = readFileSync(
  join(process.cwd(), "lib", "render", "scene-iframe.ts"),
  "utf8",
);
/** Every CSS rule in the emitted doc whose selector list mentions html or body. */
const docBodyRules = [...sceneIframeSrc.matchAll(/(^|\n)\s*((?:html|body)[^{\n]*)\{([^}]*)\}/g)].map(
  ([, , selector, body]) => ({ selector: selector.trim(), body }),
);

check("the scene document's html/body rule exists where this test can see it", () => {
  assert(
    docBodyRules.length > 0,
    "no html/body rule found in scene-iframe.ts — the doc CSS moved and the scan below is now vacuous",
  );
  assert(
    docBodyRules.some((r) => /background/.test(r.body)),
    "no html/body rule declares a background — the default is transparent, but say so explicitly " +
      "so the next person does not 'fix' the missing declaration with a colour",
  );
});

check("no html/body rule paints the scene document", () => {
  for (const { selector, body } of docBodyRules) {
    const bg = body.match(/background(?:-color)?\s*:\s*([^;}]+)/);
    if (!bg) continue;
    assert(
      bg[1].trim() === "transparent",
      `"${selector}" sets background: ${bg[1].trim()} — this document is letterboxed inside a host ` +
        `frame, so a colour here IS the colour of the bars. #000 is how the black ones got there.`,
    );
  }
});

/* ── 2. the editor frame sizes itself off its container, not the viewport ─── */

// EditorShell imports next/link, whose bare specifier node's ESM resolver
// refuses (the runner only rewrites next/server and next/headers). Bundle it
// here with a stub Link so the assertions can run against the component's REAL
// rendered output rather than a grep of its source.
// Written INSIDE the project (same reason scripts/run-tests.mjs does): a
// data: or tmpdir module cannot resolve the bare "react" specifier.
const bundlePath = join(process.cwd(), "node_modules", ".cache", "rb-tests", "EditorShell.under-test.mjs");
mkdirSync(dirname(bundlePath), { recursive: true });
await esbuild.build({
  entryPoints: [join(process.cwd(), "components", "EditorShell.tsx")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: bundlePath,
  jsx: "automatic",
  external: ["react", "react/jsx-runtime", "react-dom", "react-dom/server"],
  plugins: [
    {
      name: "next-link-stub",
      setup(build) {
        build.onResolve({ filter: /^next\/link$/ }, () => ({ path: "next-link", namespace: "stub" }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          contents:
            'import { createElement } from "react";\n' +
            "export default function Link(p) { return createElement('a', { href: p.href, className: p.className }, p.children); }\n",
          loader: "js",
        }));
      },
    },
  ],
});
const mod = (await import(
  pathToFileURL(bundlePath).href
)) as typeof import("../../components/EditorShell");

const markup = renderToStaticMarkup(
  React.createElement(mod.EditorShell, {
    slides: [{ label: "Cover" }, { label: "Problem" }],
    active: 0,
    onSelect: () => {},
    width: 1920,
    height: 1080,
    controls: {
      tool: "select",
      canUndo: false,
      select: () => {},
      generate: () => {},
      addText: () => {},
      addImage: () => {},
      undo: () => {},
    },
    children: React.createElement("iframe", { title: "page 1" }),
  }),
);

/** The frame is the element carrying the aspect-ratio — the box that letterboxes. */
const frameTag = (() => {
  const i = markup.indexOf("aspect-ratio:1920/1080");
  assert(i > 0, "no element in the rendered shell carries the canvas aspect ratio");
  const open = markup.lastIndexOf("<div", i);
  return markup.slice(open, markup.indexOf(">", i) + 1);
})();
/** The stage is the frame's parent — the box whose size the frame must read. */
const stageTag = (() => {
  const open = markup.lastIndexOf("<div", markup.indexOf(frameTag) - 1);
  return markup.slice(open, markup.indexOf(">", open) + 1);
})();

check("the frame's width cap is read from the container's height, not the viewport", () => {
  assert(
    /100cqh/.test(frameTag),
    `the frame no longer caps its width off the container height (100cqh):\n      ${frameTag}`,
  );
  assert(
    !/\d\s*vh|vh\s*\*|100vh/.test(frameTag),
    `a viewport unit is back in the frame's sizing — 100vh over-counts by every pixel of chrome ` +
      `above the stage, which is the original bug:\n      ${frameTag}`,
  );
});

check("the stage is a size container, or 100cqh silently means the viewport", () => {
  assert(
    /container-type:\s*size/.test(stageTag),
    `the stage is not a size container:\n      ${stageTag}\n      ` +
      `Without one, container-query units fall back to the SMALL VIEWPORT — measured: 100cqh ` +
      `resolved to 700px on a 700px-tall viewport, i.e. the 100vh bug wearing a new unit.`,
  );
});

check("the frame keeps a width fallback for engines without container queries", () => {
  assert(
    /\bw-full\b/.test(frameTag),
    `w-full is gone from the frame:\n      ${frameTag}\n      ` +
      `If min(...100cqh...) is unparseable the whole inline width declaration is dropped, and ` +
      `with no class fallback the frame shrink-wraps its absolutely-positioned children to zero.`,
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
