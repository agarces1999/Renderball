// The judgement layer, kept apart from the runner so selftest.mjs can attack it
// without touching the network.
import { rgbDistance, deltaE2000, bandOf } from "./color.mjs";

// Words that describe a CUT of a face, not a different face. "Monzo Sans Text"
// and "Monzo Sans Display" are the same brand voice; "Geist" and "Geist Pixel
// Grid" are not, which is why "pixel"/"grid" are deliberately absent here.
const QUALIFIERS = [
  "text", "display", "sans", "serif", "mono", "tight", "condensed", "extended",
  "bold", "book", "medium", "regular", "light", "semibold", "black", "roman",
  "title", "heading", "body", "new", "next", "neue",
];
// Foundry/format noise carried in @font-face family names.
const STRIP_SUFFIX = /(?:variable|var|vf|websubset|web|subset|fallback|font|std|pro|lt)$/;

export const normFont = (name) => {
  let s = String(name ?? "")
    .toLowerCase()
    .replace(/["']/g, "")
    .replace(/[^a-z0-9]/g, "");
  for (let i = 0; i < 3; i++) {
    const next = s.replace(STRIP_SUFFIX, "");
    if (next === s) break;
    s = next;
  }
  return s;
};

const leftoverIsBenign = (leftover, host) => {
  if (!leftover) return true;
  let rest = leftover;
  const brand = String(host ?? "").split(".")[0].replace(/[^a-z0-9]/g, "");
  if (brand && rest.includes(brand)) rest = rest.split(brand).join("");
  let changed = true;
  while (changed && rest) {
    changed = false;
    for (const q of QUALIFIERS) {
      if (rest.startsWith(q)) {
        rest = rest.slice(q.length);
        changed = true;
      } else if (rest.endsWith(q)) {
        rest = rest.slice(0, -q.length);
        changed = true;
      }
    }
  }
  return rest === "";
};

/**
 * The stem left when every trailing cut-qualifier is removed. Needed because
 * two SIBLING cuts contain neither each other's name: the selftest caught
 * "MonzoSansText" vs "MonzoSansDisplay" scoring WRONG under containment alone,
 * which would have marked a correct read as a failure on the baseline.
 */
const stemOf = (norm) => {
  let s = norm,
    changed = true;
  while (changed && s) {
    changed = false;
    for (const q of QUALIFIERS) {
      if (s.length > q.length && s.endsWith(q)) {
        s = s.slice(0, -q.length);
        changed = true;
      }
    }
  }
  return s;
};

export const scoreFont = (picked, truth, host) => {
  if (!truth) return { band: "UNSCORED" };
  if (!picked) return { band: "MISSING" };
  const p = normFont(picked),
    t = normFont(truth);
  if (!p || !t) return { band: "MISSING" };
  if (p === t) return { band: "EXACT" };
  const [long, short] = p.length >= t.length ? [p, t] : [t, p];
  if (short && long.includes(short)) {
    if (leftoverIsBenign(long.split(short).join(""), host)) return { band: "NEAR" };
  }
  const sp = stemOf(p),
    st = stemOf(t);
  if (sp.length >= 3 && sp === st) return { band: "NEAR" };
  return { band: "WRONG" };
};

/**
 * An achromatic brand scores on a different axis on purpose: there is no
 * distance to a colour that does not exist, so the only question is whether the
 * picker had the discipline to return nothing.
 */
export const scoreAccent = (picked, row) => {
  if (row.achromatic) {
    return picked ? { band: "INVENTED", d: null, de: null } : { band: "CORRECT-NONE", d: null, de: null };
  }
  if (!picked) return { band: "MISSING", d: null, de: null };
  const d = rgbDistance(picked, row.accent);
  if (d === null) return { band: "MISSING", d: null, de: null };
  return { band: bandOf(d), d, de: deltaE2000(picked, row.accent) };
};

export const HIT_BANDS = new Set(["EXACT", "NEAR", "CORRECT-NONE"]);
export const STRICT_BANDS = new Set(["EXACT", "CORRECT-NONE"]);
