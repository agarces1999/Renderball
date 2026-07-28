/**
 * Regression tests for the blank document — specifically for the bug that
 * broke "New document" for every signed-in user in production.
 *
 * WHAT HAPPENED. The brief was built inline at the call site behind
 * `as Parameters<typeof saveBrief>[0]`. That cast satisfied the compiler while
 * omitting four REQUIRED `StoredBrief` fields. One of them was `created_at`,
 * and `pgSaveBrief` does `new Date(brief.created_at)` — so the missing value
 * became `new Date(undefined)`, an Invalid Date, which Prisma rejects outright
 * ("Provided Date object is invalid"). Every create threw, and the route had no
 * try/catch, so the browser showed a bare HTTP 500.
 *
 * WHY NOTHING CAUGHT IT. The cast is the whole story: `tsc` was green because
 * the assertion told it to be, and no test constructed the object. So these
 * tests assert the two things a type assertion can defeat — that the required
 * fields are actually PRESENT, and that `created_at` survives the exact
 * `new Date(...)` round trip the Postgres backend performs on it.
 */
import { blankBrief, blankScript, isBlankScript } from "./blank-document";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

const run = () => {
  console.log("blank-document");

  check("created_at survives pgSaveBrief's `new Date(...)` — THE production bug", () => {
    const brief = blankBrief("B", "owner-1", "S");
    assert(typeof brief.created_at === "string", "created_at must be a string");
    // This is verbatim what lib/store.ts pgSaveBrief computes on the create path.
    const asDate = new Date(brief.created_at);
    assert(!Number.isNaN(asDate.getTime()), "created_at produced an Invalid Date — Prisma rejects this");
  });

  check("every required StoredBrief field is present, not merely typed", () => {
    const brief = blankBrief("B", "owner-1", "S") as unknown as Record<string, unknown>;
    // Required per `StoredBrief` (lib/store.ts). Checked by VALUE because a
    // cast can make the compiler agree the field exists when it does not.
    for (const field of ["id", "owner_id", "purpose", "duration_seconds", "moments", "cta", "created_at", "status"]) {
      assert(brief[field] !== undefined, `required field '${field}' is missing`);
    }
  });

  check("collection fields are empty, not absent (callers read .length/.map)", () => {
    const brief = blankBrief("B", "owner-1", "S");
    assert(Array.isArray(brief.moments) && brief.moments.length === 0, "moments must be an empty array");
    assert(brief.cta === "", "cta must be an empty string");
  });

  check("ids and status are wired through", () => {
    const brief = blankBrief("brief-1", "owner-1", "script-1");
    assert(brief.id === "brief-1", "brief id not set");
    assert(brief.owner_id === "owner-1", "owner not set");
    assert(brief.script_id === "script-1", "script_id not set — the editor opens on this");
    assert(brief.status === "awaiting_agent_1", "status must be a legal BriefStatus");
    assert(brief.kind === "deck", "blank documents are decks");
  });

  check("duration tracks page count", () => {
    assert(blankBrief("B", "o", "S", 1).duration_seconds === 5, "1 page");
    assert(blankBrief("B", "o", "S", 6).duration_seconds === 30, "6 pages");
  });

  check("a freshly created document reads as blank (drives the empty state)", () => {
    assert(isBlankScript(blankScript("S", 3)), "blank script must report blank");
  });

  check("a script with content does not read as blank", () => {
    const filled = blankScript("S", 1);
    filled.scenes[0].visual_concept = "a chart";
    assert(!isBlankScript(filled), "a script with content must not report blank");
  });

  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
};

run();
