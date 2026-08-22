//
// Arrow nudging and Shift-drag axis lock.
//
import { nudgeFor, constrainToAxis, NUDGE_STEP, NUDGE_STEP_SHIFT } from "./nudge";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

console.log("\n▶ nudge");

check("the four arrows move one document pixel", () => {
  assert(eq(nudgeFor("ArrowLeft", false), { dx: -NUDGE_STEP, dy: 0 }), "left");
  assert(eq(nudgeFor("ArrowRight", false), { dx: NUDGE_STEP, dy: 0 }), "right");
  assert(eq(nudgeFor("ArrowUp", false), { dx: 0, dy: -NUDGE_STEP }), "up");
  assert(eq(nudgeFor("ArrowDown", false), { dx: 0, dy: NUDGE_STEP }), "down");
});

check("Shift moves ten", () => {
  assert(eq(nudgeFor("ArrowLeft", true), { dx: -NUDGE_STEP_SHIFT, dy: 0 }), "shift-left");
  assert(eq(nudgeFor("ArrowDown", true), { dx: 0, dy: NUDGE_STEP_SHIFT }), "shift-down");
});

check("up is NEGATIVE y — screen coordinates, not maths ones", () => {
  // Getting this inverted is the classic version of this bug and it is invisible in
  // code review, because both readings look reasonable.
  assert(nudgeFor("ArrowUp", false)!.dy < 0, "up must decrease y");
  assert(nudgeFor("ArrowDown", false)!.dy > 0, "down must increase y");
});

check("any other key is not a nudge", () => {
  for (const k of ["a", "Enter", "Escape", "Tab", "Delete", "Backspace", " ", "Home", "PageUp"]) {
    assert(nudgeFor(k, false) === null, `${k} must not nudge`);
    assert(nudgeFor(k, true) === null, `Shift+${k} must not nudge`);
  }
});

check("axis lock keeps the dominant axis and zeroes the other", () => {
  assert(eq(constrainToAxis(40, 3), { dx: 40, dy: 0 }), "mostly horizontal");
  assert(eq(constrainToAxis(3, -40), { dx: 0, dy: -40 }), "mostly vertical");
  assert(eq(constrainToAxis(-40, 3), { dx: -40, dy: 0 }), "sign is preserved");
});

check("an exact diagonal still yields a single axis", () => {
  const r = constrainToAxis(25, 25);
  assert((r.dx === 0) !== (r.dy === 0), `exactly one axis must survive: ${JSON.stringify(r)}`);
});

check("a zero drag stays zero", () => {
  assert(eq(constrainToAxis(0, 0), { dx: 0, dy: 0 }), "no movement");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
