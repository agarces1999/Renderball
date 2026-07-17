//
// crawl-theme — font-stack construction.
//
//  cycle-10 P4: fontsFromCrawl must NOT emit a duplicated family. When a crawl's
//  BODY role IS the fallback lead (body "Inter" + the "Inter, system-ui,
//  sans-serif" fallback), the naive `${primary}, ${fallback}` join produced
//  "Inter, Inter, system-ui, sans-serif" (the cycle-9 FONT_BODY defect). The
//  stack builder now dedupes case-insensitively, first occurrence kept.
//  Also re-covers the cycle-9 P0 icon-font filter (isIconFont / role exclusion).
//
import { fontsFromCrawl, isIconFont } from "./crawl-theme";
import type { AgentBrandExtract } from "../agents/script-generator";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("crawl-theme");

const be = (o: Partial<AgentBrandExtract>): AgentBrandExtract =>
  ({ ok: true, ...o } as AgentBrandExtract);

check("P4 MUST-FIX: body role == fallback lead does NOT duplicate ('Inter, Inter, …')", () => {
  const fonts = fontsFromCrawl(be({
    font_roles: { display: "MDIO", body: "Inter" },
    fonts: [{ family: "MDIO" }, { family: "Inter" }],
  } as Partial<AgentBrandExtract>));
  assert(fonts.body === "Inter, system-ui, sans-serif", `body deduped, got "${fonts.body}"`);
  assert(!/inter,\s*inter/i.test(fonts.body), `no 'Inter, Inter', got "${fonts.body}"`);
  assert(fonts.display === "MDIO, Inter, system-ui, sans-serif", `display keeps distinct families, got "${fonts.display}"`);
});

check("P4: a distinct display family is preserved verbatim (no over-dedup)", () => {
  const fonts = fontsFromCrawl(be({
    font_roles: { display: "Cabinet Grotesk", body: "Geist" },
    fonts: [{ family: "Cabinet Grotesk" }, { family: "Geist" }],
  } as Partial<AgentBrandExtract>));
  assert(fonts.display.startsWith('"Cabinet Grotesk", '), `quoted multi-word primary kept, got "${fonts.display}"`);
  assert(fonts.body.startsWith("Geist, "), `body primary kept, got "${fonts.body}"`);
});

check("P4: dedup is case-insensitive", () => {
  const fonts = fontsFromCrawl(be({
    font_roles: { display: "inter", body: "INTER" },
    fonts: [{ family: "inter" }],
  } as Partial<AgentBrandExtract>));
  assert(!/inter,\s*inter/i.test(fonts.display), `display no dup, got "${fonts.display}"`);
  assert(!/inter,\s*inter/i.test(fonts.body), `body no dup, got "${fonts.body}"`);
});

check("cycle-9 P0 (regression): an icon-font role never leads a text stack", () => {
  const fonts = fontsFromCrawl(be({
    font_roles: { display: "swiper-icons", body: "swiper-icons" },
    fonts: [{ family: "swiper-icons", src: "data:font/woff2;base64,AA" }, { family: "Inter", src: "https://x/Inter.woff2" }],
  } as Partial<AgentBrandExtract>));
  assert(!isIconFont("Inter") && isIconFont("swiper-icons"), "classifier sane");
  assert(!/swiper-icons/i.test(fonts.display), `display drops the icon font, got "${fonts.display}"`);
  assert(!/swiper-icons/i.test(fonts.body), `body drops the icon font, got "${fonts.body}"`);
  assert(!/swiper-icons/i.test(fonts.fontFaceCss), "icon face excluded from @font-face css");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
