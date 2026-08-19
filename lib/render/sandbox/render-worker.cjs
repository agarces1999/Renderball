/**
 * Render worker — where LLM-authored composition code actually executes.
 *
 * This file runs as a SEPARATE OS PROCESS, spawned by pool.ts with a scrubbed
 * environment. That is the whole point: the parent Next.js process holds
 * DATABASE_URL, CLERK_SECRET_KEY, STRIPE_SECRET_KEY and RB_FIREWORKS_KEY, and
 * composition code must never run in the same place as those.
 *
 * Two problems this solves, and only one of them is security:
 *
 *   1. CONTAINMENT. A composition is written by a model whose prompt includes
 *      text crawled from third-party websites. If a poisoned site ever gets a
 *      payload into the emitted file, it executes here — in a process whose
 *      environment is empty — instead of next to every secret we own.
 *
 *   2. INTERRUPTIBILITY, which matters more day to day. `new Function(...)()`
 *      is SYNCHRONOUS: a composition containing an infinite loop or runaway
 *      recursion cannot be interrupted from the thread running it, so in the
 *      old in-process design one bad slide froze the entire server for every
 *      user, permanently. A model emitting an accidental infinite loop is far
 *      likelier than a successful attack. Only a separate process can be given
 *      a stopwatch — the parent kills this one and restarts it.
 *
 * Plain CommonJS on purpose: it is spawned directly by `node`, with no build
 * step, and the Dockerfile ships the repo verbatim (`COPY . .`).
 *
 * Protocol (JSON over the child_process IPC channel):
 *   → { id, compPath, sceneIndex, script }
 *   ← { id, ok: true, html }
 *   ← { id, ok: false, status, message }
 */
const esbuild = require("esbuild");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

/**
 * The module surface a composition may reach.
 *
 * MUST stay identical to RENDER_ALLOWED_MODULES in lib/render/code-guard.ts —
 * that file is the source of truth and a test asserts these do not drift. It
 * is duplicated rather than imported because this worker is standalone .cjs
 * with no TypeScript build step.
 */
const ALLOWED = [
  "react",
  "react-dom",
  "react-dom/server",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "recharts",
  "lucide-react",
  "shiki",
  "simple-icons",
  "simple-icons/icons",
  "remotion",
  "@remotion/lottie",
];

const allowed = (spec) =>
  typeof spec === "string" && ALLOWED.some((m) => spec === m || spec.startsWith(`${m}/`));

/** Module resolution is a chokepoint composition code cannot route around. */
const jailedRequire = (spec) => {
  if (allowed(spec)) return require(spec);
  throw new Error(`blocked require("${String(spec)}") — outside the render allowlist`);
};

/** esbuild keeps these external, so they are exactly what hits jailedRequire. */
const EXTERNALS = ALLOWED.filter((m) => !m.startsWith("react/jsx"));

const compile = async (compPath) => {
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
  return result.outputFiles[0].text;
};

const renderScene = async ({ compPath, sceneIndex, script }) => {
  let bundle;
  try {
    bundle = await compile(compPath);
  } catch (err) {
    return { ok: false, status: 500, message: `Compilation error: ${msg(err)}` };
  }

  const moduleObj = { exports: {} };
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function("module", "exports", "require", bundle);
    fn(moduleObj, moduleObj.exports, jailedRequire);
  } catch (err) {
    return { ok: false, status: 500, message: `Module eval error: ${msg(err)}` };
  }

  const mod = moduleObj.exports;
  const candidates = [
    `Section${sceneIndex}`,
    `Scene${sceneIndex}Slide`,
    `Scene${sceneIndex}`,
    `Slide${sceneIndex}`,
  ];
  const name = candidates.find((n) => typeof mod[n] === "function");
  if (!name) {
    return {
      ok: false,
      status: 500,
      message: `No Section${sceneIndex} exported. Exports: ${Object.keys(mod).join(", ")}`,
    };
  }

  try {
    // Rendering happens HERE, not in the parent: the component is a live
    // function and cannot cross a process boundary. Only the HTML string does.
    return { ok: true, html: fixStyleEntities(renderToStaticMarkup(React.createElement(mod[name], { script }))) };
  } catch (err) {
    return { ok: false, status: 500, message: `Render error: ${msg(err)}` };
  }
};

/**
 * React escapes text children EVERYWHERE — including inside <style>, where
 * browsers never decode entities. A composition's <style>{`content: "0"`}
 * </style> therefore served `content: &quot;0&quot;` — invalid CSS, so
 * every quoted declaration (count-up content animations, quoted font names
 * in scene-local styles) was silently dead in previews AND exports. The
 * client-preview parity gate exposed it (2026-08-20): the client-rendered
 * DOM carried real quotes and was the correct one. Decode entities inside
 * style blocks only — everywhere else the escaping is load-bearing.
 */
const fixStyleEntities = (html) =>
  html.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/g, (whole, open, css, close) =>
    open +
    css.replace(/&(quot|#x27|#39|amp|lt|gt);/g, (m, e) =>
      e === "quot" ? '"' : e === "amp" ? "&" : e === "lt" ? "<" : e === "gt" ? ">" : "'",
    ) +
    close);

const msg = (err) => (err instanceof Error ? err.message : String(err));

process.on("message", (req) => {
  if (!req || typeof req.id !== "number") return;
  renderScene(req)
    .then((res) => process.send({ id: req.id, ...res }))
    .catch((err) =>
      process.send({ id: req.id, ok: false, status: 500, message: `worker error: ${msg(err)}` }),
    );
});

// If the parent goes away, this process must not linger holding a port-less
// event loop open.
process.on("disconnect", () => process.exit(0));

if (process.send) process.send({ ready: true });
