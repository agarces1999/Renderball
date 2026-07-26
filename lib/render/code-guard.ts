/**
 * Containment for LLM-authored composition code.
 *
 * The design agents emit `Composition.tsx` as source text. That file is
 * esbuild-bundled and then executed IN THIS PROCESS via
 * `new Function(...)(module, exports, require)` — see scene-iframe.ts,
 * ssr-render.ts, measure-scene.ts, density-gates.ts. The process holds
 * DATABASE_URL, CLERK_SECRET_KEY, STRIPE_SECRET_KEY and RB_FIREWORKS_KEY, so
 * "whatever the model wrote" must not be able to reach a real `require`.
 *
 * The model is not the only author in that chain: crawled third-party page
 * text reaches the prompt and is deliberately framed as authoritative ("the
 * brand's ACTUAL claims"), so a poisoned site is an injection channel into
 * the emitted file. Prompt-level rules are not a control here — an audit
 * build violated the prompt's explicit "never invent timeframes" rule on the
 * first try. Hence two mechanical layers, neither of which trusts the model:
 *
 *   1. assertSafeComposition() — refuse to WRITE source that imports outside
 *      the render allowlist or reaches for host capabilities.
 *   2. sandboxedRequire()      — refuse to RESOLVE anything outside the
 *      allowlist at execute time, which is what actually stops a bundle
 *      (esbuild keeps node builtins external under platform:"node", so an
 *      un-allowlisted `import "child_process"` survives bundling).
 */

/**
 * Every module a legitimate composition may reach. This mirrors the esbuild
 * `external` list used by all four execution sites — anything not external is
 * bundled, so this set IS the runtime module surface.
 */
export const RENDER_ALLOWED_MODULES: readonly string[] = [
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

const ALLOWED = new Set(RENDER_ALLOWED_MODULES);

/** Sub-path imports off an allowlisted package (e.g. "lucide-react/icons/x"). */
const isAllowedSubpath = (spec: string): boolean =>
  RENDER_ALLOWED_MODULES.some((m) => spec === m || spec.startsWith(`${m}/`));

/** Relative imports resolve to the shims WE write next to the composition
 *  (Img/Piece/Video/Lottie/BrandChrome) — our code, not the model's. */
const isRelative = (spec: string): boolean =>
  spec.startsWith("./") || spec.startsWith("../");

export class UnsafeCompositionError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = "UnsafeCompositionError";
  }
}

/**
 * Host capabilities that never legitimately appear in a React composition.
 * Deliberately narrow and anchored: `process` alone is a normal English word
 * ("processing"), so only a property access counts; `constructor[` catches the
 * classic Function-constructor escape without flagging ordinary prose.
 */
const FORBIDDEN: ReadonlyArray<{ re: RegExp; reason: string }> = [
  { re: /\brequire\s*\(/, reason: "require() call" },
  { re: /\bimport\s*\(/, reason: "dynamic import()" },
  { re: /\beval\s*\(/, reason: "eval()" },
  { re: /\bnew\s+Function\s*\(/, reason: "Function constructor" },
  { re: /\bprocess\s*(\.\s*\w|\[)/, reason: "process access" },
  { re: /\bglobalThis\b/, reason: "globalThis access" },
  { re: /\b__proto__\b/, reason: "__proto__ access" },
  { re: /\bconstructor\s*\[/, reason: "constructor[] escape" },
  { re: /\bnode:[a-z_]+/, reason: "node: builtin specifier" },
  {
    re: /\b(child_process|worker_threads|fs\/promises|node_modules)\b/,
    reason: "node builtin reference",
  },
];

/**
 * A syntactically plausible module specifier. Compositions legitimately
 * render fake code blocks whose syntax-highlighting DATA contains the tokens
 * `import` and `from` (see the CODE_LINES arrays in stored builds), so the
 * extractor below over-matches across such data. Anything that cannot be a
 * real specifier — spaces, colons, punctuation — is a scanning artifact, not
 * an import, and is skipped. `node:` specifiers do contain a colon and would
 * land here; FORBIDDEN catches those directly, so nothing is lost.
 */
const PLAUSIBLE_SPECIFIER = /^[@\w./-]+$/;

/** Pull every module specifier out of import/export statements. */
const importSpecifiers = (source: string): string[] => {
  const out: string[] = [];
  const patterns = [
    /^\s*import\s+[^;]*?\bfrom\s*["']([^"']+)["']/gm, // import X from "y"
    /^\s*import\s*["']([^"']+)["']/gm, // bare import "y"
    /^\s*export\s+[^;]*?\bfrom\s*["']([^"']+)["']/gm, // re-export
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      if (PLAUSIBLE_SPECIFIER.test(m[1])) out.push(m[1]);
    }
  }
  return out;
};

/**
 * Throw unless `source` is safe to write and execute. Called before the
 * emitted file touches disk, so unsafe output fails the BUILD rather than
 * reaching a renderer.
 */
export const assertSafeComposition = (source: string, label = "composition"): void => {
  for (const { re, reason } of FORBIDDEN) {
    const m = re.exec(source);
    if (m) {
      throw new UnsafeCompositionError(
        `${label}: refused — ${reason} at "${excerpt(source, m.index)}"`,
        reason,
      );
    }
  }
  for (const spec of importSpecifiers(source)) {
    if (isRelative(spec) || isAllowedSubpath(spec)) continue;
    throw new UnsafeCompositionError(
      `${label}: refused — import of "${spec}" is outside the render allowlist`,
      "disallowed-import",
    );
  }
};

/** Same check, non-throwing — for callers that want to log and continue. */
export const checkComposition = (
  source: string,
  label = "composition",
): { safe: true } | { safe: false; reason: string; message: string } => {
  try {
    assertSafeComposition(source, label);
    return { safe: true };
  } catch (err) {
    if (err instanceof UnsafeCompositionError) {
      return { safe: false, reason: err.reason, message: err.message };
    }
    throw err;
  }
};

const excerpt = (source: string, at: number): string =>
  source.slice(Math.max(0, at - 12), at + 48).replace(/\s+/g, " ").trim();

/**
 * Wrap a real `require` so an executing bundle can only resolve the render
 * allowlist. This is the layer that matters: esbuild leaves node builtins
 * external under platform:"node", so without it a bundled
 * `require("child_process")` reaches the host regardless of what the source
 * scan did.
 */
export const sandboxedRequire = (real: NodeRequire): NodeRequire => {
  const guarded = ((spec: string) => {
    if (typeof spec === "string" && (ALLOWED.has(spec) || isAllowedSubpath(spec))) {
      return real(spec);
    }
    throw new UnsafeCompositionError(
      `blocked require("${String(spec)}") — outside the render allowlist`,
      "blocked-require",
    );
  }) as unknown as NodeRequire;
  // Keep the shape callers expect; resolution itself stays guarded above.
  guarded.resolve = real.resolve;
  guarded.cache = real.cache;
  guarded.main = real.main;
  guarded.extensions = real.extensions;
  return guarded;
};
