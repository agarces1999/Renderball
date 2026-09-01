/**
 * The ceremony's override semantics — the rules that decide what a document
 * actually wears when a human has spoken.
 *
 * The one that must never regress: `monochrome` DELETES the accent. The
 * crawler provably invents a colour for every achromatic brand
 * (docs/BRAND_ACCURACY.md, 0/9 with three detectors killed by data), so the
 * ceremony's black-&-white answer is the only correct signal that exists —
 * if any code path lets a crawled signature outrank it, the feature is gone.
 */
import type { BrandExtract } from "../../app/new/schema";
import { brandFromExtractWithRoles, mergeOntoDocumentBrand } from "./kit-apply";
import { fillBrandIdentity, type DocumentBrand } from "./document-brand";

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

console.log("brand kit apply");

/** An extract the crawler would read a colour out of. */
const chromaticExtract = (): BrandExtract => ({
  url: "https://acme.com",
  fetched_at: "2026-08-11T00:00:00Z",
  ok: true,
  palette: ["#ff4800", "#112233"],
  fonts: [{ family: "Acme Sans", src: "https://acme.com/f.woff2" }],
  font_roles: { display: "Acme Sans" },
});

check("no overrides → the crawl's own read stands", () => {
  const b = brandFromExtractWithRoles(chromaticExtract());
  assert(b.palette.accent === "#ff4800", `accent should be the signature, got ${b.palette.accent}`);
});

check("monochrome deletes the accent — a human beats the crawler", () => {
  const b = brandFromExtractWithRoles(chromaticExtract(), { monochrome: true });
  assert(b.palette.accent === undefined, "the confirmed-monochrome brand must carry NO accent");
});

check("an explicit accent beats a monochrome flag riding along a kit", () => {
  // The ceremony never sends both; the legacy /new wizard can — a fresh
  // accent picked in StepColors layered onto a kit that stored monochrome.
  // The hex pick is the newer, stronger claim and must not be silently
  // discarded by a flag the wizard gives no way to see or clear.
  const b = brandFromExtractWithRoles(chromaticExtract(), {
    monochrome: true,
    accent: "#00ff00",
  });
  assert(b.palette.accent === "#00ff00", "the explicit pick wins");
});

check("a user-picked accent replaces the signature", () => {
  const b = brandFromExtractWithRoles(chromaticExtract(), { accent: "#123456" });
  assert(b.palette.accent === "#123456", `got ${b.palette.accent}`);
});

check("a hostile 'accent' is ignored, not written into composition source", () => {
  const b = brandFromExtractWithRoles(chromaticExtract(), {
    accent: 'red";process.exit()//' as string,
  });
  assert(b.palette.accent === "#ff4800", "non-hex accent must fall back to the crawl's read");
});

check("monochrome keeps the fonts — killing the colour must not kill the type", () => {
  const b = brandFromExtractWithRoles(chromaticExtract(), { monochrome: true });
  assert(!!b.fonts.display, "display font survives the monochrome override");
});

check("background crawl FILLS, never clobbers, a handpicked identity (founder's Deel doc)", () => {
  const existing: DocumentBrand = {
    v: 1,
    palette: { accent: "#123456" },
    fonts: { display: '"Courier New", monospace', faces: [{ family: "UserFace", src: "https://u.example/f.woff2" }] },
    assets: [],
    guidelines: "we say members",
  };
  const crawl: DocumentBrand = {
    v: 1,
    palette: { accent: "#ffcf25", canvas: "#ffffff" },
    fonts: { display: '"BagossCondensedFont", sans-serif', body: '"Inter", sans-serif', faces: [{ family: "BagossCondensedFont", src: "https://deel.example/b.woff2" }] },
    assets: [],
  };
  const out = fillBrandIdentity(existing, crawl);
  assert(out.palette.accent === "#123456", "handpicked accent survives the crawl");
  assert(out.palette.canvas === "#ffffff", "empty slots fill from the crawl");
  assert(out.fonts.display === '"Courier New", monospace', "handpicked display survives");
  assert(out.fonts.body === '"Inter", sans-serif', "unclaimed body fills from the crawl");
  assert(out.fonts.faces?.length === 2 && out.fonts.faces[0].family === "UserFace", "faces union, user's first");
  assert(out.guidelines === "we say members", "materials untouched");
});

check("a user-picked background dresses the canvas role (ceremony 2026-08-29)", () => {
  const b = brandFromExtractWithRoles(chromaticExtract(), { background: "#10141c" });
  assert(b.palette.canvas === "#10141c", `got ${b.palette.canvas}`);
});

check("a hostile 'background' is ignored like a hostile accent", () => {
  const before = brandFromExtractWithRoles(chromaticExtract()).palette.canvas;
  const b = brandFromExtractWithRoles(chromaticExtract(), {
    background: 'url(x)";//' as string,
  });
  assert(b.palette.canvas === before, "non-hex background must leave the canvas untouched");
});

check("merge keeps the document's uploaded logo and materials", () => {
  const existing: DocumentBrand = {
    v: 1,
    palette: { accent: "#old000" },
    fonts: {},
    logo: "assets/uploaded-logo.svg",
    assets: [{ ref: "assets/uploaded-logo.svg", name: "logo.svg", mime: "image/svg+xml", kind: "logo" }],
    guidelines: "always sentence case",
  };
  const incoming = brandFromExtractWithRoles(chromaticExtract(), { accent: "#123456" });
  const merged = mergeOntoDocumentBrand(existing, incoming);
  assert(merged.logo === "assets/uploaded-logo.svg", "the mid-ceremony upload must survive the confirm");
  assert(merged.assets.length === 1, "materials survive");
  assert(merged.guidelines === "always sentence case", "guidelines survive");
  assert(merged.palette.accent === "#123456", "identity comes from the confirmation");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
