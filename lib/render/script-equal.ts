/**
 * Order-insensitive script equality for the render reuse check.
 *
 * tryReuseGenerated used to compare `JSON.stringify(stored) !==
 * JSON.stringify(live)`. That broke the moment the store flipped to Postgres:
 * Prisma's Json round-trip does not preserve key order, so a byte-identical
 * script re-read from pg stringifies differently than the genDir's script.json
 * written at build time — and EVERY render silently fell through to a full
 * ~45-min, ~$2 rebuild (observed 2026-07-09). Key order is not meaning;
 * compare canonically.
 */

/** Canonical JSON: object keys sorted recursively, undefined-valued keys
 *  dropped (JSON.stringify drops them too, so both sides agree). */
export const stableStringify = (v: unknown): string => {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  const body = Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",");
  return `{${body}}`;
};

/** True when two script values carry the same content, ignoring key order. */
export const scriptsEquivalent = (a: unknown, b: unknown): boolean =>
  stableStringify(a) === stableStringify(b);
