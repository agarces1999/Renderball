/**
 * The persistent per-brand DECK SYSTEM (RB_BRAND_SYSTEM; 10x thesis,
 * 2026-09-04; default OFF).
 *
 * Every deck today rebuilds the brand from zero: identity, chrome, helpers,
 * keyframes, device primitives — a third of every file, re-derived per build
 * and different every time, so a company's decks never match. With the
 * parallel author the design pass already writes exactly that system as a
 * module preamble. This module keeps it: the first deck for a brand pays the
 * design pass; every later deck reuses the stored system, plans its own pages
 * against it (a cheap plan-only call), and writes pages in parallel.
 *
 * Reuse is fingerprinted on the brand facts the pack renders (palette, roles,
 * fonts, logo, design card): a changed brand invalidates the system and the
 * next build re-designs. Storage is a small JSON on disk per brand key; a
 * miss or any read failure simply means "design it" — never a failed build.
 */
import crypto from "crypto";
import { promises as fsp } from "fs";
import path from "path";
import type { PackBrandFacts } from "./pack";

export const brandSystemEnabled = (): boolean => (process.env.RB_BRAND_SYSTEM ?? "off") === "on";

export interface StoredBrandSystem {
  key: string;
  fingerprint: string;
  preamble: string;
  savedAt: string;
  scriptId: string;
  uses: number;
}

const dir = (): string => path.join(process.cwd(), ".data", "brand-systems");
const fileOf = (key: string): string => path.join(dir(), `${key}.json`);

/** Stable key for a brand: its site host when known, else the name. */
export const brandSystemKey = (siteUrl: unknown, brandName: string): string => {
  let host = "";
  if (typeof siteUrl === "string") {
    try { host = new URL(siteUrl).host.replace(/^www\./, "").toLowerCase(); } catch { host = ""; }
  }
  const base = host || brandName.trim().toLowerCase() || "brand";
  return crypto.createHash("sha1").update(base).digest("hex").slice(0, 16);
};

/** What the author saw when it designed the system: if this changes, the
 *  system is stale and the next build re-designs. */
export const brandFingerprint = (brand: PackBrandFacts): string =>
  crypto
    .createHash("sha1")
    .update(JSON.stringify({ p: brand.palette, r: brand.roles ?? {}, f: brand.fonts ?? {}, l: brand.logoSrc, m: brand.mode, b: brand.background, d: brand.designCard ?? "" }))
    .digest("hex")
    .slice(0, 16);

export const loadBrandSystem = async (key: string, fingerprint: string): Promise<StoredBrandSystem | null> => {
  try {
    const raw = JSON.parse(await fsp.readFile(fileOf(key), "utf8")) as StoredBrandSystem;
    if (!raw || raw.fingerprint !== fingerprint || typeof raw.preamble !== "string" || raw.preamble.length < 300) return null;
    return raw;
  } catch {
    return null;
  }
};

export const saveBrandSystem = async (entry: Omit<StoredBrandSystem, "savedAt" | "uses"> & { uses?: number }): Promise<void> => {
  try {
    await fsp.mkdir(dir(), { recursive: true });
    const record: StoredBrandSystem = { ...entry, uses: entry.uses ?? 0, savedAt: new Date().toISOString() };
    await fsp.writeFile(fileOf(entry.key), JSON.stringify(record, null, 2), "utf8");
  } catch {
    /* best-effort: a lost system costs one design pass next time */
  }
};

export const touchBrandSystem = async (key: string): Promise<void> => {
  try {
    const raw = JSON.parse(await fsp.readFile(fileOf(key), "utf8")) as StoredBrandSystem;
    raw.uses = (raw.uses ?? 0) + 1;
    await fsp.writeFile(fileOf(key), JSON.stringify(raw, null, 2), "utf8");
  } catch {
    /* best-effort */
  }
};
