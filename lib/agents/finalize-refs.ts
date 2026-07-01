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
//
import {
  addMissingLucideImports,
  stubUndefinedComponents,
  repairInvalidLucideImports,
} from "./quality-gates";

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

/**
 * Run the full undefined-reference net on a composition string. Idempotent — safe
 * to run on an already-finalized composition (a piece regen re-runs it on the whole
 * file). Returns the repaired code plus what it touched, for logging.
 */
export const finalizeUndefinedRefs = async (
  code: string,
): Promise<{ code: string; added: string[]; stubbed: string[]; neutralized: string[] }> => {
  const lucide = await lucideIconNameSet();
  const isIcon = (n: string) => lucide.has(n);

  const add = addMissingLucideImports(code, isIcon);
  let out = add.code;

  const stub = stubUndefinedComponents(out, isIcon);
  out = stub.code;

  const neutralized = assessInvalidLucideImports(out);
  out = repairInvalidLucideImports(out, neutralized);

  return { code: out, added: add.added, stubbed: stub.stubbed, neutralized };
};
