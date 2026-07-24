/**
 * Tests for the saved brand-kit logic (canvas pivot, docs/PIVOT.md NEW #5):
 * host normalization, the override-preservation upsert semantics, and the
 * row → kit/summary mappers. The prisma IO wrappers are thin; the semantics
 * live in these pure functions.
 */
import { Prisma } from "@prisma/client";
import {
  normalizeBrandHost,
  sanitizePaletteRoles,
  kitUpsertArgs,
  toSavedBrandKit,
  toBrandKitSummary,
  upsertBrandKit,
  type BrandKitRow,
} from "./brand-kits";
import type { BrandExtract } from "../app/new/schema";

let passed = 0;
let failed = 0;
const pending: Promise<void>[] = [];
const check = (name: string, fn: () => void | Promise<void>) => {
  try {
    const r = fn();
    if (r instanceof Promise) {
      pending.push(
        r
          .then(() => { passed++; console.log(`  ✓ ${name}`); })
          .catch((e) => { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }),
      );
      return;
    }
    passed++; console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`);
  }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("brand-kits");

const okExtract = (over: Partial<BrandExtract> = {}): BrandExtract => ({
  url: "https://acme.com/",
  fetched_at: "2026-07-23T00:00:00.000Z",
  ok: true,
  title: "Acme — Rockets",
  logo_hd: "https://acme.com/logo.svg",
  palette: ["#112233", "#00c28a", "#ffffff", "#000000", "#ff0000", "#00ff00"],
  ...over,
});

// ── normalizeBrandHost ───────────────────────────────────────────────────────

check("strips scheme, www, path, query, and lowercases", () => {
  assert(normalizeBrandHost("https://www.Acme.com/pricing?x=1") === "acme.com", "full URL");
  assert(normalizeBrandHost("HTTP://ACME.COM") === "acme.com", "http + caps");
});

check("scheme is optional (users type bare domains)", () => {
  assert(normalizeBrandHost("acme.com") === "acme.com", "bare domain");
  assert(normalizeBrandHost("  acme.com/about  ") === "acme.com", "whitespace + path");
});

check("subdomains are preserved — distinct design systems", () => {
  assert(normalizeBrandHost("https://app.acme.com") === "app.acme.com", "subdomain kept");
  assert(normalizeBrandHost("sub.acme.co.uk") === "sub.acme.co.uk", "multi-label TLD kept");
});

check("port and trailing dot are ignored", () => {
  assert(normalizeBrandHost("https://acme.com:8443/x") === "acme.com", "port stripped");
  assert(normalizeBrandHost("www.acme.com.") === "acme.com", "trailing dot stripped");
});

check("unusable input → null", () => {
  assert(normalizeBrandHost("") === null, "empty");
  assert(normalizeBrandHost("   ") === null, "blank");
  assert(normalizeBrandHost("not a url at all") === null, "spaces never parse");
});

// ── sanitizePaletteRoles ─────────────────────────────────────────────────────

check("keeps only known role keys with hex values", () => {
  const roles = sanitizePaletteRoles({
    primary: "#112233",
    accent: "#00C28A",
    light: "javascript:alert(1)",
    bogus: "#ffffff",
  } as unknown);
  assert(roles !== undefined, "roles survive");
  assert(roles!.primary === "#112233" && roles!.accent === "#00C28A", "hex roles kept");
  assert(roles!.light === undefined, "non-hex value dropped");
  assert(!("bogus" in roles!), "unknown key dropped");
});

check("empty / non-object roles → undefined", () => {
  assert(sanitizePaletteRoles({}) === undefined, "empty object");
  assert(sanitizePaletteRoles(null) === undefined, "null");
  assert(sanitizePaletteRoles("nope") === undefined, "string");
  assert(sanitizePaletteRoles({ primary: "red" }) === undefined, "named color dropped");
});

// ── kitUpsertArgs: the override-preservation contract ────────────────────────

check("upserts by (ownerId, host) composite key", () => {
  const args = kitUpsertArgs("user_1", "acme.com", okExtract());
  assert(
    JSON.stringify(args.where) === JSON.stringify({ ownerId_url: { ownerId: "user_1", url: "acme.com" } }),
    `where key wrong: ${JSON.stringify(args.where)}`,
  );
});

check("crawl path (no overrides): update touches ONLY the extract", () => {
  const args = kitUpsertArgs("user_1", "acme.com", okExtract());
  const update = args.update as Record<string, unknown>;
  assert(update.extract !== undefined, "extract updated");
  assert(!("paletteRoles" in update), "paletteRoles untouched — user's lock survives a re-crawl");
  assert(!("logoSource" in update), "logoSource untouched — user's lock survives a re-crawl");
});

check("submit path: overrides mirror exactly (set roles + logo source)", () => {
  const args = kitUpsertArgs("user_1", "acme.com", okExtract(), {
    palette_roles: { primary: "#112233", accent: "#00c28a" },
    logo_source: "crawl_confirmed",
  });
  const update = args.update as Record<string, unknown>;
  assert(
    JSON.stringify(update.paletteRoles) === JSON.stringify({ primary: "#112233", accent: "#00c28a" }),
    "roles written",
  );
  assert(update.logoSource === "crawl_confirmed", "logo source written");
  const create = args.create as Record<string, unknown>;
  assert(create.ownerId === "user_1" && create.url === "acme.com", "create carries key fields");
  assert(create.logoSource === "crawl_confirmed", "create carries logo source");
});

check("submit path with NO role picks clears stored roles (mirror, not merge)", () => {
  const args = kitUpsertArgs("user_1", "acme.com", okExtract(), {
    palette_roles: {},
    logo_source: "upload",
  });
  const update = args.update as Record<string, unknown>;
  assert(update.paletteRoles === Prisma.DbNull, "roles cleared to NULL");
  assert(update.logoSource === "upload", "logo source written");
});

check("invalid logo_source is dropped, not stored", () => {
  const args = kitUpsertArgs("user_1", "acme.com", okExtract(), {
    logo_source: "totally_fake" as unknown as "upload",
  });
  const update = args.update as Record<string, unknown>;
  assert(update.logoSource === null, "junk logo source → NULL");
  assert((args.create as Record<string, unknown>).logoSource === undefined, "junk never created");
});

// ── row mappers ──────────────────────────────────────────────────────────────

const row = (over: Partial<BrandKitRow> = {}): BrandKitRow => ({
  id: "kit_1",
  url: "acme.com",
  extract: okExtract(),
  paletteRoles: { primary: "#112233" },
  logoSource: "crawl_confirmed",
  updatedAt: new Date("2026-07-23T12:00:00.000Z"),
  ...over,
});

check("toSavedBrandKit maps a full row", () => {
  const kit = toSavedBrandKit(row());
  assert(kit !== null, "kit maps");
  assert(kit!.host === "acme.com", "host from url column");
  assert(kit!.brand_extract.ok === true && kit!.brand_extract.title === "Acme — Rockets", "extract intact");
  assert(kit!.palette_roles?.primary === "#112233", "roles mapped");
  assert(kit!.logo_source === "crawl_confirmed", "logo source mapped");
  assert(kit!.updated_at === "2026-07-23T12:00:00.000Z", "timestamp ISO");
});

check("unusable stored extract → null (defensive)", () => {
  assert(toSavedBrandKit(row({ extract: null })) === null, "null extract");
  assert(toSavedBrandKit(row({ extract: { ok: false, url: "x", fetched_at: "t" } })) === null, "failed extract");
  assert(toSavedBrandKit(row({ extract: "garbage" })) === null, "non-object extract");
});

check("junk override columns degrade to undefined, kit still usable", () => {
  const kit = toSavedBrandKit(row({ paletteRoles: "junk", logoSource: "weird" }));
  assert(kit !== null, "kit maps");
  assert(kit!.palette_roles === undefined, "junk roles dropped");
  assert(kit!.logo_source === undefined, "junk logo source dropped");
});

check("toBrandKitSummary trims to identity chrome and caps palette at 4", () => {
  const s = toBrandKitSummary(row());
  assert(s !== null, "summary maps");
  assert(s!.title === "Acme — Rockets" && s!.logo_hd === "https://acme.com/logo.svg", "chrome kept");
  assert(s!.palette.length === 4, `palette capped at 4, got ${s!.palette.length}`);
  assert(!("brand_extract" in (s as unknown as Record<string, unknown>)), "no full extract on summaries");
});

// ── upsertBrandKit guards (no DB in tests — must return before prisma) ──────

check("upsert no-ops on a failed extract and an unusable host", async () => {
  const prevBackend = process.env.RB_STORE_BACKEND;
  process.env.RB_STORE_BACKEND = "file"; // belt + suspenders: guarantee no DB touch
  try {
    await upsertBrandKit({ ownerId: "u", extract: okExtract({ ok: false }) });
    await upsertBrandKit({ ownerId: "u", extract: okExtract({ url: "   " }) });
    await upsertBrandKit({ ownerId: "u", extract: okExtract() }); // file backend → no-op
  } finally {
    if (prevBackend === undefined) delete process.env.RB_STORE_BACKEND;
    else process.env.RB_STORE_BACKEND = prevBackend;
  }
});

// ── summary ──────────────────────────────────────────────────────────────────

Promise.all(pending).then(() => {
  console.log(`\nbrand-kits: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
});
