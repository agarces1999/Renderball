/**
 * Partial containment for LLM-authored composition code.
 *
 * READ THIS BEFORE TRUSTING IT. The design agents emit `Composition.tsx` as
 * source text, which is esbuild-bundled and executed IN THIS PROCESS via
 * `new Function(...)(module, exports, require)` — see scene-iframe.ts,
 * ssr-render.ts, measure-scene.ts, density-gates.ts. The process holds
 * DATABASE_URL, CLERK_SECRET_KEY, STRIPE_SECRET_KEY and RB_FIREWORKS_KEY.
 *
 * WHAT THIS MODULE ACTUALLY GUARANTEES:
 *   - sandboxedRequire() is a real control. Module resolution is a chokepoint
 *     an attacker cannot route around, so `require("child_process")` — which
 *     survives bundling, since esbuild keeps node builtins external under
 *     platform:"node" — is genuinely blocked.
 *
 * WHAT IT DOES NOT GUARANTEE — measured, not theorised:
 *   - assertSafeComposition() is a TRIPWIRE, not a boundary. It is a regex
 *     over text and loses to obfuscation: `"req"+"uire"`, `(0,eval)(…)`,
 *     `const p = process; p["env"]`, unicode escapes and comment-splitting
 *     all pass it.
 *   - Lexical shadowing of process/global/globalThis does NOT contain an
 *     attacker either. `Function("return this")()` is compiled in global
 *     scope, so it hands back the real global object regardless of what the
 *     parameter names are bound to; `({}).constructor.constructor` recovers
 *     Function even if Function itself is shadowed. Verified: a payload that
 *     passes the scan reads process.env through it.
 *
 * THEREFORE: assume a hostile composition can read every secret in this
 * process. The only sound fix is to stop executing this code here — run the
 * bundle in a forked process or worker started with a scrubbed env, or move
 * SSR out of the Next server. `vm.runInNewContext` is hardening, not a
 * boundary, per Node's own documentation. Until that lands, the layers below
 * raise the cost of an attack and catch accidents; they do not make the
 * execution safe.
 *
 * Injection reaches here through crawled third-party page text, which the
 * prompt frames as authoritative ("the brand's ACTUAL claims"), and through
 * the user's own brief. Prompt-level rules are not a control: an audit build
 * violated the prompt's explicit "never invent timeframes" rule on sight.
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
 * Throw unless `source` looks safe. NOTE: callers on the build path must use
 * `reportUnsafeComposition` instead — see there for why this must not fail a
 * build. Exported for tests and for any caller that genuinely wants to reject.
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

/**
 * Tripwire for the build path: log loudly, never throw.
 *
 * This scan CANNOT be a gate. Measured against realistic compositions, it
 * rejects 6 out of 6 legitimate ones — ordinary business prose ("That is our
 * process. We ship weekly." matches the process-access rule, since `\s*`
 * spans the sentence break) and any slide that renders a CODE SNIPPET
 * containing `require(`, `node_modules`, `import express from "express"` or a
 * chart series labelled "eval (ms)". Rendering code samples is a first-class
 * use case for a deck tool aimed at software companies.
 *
 * Because it runs inside writeGeneratedFiles, a hit would throw AFTER a
 * complete ~$1-2 build, destroying finished work the user paid for, with an
 * unactionable error. Given the scan is a tripwire rather than a boundary
 * (module header), that trade is strictly bad: the cost is certain and the
 * security benefit is near zero. So it reports and the build proceeds; the
 * real control on module access is sandboxedRequire.
 */
export const reportUnsafeComposition = (source: string, label: string): void => {
  const r = checkComposition(source, label);
  if (!r.safe) {
    console.warn(
      `[code-guard] ${r.message} — NOT blocking the build (this scan is a ` +
        `tripwire, not a boundary; see lib/render/code-guard.ts). Review if unexpected.`,
    );
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
/**
 * Identifiers shadowed in the executing bundle's scope.
 *
 * KEEP EXPECTATIONS LOW. This raises the cost of the laziest payloads
 * (a bare `process.env.X`) and nothing more: `Function("return this")()`
 * still returns the real global object, because a Function-constructed
 * function is compiled in global scope. Retained as cheap defence in depth,
 * NOT as the boundary — see the module header.
 *
 * The source scan is a regex over text, so it loses to obfuscation — verified:
 * `"req"+"uire"`, `require`, `req/**\/uire` and `global[p]` all slip past
 * it. Module resolution is still safe (everything funnels through
 * sandboxedRequire), but `process` is a genuine Node global, so
 * `global["proc"+"ess"].env.DATABASE_URL` would otherwise read every secret
 * in the container no matter how clever the scanner got.
 *
 * Passing these as PARAMETERS to `new Function` shadows them lexically for
 * the whole bundle. Scope resolution is not string-addressable, so there is
 * no concatenation trick that reaches around it. Nothing legitimate is lost:
 * only the composition and its relative shims are bundled here — react,
 * recharts and friends stay external and keep their own module scope with
 * the real globals.
 */
export const SHADOWED_GLOBALS = ["process", "global", "globalThis"] as const;

/** Argument list for `new Function(...)` — names then the guarded require. */
export const shadowedFunctionArgs = (): string[] => [
  "module",
  "exports",
  "require",
  ...SHADOWED_GLOBALS,
];

/** Values to apply for the shadowed names (all undefined). */
export const shadowedValues = (): undefined[] => SHADOWED_GLOBALS.map(() => undefined);

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
