//
// Lift a washed-out PALETTE token — safely, or not at all.
//
// WHY A TOKEN AND NOT AN ELEMENT. Measured across the stored corpus: 752 of 826 text
// colours in piece bodies are written as `PALETTE.something`, only 74 as a literal
// hex. So "darken this one label" is not expressible at the element — the colour is
// not there to patch. The colour lives once, in the preamble, and every use points at
// it.
//
// WHY THAT IS DANGEROUS. Darkening PALETTE.slate fixes the slate label on a white
// panel and RUINS the slate label on a dark one: contrast is relative to whatever
// each node sits on. A token lift is a global edit justified by one local failure —
// exactly the shape of repair that docs/SPATIAL_QUALITY.md warns manufactures
// defects, and the same trap the washout-lift fell into when it painted ink onto a
// sparse panel and turned emptiness into a black monolith.
//
// THE GUARD. The contrast gate already visits EVERY text node and samples the surface
// behind each one; it simply discarded the passing ones. Keeping them makes the safety
// question pure arithmetic with no extra measurement: for a candidate lift, check the
// new colour against the backdrop of every node that uses it. If any node would end up
// worse than it is now, and not comfortably clean, the lift is refused. A refusal
// still yields the exact target hex, so the regen path can be told what to aim at
// instead of "make it darker".
//
// Founder case, 2026-08-22: a deck shipped { fg: "#64748b", bg: "#f1f5f9", ratio: 4.3 }
// and the report was "the element on the right is bad on visibility". That deck's
// preamble reads `slate: "#64748b"`. This is the repair for that.
//
import { contrastRatio, MIN_CONTRAST_RATIO } from "../agents/contrast";
import { liftTextColor } from "./text-contrast-lift";

/** One measured text node, whatever its ratio. */
export interface InkSample {
  scene: number;
  pieceId: string;
  /** The effective text colour as `#rrggbb`. */
  ink: string;
  /** The sampled local backdrop as `#rrggbb`. */
  backdrop: string;
  /** WCAG ratio of ink vs backdrop, as measured. */
  ratio: number;
}

export interface PaletteEntry {
  token: string;
  hex: string;
}

export type LiftVerdict =
  | { safe: true; token: string; from: string; to: string; improved: number; unchanged: number }
  | { safe: false; token: string; from: string; to: string | null; reason: string };

/**
 * Parse `const PALETTE = { name: "#hex", ... }` out of a scaffold preamble.
 *
 * Deliberately strict: only a flat object of quoted hex strings. Anything else — a
 * computed value, a nested object, a colour that is not a plain hex — is skipped
 * rather than guessed at, because the patcher writes back by exact-string replacement
 * and a wrong parse there rewrites the wrong thing.
 */
export const parsePalette = (preamble: string): PaletteEntry[] => {
  const block = /const\s+PALETTE\s*=\s*\{([\s\S]*?)\}\s*as\s+const\s*;/.exec(preamble);
  if (!block) return [];
  const out: PaletteEntry[] = [];
  const rx = /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*"(#[0-9a-fA-F]{3,8})"/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(block[1])) !== null) out.push({ token: m[1], hex: m[2] });
  return out;
};

/** Normalise `#abc` → `#aabbcc`, lowercase, for comparing measured ink to palette. */
export const normaliseHex = (hex: string): string => {
  const h = hex.trim().toLowerCase();
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(h);
  if (!m) return h;
  return m[1].length === 3 ? "#" + m[1].split("").map((c) => c + c).join("") : h;
};

/**
 * Decide whether a token can be darkened/lightened to clear AA for the node that
 * failed, WITHOUT pushing any other node that uses it below the line.
 *
 * `samples` must be EVERY measured node, not just the failing ones — the whole point
 * is to see the nodes a naive lift would break. A token with no samples is refused:
 * silence is not evidence of safety.
 */
export const judgeTokenLift = (
  entry: PaletteEntry,
  samples: InkSample[],
  target: number = MIN_CONTRAST_RATIO,
): LiftVerdict => {
  const hex = normaliseHex(entry.hex);
  const users = samples.filter((s) => normaliseHex(s.ink) === hex);
  if (users.length === 0) {
    return { safe: false, token: entry.token, from: entry.hex, to: null, reason: "no measured node uses this colour" };
  }
  const failing = users.filter((s) => s.ratio < target);
  if (failing.length === 0) {
    return { safe: false, token: entry.token, from: entry.hex, to: null, reason: "nothing failing" };
  }

  // Lift against the WORST offender's backdrop — clearing that one clears the rest on
  // similar surfaces, and aiming at a milder case would leave the worst still failing.
  const worst = failing.reduce((a, b) => (a.ratio <= b.ratio ? a : b));
  const lift = liftTextColor(hex, normaliseHex(worst.backdrop), target);
  if (!lift.changed) {
    return { safe: false, token: entry.token, from: entry.hex, to: null, reason: lift.reason ?? "no lift available" };
  }

  // THE GUARD. Every node using this token, re-scored against its OWN backdrop.
  let improved = 0;
  let unchanged = 0;
  for (const s of users) {
    const after = contrastRatio(lift.color, normaliseHex(s.backdrop));
    if (after >= target) {
      if (after > s.ratio) improved++;
      else unchanged++;
      continue;
    }
    // Below the line after the lift. Tolerable ONLY if it was already below and did
    // not get worse — a node we failed to rescue is not a node we broke.
    if (after >= s.ratio - 0.01) {
      unchanged++;
      continue;
    }
    return {
      safe: false,
      token: entry.token,
      from: entry.hex,
      to: lift.color,
      reason:
        `would push s${s.scene}/${s.pieceId} from ${s.ratio.toFixed(2)} to ${after.toFixed(2)} ` +
        `on its own backdrop ${normaliseHex(s.backdrop)}`,
    };
  }
  return { safe: true, token: entry.token, from: entry.hex, to: lift.color, improved, unchanged };
};

export interface PaletteLiftEvent {
  token: string;
  from: string;
  to: string | null;
  applied: boolean;
  /** Nodes that get better; nodes already clean that stay clean. */
  improved?: number;
  unchanged?: number;
  /** Why it was refused, when `applied` is false. */
  reason?: string;
}

/**
 * Lift every palette token that a measured text node fails on, where the guard
 * permits it, and persist the result.
 *
 * Returns one event per candidate token — applied or refused, with the reason and the
 * hex it wanted either way. A refusal is a normal outcome, not an error: the exact
 * target colour goes into the build log so the regen path can aim at a number instead
 * of "make it darker", which is the whole reason the advisory band kept shipping dim
 * text in the first place.
 *
 * Zero tokens, zero model calls, one file write. Nothing here can block a build: any
 * failure degrades to an event with a reason.
 */
export const liftWashedPaletteTokens = async (
  genDir: string,
  samples: InkSample[],
  deps: {
    readManifest: (g: string) => Promise<{ preamble: string }>;
    writeManifest: (g: string, m: never) => Promise<void>;
    commit: (g: string, msg: string) => Promise<{ ok: boolean; error?: string }>;
  },
  target: number = MIN_CONTRAST_RATIO,
): Promise<PaletteLiftEvent[]> => {
  const events: PaletteLiftEvent[] = [];
  if (samples.length === 0) return events;

  const manifest = (await deps.readManifest(genDir)) as { preamble: string };
  let preamble = manifest.preamble ?? "";
  const palette = parsePalette(preamble);
  if (palette.length === 0) return events;

  // Only tokens some node actually FAILS on are candidates — a token that is merely
  // present is none of our business.
  const failingInks = new Set(samples.filter((s) => s.ratio < target).map((s) => normaliseHex(s.ink)));
  let changed = false;
  for (const entry of palette) {
    if (!failingInks.has(normaliseHex(entry.hex))) continue;
    const verdict = judgeTokenLift(entry, samples, target);
    if (!verdict.safe) {
      events.push({ token: entry.token, from: entry.hex, to: verdict.to, applied: false, reason: verdict.reason });
      continue;
    }
    const patched = patchPaletteToken(preamble, entry.token, entry.hex, verdict.to);
    if (!patched) {
      events.push({
        token: entry.token, from: entry.hex, to: verdict.to, applied: false,
        reason: "could not anchor the token uniquely in the preamble",
      });
      continue;
    }
    preamble = patched;
    changed = true;
    events.push({
      token: entry.token, from: entry.hex, to: verdict.to, applied: true,
      improved: verdict.improved, unchanged: verdict.unchanged,
    });
  }

  if (changed) {
    // Write the manifest, THEN commit — commit is what reassembles and rewrites
    // Composition.tsx, which is the file the preview and renderer read. Writing the
    // manifest alone would change the store and leave the render untouched, the
    // failure mode this codebase keeps rediscovering.
    await deps.writeManifest(genDir, { ...manifest, preamble } as never);
    const res = await deps.commit(genDir, "palette contrast lift");
    if (!res.ok) {
      for (const e of events) if (e.applied) { e.applied = false; e.reason = `commit failed: ${res.error}`; }
    }
  }
  return events;
};

/**
 * Rewrite one token's hex in the preamble.
 *
 * Anchored on `token: "hex"` inside the PALETTE block so a hex that also appears
 * elsewhere in the scaffold — a gradient stop, a shadow — is not swept up. Returns
 * null if the anchor is not found exactly once, because a repair that cannot identify
 * its target must not proceed.
 */
export const patchPaletteToken = (
  preamble: string,
  token: string,
  from: string,
  to: string,
): string | null => {
  const anchor = new RegExp(`(\\b${token}\\s*:\\s*")${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(")`, "gi");
  const hits = preamble.match(anchor);
  if (!hits || hits.length !== 1) return null;
  return preamble.replace(anchor, `$1${to}$2`);
};
