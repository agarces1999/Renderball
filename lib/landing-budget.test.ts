/**
 * Landing weight tripwire (perf pass, 2026-08-31).
 *
 * The landing performs the product — a scroll-driven story, a live sandbox —
 * and that class of page grows by accretion until it is quietly slow. This is
 * a deliberately crude but deterministic ceiling on the SOURCE feeding the
 * landing bundle: 94.8KB measured at introduction, capped with ~25% headroom.
 * Hitting the ceiling is not a build failure verdict — it is a forced
 * conversation: split it, trim it, or consciously re-ratchet WITH a measured
 * before/after of the shipped page.
 */
import { promises as fs } from "fs";
import path from "path";

const FILES = [
  "app/page.tsx",
  "components/LandingEditor.tsx",
  "components/LandingSandbox.tsx",
  "components/EditorCta.tsx",
  "app/globals.css",
];

/** 94,821 bytes measured 2026-08-31 + headroom. Re-ratchet consciously. */
const CEILING_BYTES = 118_000;

void (async () => {
  let total = 0;
  const rows: string[] = [];
  for (const f of FILES) {
    const st = await fs.stat(path.join(process.cwd(), f)).catch(() => null);
    const size = st?.size ?? 0;
    total += size;
    rows.push(`  ${size.toString().padStart(7)}b  ${f}`);
  }
  const ok = total <= CEILING_BYTES;
  console.log("landing weight tripwire");
  for (const r of rows) console.log(r);
  console.log(
    `  ${ok ? "✓" : "✗"} landing source total ${total}b ${ok ? "within" : "EXCEEDS"} ceiling ${CEILING_BYTES}b`,
  );
  console.log(`${ok ? 1 : 0} passed, ${ok ? 0 : 1} failed`);
  if (!ok) process.exitCode = 1;
})();
