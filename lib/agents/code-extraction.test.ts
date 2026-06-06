/**
 * Regression tests for stripCodeFence + verifyCompilable.
 *
 * Run: `npm test` (compiles + runs via scripts/run-tests.mjs — no test runner
 * dep, no API key, no credits). These lock the fix for the Liquid Death build
 * bug where the Opus agent prepended an UNFENCED prose preamble above the
 * imports, the old stripper left it, esbuild died, and the build still
 * reported ok:true.
 */
import { stripCodeFence, verifyCompilable } from "./code-extraction";

// A small but genuinely valid Remotion component. esbuild's `transform` (used
// by verifyCompilable) parses TSX without resolving imports, so the unresolved
// "remotion" import is fine — this is a pure syntax check.
const VALID_COMP = `import React from "react";
import { AbsoluteFill } from "remotion";

export const Section0: React.FC = () => {
  const title = "Murder Your Thirst";
  return (
    <AbsoluteFill style={{ background: "#000", color: "#fff" }}>
      <h1>{title}</h1>
    </AbsoluteFill>
  );
};
`;

// The ACTUAL preamble shape that leaked into Composition.tsx:1 on the LD build.
const LEAKED_PROSE =
  "The dead-air checker reads the actual JSX delays. Note that some of my " +
  "late beats (e.g. Section2's bullets at 3.0s/3.5s/4.0s, Section3's skull " +
  "cascade at 3.2s+) were already present but apparently the validator wants " +
  "them distributed more evenly. I've spread the entrances out below.";

let passed = 0;
let failed = 0;
const checks: Promise<void>[] = [];

const check = (name: string, fn: () => void | Promise<void>) => {
  checks.push(
    (async () => {
      try {
        await fn();
        passed++;
        console.log(`  ✓ ${name}`);
      } catch (err) {
        failed++;
        console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : err}`);
      }
    })(),
  );
};

const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg);
};

const startsClean = (code: string) =>
  /^\s*(?:import[\s{*"']|export\s|['"]use (?:client|strict)['"])/.test(code);

// ── 1. THE BUG: unfenced prose preamble above the imports ──────────────
check("strips an unfenced prose preamble (the LD bug)", async () => {
  const raw = `${LEAKED_PROSE}\n\n${VALID_COMP}`;
  // Raw input does NOT compile — proves the failure is real.
  assert((await verifyCompilable(raw)) !== null, "raw prose-leak should NOT compile");
  const out = stripCodeFence(raw);
  assert(startsClean(out), `expected clean module start, got: ${out.slice(0, 40)}`);
  assert(!out.includes("dead-air checker"), "prose must be gone");
  assert((await verifyCompilable(out)) === null, "stripped output must compile");
});

// ── 2. clean code passes through untouched ─────────────────────────────
check("leaves already-clean code intact + compiling", async () => {
  const out = stripCodeFence(VALID_COMP);
  assert(out.startsWith('import React'), "clean code should be unchanged at the top");
  assert((await verifyCompilable(out)) === null, "clean code must compile");
});

// ── 3. fenced code block (```tsx … ```) ────────────────────────────────
check("extracts a ```tsx fenced block", async () => {
  const raw = "```tsx\n" + VALID_COMP + "\n```";
  const out = stripCodeFence(raw);
  assert(startsClean(out), "fence must be removed");
  assert(!out.includes("```"), "no backticks should remain");
  assert((await verifyCompilable(out)) === null, "must compile");
});

// ── 4. prose BEFORE and AFTER a fenced block ───────────────────────────
check("drops prose around a fenced block", async () => {
  const raw = `Here is the updated component:\n\n\`\`\`tsx\n${VALID_COMP}\n\`\`\`\n\nLet me know if you want changes!`;
  const out = stripCodeFence(raw);
  assert(startsClean(out), "must start clean");
  assert(!out.includes("Let me know"), "trailing prose must be gone");
  assert((await verifyCompilable(out)) === null, "must compile");
});

// ── 5. truncated output: leading fence, no closing fence ───────────────
check("handles an unclosed leading fence (max_tokens truncation)", async () => {
  const raw = "```tsx\n" + VALID_COMP; // no closing ```
  const out = stripCodeFence(raw);
  assert(startsClean(out), "dangling opening fence must be stripped");
  assert((await verifyCompilable(out)) === null, "must compile");
});

// ── 6. a legitimate "use client" directive survives a prose preamble ───
check('preserves a leading "use client" directive', async () => {
  const raw = `Sure — here you go:\n\n"use client";\n${VALID_COMP}`;
  const out = stripCodeFence(raw);
  assert(out.startsWith('"use client"'), "directive must be preserved at the top");
  assert((await verifyCompilable(out)) === null, "must compile");
});

// ── 7. verifyCompilable actually rejects broken syntax ─────────────────
check("verifyCompilable returns an error for unparseable code", async () => {
  const err = await verifyCompilable("export const = ;;; <not valid");
  assert(err !== null, "broken code must report an error");
});

await Promise.all(checks);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
