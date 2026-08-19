/**
 * Marker expansion: the fill agent (under RB_PIECE_SPEC=on) may emit
 *   {/* @rb-spec {"piece":"statTile","variant":"iconled",...} *\/}
 * inside its own positioned wrapper. This pass replaces each marker with
 * deterministically compiled TSX themed by the deck's real tokens.
 *
 * Fail-open by design: an unparseable or unknown spec leaves the comment in
 * place (a JSX comment renders as nothing) and is reported, never thrown —
 * the deck ships freeform exactly as before the flag existed.
 */
import { parsePieceSpec } from "./spec";
import {
  compilePieceSpec,
  resolveDeckTokens,
  SPEC_ICON_DEPS,
  ICON_VARIANTS,
} from "./compile";
import { recordVariantUse } from "./telemetry";

const MARKER = /\{\s*\/\*\s*@rb-spec\s+(\{[\s\S]*?\})\s*\*\/\s*\}/g;

export interface ExpandResult {
  code: string;
  expanded: number;
  skipped: { raw: string; reason: string }[];
}

/** Ensure the lucide import carries the icon names compiled pieces use. */
const ensureIconImports = (code: string, needed: string[]): string => {
  if (needed.length === 0) return code;
  const m = code.match(/import\s*\{([\s\S]*?)\}\s*from\s*["']lucide-react["']/);
  if (!m) return code; // no lucide import — expander already refused icon variants
  const present = new Set(m[1].split(",").map((s) => s.trim()).filter(Boolean));
  const missing = needed.filter((n) => !present.has(n));
  if (missing.length === 0) return code;
  const inner = m[1].replace(/\s+$/, "");
  const patched = m[0].replace(m[1], `${inner}, ${missing.join(", ")} `);
  return code.replace(m[0], patched);
};

export const expandSpecMarkers = (
  code: string,
  opts?: { scriptId?: string },
): ExpandResult => {
  const skipped: ExpandResult["skipped"] = [];
  let expanded = 0;
  const hasLucide = /from\s*["']lucide-react["']/.test(code);
  const tokens = resolveDeckTokens(code);
  const usedIcons = new Set<string>();

  const out = code.replace(MARKER, (whole, json: string) => {
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch {
      skipped.push({ raw: json.slice(0, 120), reason: "invalid JSON" });
      return whole;
    }
    const spec = parsePieceSpec(raw);
    if (!spec) {
      skipped.push({ raw: json.slice(0, 120), reason: "unknown piece/shape" });
      return whole;
    }
    const needsIcons = ICON_VARIANTS.has(spec.variant);
    if (needsIcons && !hasLucide) {
      skipped.push({ raw: json.slice(0, 120), reason: `variant "${spec.variant}" needs lucide import` });
      return whole;
    }
    if (needsIcons) for (const dep of SPEC_ICON_DEPS) usedIcons.add(dep);
    expanded++;
    recordVariantUse(spec.piece, spec.variant, opts?.scriptId);
    return compilePieceSpec(spec, tokens);
  });

  return {
    code: ensureIconImports(out, [...usedIcons]),
    expanded,
    skipped,
  };
};
