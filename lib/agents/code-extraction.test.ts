/**
 * Regression tests for stripCodeFence + verifyCompilable.
 *
 * Run: `npm test` (compiles + runs via scripts/run-tests.mjs — no test runner
 * dep, no API key, no credits). These lock the fix for the Liquid Death build
 * bug where the Opus agent prepended an UNFENCED prose preamble above the
 * imports, the old stripper left it, esbuild died, and the build still
 * reported ok:true.
 */
import {
  stripCodeFence,
  verifyCompilable,
  repairCompile,
  elideDataUris,
  elideDataUrisOutsideSection,
} from "./code-extraction";
import { sectionRange } from "./section-splice";

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

// ── repairCompile: pure loop logic, fully mocked (no model spend) ──────

// 8. Already compiles → never calls fix, attempts 0, returns input verbatim.
check("repairCompile: clean code short-circuits (0 attempts, no fix call)", async () => {
  let fixCalls = 0;
  const out = await repairCompile(
    VALID_COMP,
    async () => null, // verify: always compiles
    async (c) => {
      fixCalls++;
      return c;
    },
  );
  assert(out.attempts === 0, `expected 0 attempts, got ${out.attempts}`);
  assert(fixCalls === 0, "fix must not be called when code already compiles");
  assert(out.error === null, "error must be null");
  assert(out.code === VALID_COMP, "clean code must pass through unchanged");
});

// 9. One real defect → fix repairs it → verify passes on attempt 1.
check("repairCompile: error-then-fixed converges in 1 attempt", async () => {
  let verifyCount = 0;
  const out = await repairCompile(
    "BROKEN",
    async (c) => {
      verifyCount++;
      // First verify (the input) fails; after fix produced FIXED, it passes.
      return c === "FIXED" ? null : "Expected \";\"";
    },
    async () => "FIXED",
  );
  assert(out.attempts === 1, `expected 1 attempt, got ${out.attempts}`);
  assert(out.error === null, "must compile after the fix");
  assert(out.code === "FIXED", "must return the repaired code");
  assert(verifyCount === 2, `expected 2 verifies (initial + post-fix), got ${verifyCount}`);
});

// 10. Fixer keeps producing non-compiling output → stops at maxAttempts,
//     returns the residual error (build then fails as it does today).
check("repairCompile: never-compiles exhausts maxAttempts and returns error", async () => {
  let fixCalls = 0;
  const out = await repairCompile(
    "BROKEN",
    async () => "still broken", // verify: never passes
    async (c) => {
      fixCalls++;
      return c + ".";
    },
    2,
  );
  assert(out.attempts === 2, `expected 2 attempts (the cap), got ${out.attempts}`);
  assert(fixCalls === 2, `fix should be called exactly maxAttempts times, got ${fixCalls}`);
  assert(out.error === "still broken", "residual error must surface for the caller to fail on");
});

// 11. Fixer gives up (returns null) → loop stops immediately, no re-verify
//     of unchanged input, original error preserved.
check("repairCompile: fix returning null stops the loop early", async () => {
  let verifyCount = 0;
  const out = await repairCompile(
    "BROKEN",
    async () => {
      verifyCount++;
      return "syntax error";
    },
    async () => null, // fixer can't help
    5,
  );
  assert(out.attempts === 1, `expected 1 attempt before giving up, got ${out.attempts}`);
  assert(verifyCount === 1, `must not re-verify after fix gives up, got ${verifyCount} verifies`);
  assert(out.error === "syntax error", "original error must be preserved");
  assert(out.code === "BROKEN", "code must be unchanged when fix gives up");
});

// 12. End-to-end with the REAL verifyCompilable: a stray '>' (the exact
//     mechanical-failure class #2 targets) is repaired by a trivial fixer.
check("repairCompile: real verifyCompilable + stray-char fixer", async () => {
  const broken = VALID_COMP.replace("<h1>{title}</h1>", "<h1>{title}</h1>>");
  assert((await verifyCompilable(broken)) !== null, "stray '>' must not compile");
  const out = await repairCompile(
    broken,
    verifyCompilable,
    async () => VALID_COMP, // a real fixer would re-emit the corrected file
  );
  assert(out.error === null, "must compile after repair");
  assert(out.attempts === 1, `expected 1 attempt, got ${out.attempts}`);
});

// ── elideDataUris (prompt-context token-waste eliding) ──────────────────────
const B64 = "A".repeat(400);
check("elideDataUris: replaces a long base64 payload, keeps the mime prefix", () => {
  const code = `const LOGO_SRC = "data:image/svg+xml;base64,${B64}";`;
  const out = elideDataUris(code);
  assert(!out.includes(B64), "payload should be gone");
  assert(out.includes("data:image/svg+xml;base64,<base64 elided"), `prefix kept: ${out.slice(0, 80)}`);
  assert(out.length < code.length / 3, "should shrink dramatically");
});

check("elideDataUris: leaves short data-URIs + normal code untouched", () => {
  const code = `const A = "data:image/png;base64,iVBORw0KGgo="; const b = atob("${"B".repeat(200)}");`;
  assert(elideDataUris(code) === code, "short URI + non-URI base64-ish strings untouched");
});

check("elideDataUrisOutsideSection: preserves the target section verbatim", () => {
  const code = [
    `import React from "react";`,
    `const LOGO_SRC = "data:image/svg+xml;base64,${B64}";`,
    `export const Section0: React.FC = () => <img src="data:image/png;base64,${B64}" />;`,
    `export const Section1: React.FC = () => <div>one</div>;`,
  ].join("\n");
  const out = elideDataUrisOutsideSection(code, sectionRange, 0);
  // module-const URI (outside Section0) elided; Section0's inline URI preserved
  const s0 = out.slice(out.indexOf("Section0"), out.indexOf("Section1"));
  assert(s0.includes(B64), "target section's inline data-URI must survive");
  assert(!out.slice(0, out.indexOf("Section0")).includes(B64), "module-const URI must be elided");
});

check("elideDataUrisOutsideSection: missing section → elides everywhere", () => {
  const code = `const X = "data:image/png;base64,${B64}"; // no sections here`;
  const out = elideDataUrisOutsideSection(code, sectionRange, 3);
  assert(!out.includes(B64), "falls back to whole-text elide");
});

await Promise.all(checks);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
