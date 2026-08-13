/**
 * The pure halves of the text-fit pass (docs/TEXT_FIT.md layer 1). The DOM
 * half is validated by scripts/replay-text-fit.mjs over the stored builds —
 * a browser behavior can't be unit-tested honestly from Node, and pretending
 * with a mock DOM would test the mock.
 */
import {
  FIT_MIN_PX,
  FIT_MIN_SCALE,
  FIT_TEXT_SCRIPT,
  fitGuess,
  floorScale,
  textFitEnabled,
} from "./fit-text";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`);
  }
};
const assert = (c: boolean, m: string) => {
  if (!c) throw new Error(m);
};

console.log("fit-text");

check("not overfull → scale 1 (the pass must be a no-op on healthy pages)", () => {
  assert(fitGuess(1, 40) === 1, "fullness 1");
  assert(fitGuess(0.7, 40) === 1, "underfull");
});

check("the guess always lands between the patent's two bounds", () => {
  for (const fullness of [1.1, 1.3, 1.8, 2.5]) {
    for (const chars of [5, 15, 30, 60, 120]) {
      const g = fitGuess(fullness, chars);
      const lo = 1 / fullness;
      const hi = Math.sqrt(1 / fullness);
      assert(g >= lo - 1e-9 && g <= hi + 1e-9, `f=${fullness} c=${chars} → ${g} outside [${lo}, ${hi}]`);
    }
  }
});

check("short lines lean linear, long lines lean sqrt — the wrap awareness", () => {
  const f = 1.5;
  const short = fitGuess(f, 8); // a two-word headline barely re-wraps
  const long = fitGuess(f, 90); // body copy re-wraps fully
  assert(Math.abs(short - 1 / f) < 1e-9, `short lines should sit at the linear bound, got ${short}`);
  assert(Math.abs(long - Math.sqrt(1 / f)) < 1e-9, `long lines should sit at the sqrt bound, got ${long}`);
  assert(short < long, "more shrink for the unwrappable case");
});

check("monotone: worse fullness never yields a LARGER scale", () => {
  for (const chars of [10, 30, 80]) {
    let prev = 1;
    for (const f of [1.05, 1.2, 1.5, 2, 3]) {
      const g = fitGuess(f, chars);
      assert(g <= prev + 1e-9, `guess grew from ${prev} to ${g} at fullness ${f}`);
      prev = g;
    }
  }
});

check("the floor: 60% of authored size, but never below 11px", () => {
  assert(floorScale(40) === FIT_MIN_SCALE, "large type floors at the 60% fraction");
  // 14px authored: 60% would be 8.4px — the 11px absolute floor bites first.
  assert(Math.abs(floorScale(14) - FIT_MIN_PX / 14) < 1e-9, "small type floors at 11px");
  assert(floorScale(0) === FIT_MIN_SCALE, "degenerate input cannot explode the floor");
  assert(floorScale(10) === 1, "type already at/below 11px is never shrunk at all");
});

check("RB_TEXT_FIT: default on, off is off, junk is on", () => {
  assert(textFitEnabled({}) === true, "default");
  assert(textFitEnabled({ RB_TEXT_FIT: "off" }) === false, "off");
  assert(textFitEnabled({ RB_TEXT_FIT: "0" }) === false, "0");
  assert(textFitEnabled({ RB_TEXT_FIT: "banana" }) === true, "junk does not disable");
});

check("the injected script is template-literal-safe and self-contained", () => {
  // Both page builders embed the script inside a JS template literal; a
  // stray ${ or backtick would silently truncate the HTML document.
  assert(!FIT_TEXT_SCRIPT.includes("`"), "no backticks");
  assert(!FIT_TEXT_SCRIPT.includes("${"), "no template interpolation");
  assert(!FIT_TEXT_SCRIPT.includes("</script"), "no premature close tag");
  assert(FIT_TEXT_SCRIPT.includes("__rbFitDone"), "exposes the done promise");
  assert(FIT_TEXT_SCRIPT.includes("data-rb-fit-floor"), "marks the floor case");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
