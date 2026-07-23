//
// Canonical undefined-reference finalize net — shared by the build pipeline and
// the M2 element editor. A generated (or regenerated) composition can reference a
// name that isn't actually in scope: a lucide icon it forgot to import (<Camera/>
// used but not imported → runtime "Element type is invalid"), a brand logo lucide
// doesn't ship (Slack/Figma/... → undefined), or a genuinely invented/mis-scoped
// component. esbuild's syntax transform (verifyCompilable) does NOT resolve these —
// it passes on undefined identifiers — so they must be repaired deterministically
// before the composition is rendered.
//
// finalizeUndefinedRefs runs the exact same three repairs the main build uses:
//   1. add missing valid lucide imports          (<Camera/> → import it)
//   2. null-stub invented/mis-scoped components   (<Thumb/> → const Thumb = () => null)
//   3. neutralize invalid brand-logo lucide names (Slack/... → dropped from import)
//   4. (opt-in, `opts.script`) stub undefined VALUE identifiers — a piece body
//      that maps/indexes data it never defined (`rows.map(...)` with no `rows`
//      anywhere: the 01KY86J312SRPDXY6D58MSXJ81 s2.hero class). Repairs 1–3 only
//      cover JSX component tags, so this class compiled clean and threw
//      `ReferenceError: rows is not defined` at SSR, blanking the whole scene.
//      Detection is RUNTIME TRUTH, not static analysis: the composition is
//      SSR'd per Section (renderSectionsForAnalysis — esbuild + react-dom,
//      both runtime deps) and V8's own ReferenceError names the identifier.
//      Zero false positives by construction; needs the script (Section prop),
//      which is why it is opt-in — callers without one (the editor's commit
//      barrier, which is latency-budgeted) keep the exact old behavior.
//
import {
  addMissingLucideImports,
  stubUndefinedComponents,
  repairInvalidLucideImports,
} from "./quality-gates";
import { renderSectionsForAnalysis } from "../render/density-gates";

/**
 * Brand/company names the agent reaches for as lucide-react icons — which lucide
 * DOES NOT include (it removed all brand logos). Importing any of these from
 * "lucide-react" yields `undefined` and crashes the render at runtime ("Element
 * type is invalid") while compiling cleanly. Brand logos must come from
 * `simple-icons` instead.
 */
const INVALID_LUCIDE_BRANDS = new Set([
  "Slack", "Figma", "Trello", "Notion", "Github", "GitHub", "Gitlab", "GitLab",
  "Twitter", "Linkedin", "LinkedIn", "Youtube", "YouTube", "Facebook",
  "Instagram", "Discord", "Twitch", "Dribbble", "Behance", "Codepen", "CodePen",
  "Framer", "Stripe", "Spotify", "Airbnb", "Dropbox", "Salesforce", "Hubspot",
  "HubSpot", "Zoom", "Google", "Apple", "Microsoft", "Amazon", "Meta", "Tiktok",
  "TikTok", "Snapchat", "Pinterest", "Reddit", "Whatsapp", "WhatsApp", "Telegram",
  "Chrome", "Firefox", "Safari", "Atlassian", "Jira", "Asana", "Airtable",
  "Vercel", "Netlify", "Mongodb", "MongoDB", "Datadog", "Twilio", "Snowflake",
  "Intercom", "Shopify", "Canva", "Linear", "Trello",
]);

/**
 * The set of real lucide-react icon names (~5,800 PascalCase exports), loaded
 * lazily + memoized server-side. Used to decide whether an undefined JSX tag is a
 * recoverable missing-import (add it) vs a genuinely-invented component (leave for
 * the render gate). Defensive: any load failure → empty set → the auto-import is a
 * no-op (never worse than today).
 */
let _lucideIconNames: Set<string> | null = null;
export const lucideIconNameSet = async (): Promise<Set<string>> => {
  if (_lucideIconNames) return _lucideIconNames;
  try {
    const mod = (await import("lucide-react")) as Record<string, unknown> & {
      default?: Record<string, unknown>;
    };
    const keys = [...Object.keys(mod.default ?? {}), ...Object.keys(mod)];
    _lucideIconNames = new Set(keys.filter((k) => /^[A-Z][A-Za-z0-9]*$/.test(k)));
  } catch {
    _lucideIconNames = new Set();
  }
  return _lucideIconNames;
};

/**
 * Scan a composition's `lucide-react` named imports and return any that are brand
 * logos (not real lucide exports). Pure string match — reliable in any runtime.
 */
export const assessInvalidLucideImports = (code: string): string[] => {
  const m = code.match(/import\s*\{([^}]*)\}\s*from\s*["']lucide-react["']/);
  if (!m) return [];
  const names = m[1]
    .split(",")
    .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
    .filter(Boolean);
  return names.filter((n) => INVALID_LUCIDE_BRANDS.has(n));
};

/** One undefined VALUE identifier found (and stubbed) at SSR time, with the
 *  scenes whose render threw on it — the loop routes a regen to the owning
 *  piece(s) of those scenes so the stub is a bridge, not the end state. */
export interface UndefinedValueStub {
  name: string;
  scenes: number[];
}

/**
 * Names never auto-stubbed. A ReferenceError naming one of these means the
 * harness/runtime itself is broken, not that the model forgot to inline an
 * array — and shadowing a real runtime binding with a stub could break healthy
 * code. These fall through to the fail-closed SSR gate instead.
 */
const VALUE_STUB_BLOCKLIST = new Set([
  "require", "module", "exports", "process", "global", "globalThis",
  "window", "document", "navigator", "React",
]);

/** V8's ReferenceError message shape, as surfaced by renderSectionsForAnalysis
 *  ("render: rows is not defined" / "compile/eval: ReferenceError: …"). */
const NOT_DEFINED_RX = /\b([A-Za-z_$][A-Za-z0-9_$]*) is not defined\b/;

export const undefinedNameFromRenderError = (error: string | undefined): string | null => {
  const m = NOT_DEFINED_RX.exec(error ?? "");
  if (!m || VALUE_STUB_BLOCKLIST.has(m[1])) return null;
  return m[1];
};

/** Each stub pass SSRs every Section once; a stub can unmask the NEXT throw in
 *  the same scene (render stops at the first), so iterate — bounded. */
const MAX_VALUE_STUB_PASSES = 4;

/**
 * Repair #4: neutralize undefined VALUE identifiers by runtime truth. SSR each
 * Section; every `X is not defined` gets a module-scope stub appended — `[]`
 * (renders empty, `.map`/property-access/JSX-child all safe) or `() => null`
 * when the name is used as a JSX tag. `var` so hoisting rules out any TDZ
 * ordering hazard. Defensive: a harness failure returns the input unchanged
 * (never worse than today); non-ReferenceError render failures are left for
 * the measure-error → re-cast route and the fail-closed SSR gate.
 */
export const stubUndefinedValueRefs = (
  code: string,
  script: unknown,
): { code: string; valueStubbed: UndefinedValueStub[] } => {
  const valueStubbed: UndefinedValueStub[] = [];
  const seen = new Set<string>();
  let out = code;
  for (let pass = 0; pass < MAX_VALUE_STUB_PASSES; pass++) {
    let renders: { scene: number; error?: string }[];
    try {
      renders = renderSectionsForAnalysis(out, script);
    } catch {
      return { code: out, valueStubbed };
    }
    const found = new Map<string, number[]>();
    for (const r of renders) {
      const name = undefinedNameFromRenderError(r.error);
      if (!name || seen.has(name)) continue;
      found.set(name, [...(found.get(name) ?? []), r.scene]);
    }
    if (found.size === 0) break;
    const lines: string[] = [];
    for (const [name, scenes] of found) {
      seen.add(name);
      valueStubbed.push({ name, scenes });
      lines.push(
        new RegExp(`<${name.replace(/\$/g, "\\$")}[\\s/>]`).test(out)
          ? `var ${name}: any = () => null;`
          : `var ${name}: any = [];`,
      );
    }
    out = `${out}\n/* auto-stubbed: undefined value identifiers render empty so SSR can't hard-fail */\n${lines.join("\n")}\n`;
  }
  return { code: out, valueStubbed };
};

/**
 * Run the full undefined-reference net on a composition string. Idempotent — safe
 * to run on an already-finalized composition (a piece regen re-runs it on the whole
 * file). Returns the repaired code plus what it touched, for logging.
 * `opts.script` opts in to repair #4 (undefined value identifiers) — it is the
 * Section render prop, so without it every Section throws on `script.scenes`
 * before reaching the piece bodies and the pass would see nothing.
 */
export const finalizeUndefinedRefs = async (
  code: string,
  opts?: { script?: unknown },
): Promise<{
  code: string;
  added: string[];
  stubbed: string[];
  neutralized: string[];
  valueStubbed: UndefinedValueStub[];
}> => {
  const lucide = await lucideIconNameSet();
  const isIcon = (n: string) => lucide.has(n);

  const add = addMissingLucideImports(code, isIcon);
  let out = add.code;

  const stub = stubUndefinedComponents(out, isIcon);
  out = stub.code;

  const neutralized = assessInvalidLucideImports(out);
  out = repairInvalidLucideImports(out, neutralized);

  // #4 runs LAST: components/icons are already resolved above, so every
  // remaining ReferenceError is a genuine value identifier.
  let valueStubbed: UndefinedValueStub[] = [];
  if (opts?.script !== undefined) {
    const v = stubUndefinedValueRefs(out, opts.script);
    out = v.code;
    valueStubbed = v.valueStubbed;
  }

  return { code: out, added: add.added, stubbed: stub.stubbed, neutralized, valueStubbed };
};
