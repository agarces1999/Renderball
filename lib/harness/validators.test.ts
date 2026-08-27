import { describe, expect, it } from "vitest";
import { findInventedNumerals, findLogoViolation } from "./validators";

// The witness-build regression (2026-08-27): SVG attribute strings flooded 136
// false violations. Geometry is never a claim; only viewer-readable text is.
describe("harness truth validators — numeral scope", () => {
  it("ignores SVG path/viewBox attribute strings and style objects", () => {
    const code = `
      export const Section0 = () => (
        <div style={{ position: "absolute", top: 150, fontSize: 92 }}>
          <svg viewBox="0 0 1920 1080" width={960}>
            <path d="M0,395 L80,392 L110,120 L140,390" strokeWidth="3.5" strokeDasharray="4 4" />
          </svg>
          <p>Roast-date honesty, every single bag.</p>
        </div>
      );`;
    expect(findInventedNumerals(code, "no numbers in this brief", 6)).toEqual([]);
  });

  it("catches an invented numeral in visible JSX text", () => {
    const code = `<div><h1>We serve 4,000 cafes</h1></div>`;
    const v = findInventedNumerals(code, "coffee brief with no numbers", 6);
    expect(v).toHaveLength(1);
    expect(v[0].detail).toBe("4,000");
  });

  it("catches an invented numeral in a rendered string literal", () => {
    const code = `const LABELS = ["Founded 1987", "Single origin"]; <div>{LABELS[0]}</div>`;
    expect(findInventedNumerals(code, "no numbers", 6).map((v) => v.detail)).toEqual(["1987"]);
  });

  it("allows numerals present in the approved copy and page indices", () => {
    const code = `<div><h1>94% sell-through</h1><span>03 — 06</span></div>`;
    expect(findInventedNumerals(code, "pilot hit 94% sell-through", 6)).toEqual([]);
  });

  it("flags a missing logo only when a logo exists", () => {
    expect(findLogoViolation("<div/>", "https://cdn.example.com/logo.png")).toHaveLength(1);
    expect(findLogoViolation('<img src="https://cdn.example.com/logo.png"/>', "https://cdn.example.com/logo.png")).toEqual([]);
    expect(findLogoViolation("<div/>", null)).toEqual([]);
  });
});
