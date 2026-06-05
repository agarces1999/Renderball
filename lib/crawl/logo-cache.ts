/**
 * Domain-keyed logo cache.
 *
 * Logo discovery is the expensive, non-deterministic part of the crawl: a
 * candidate sweep + HEAD probes + a Sonnet vision agent (~15-25s) + (sometimes)
 * a web search. Re-crawling the same domain re-pays all of it and can return a
 * DIFFERENT result run to run (vision nondeterminism). Caching the resolved
 * logo by registrable domain makes re-crawls instant, deterministic, and free —
 * and locks in a known-good result so a later flaky run can't regress it.
 *
 * Stored under .data/logo-cache/<domain>.json. 30-day TTL. Only SUCCESSES are
 * cached (a miss should retry next time, not be remembered as "no logo"). Pure
 * best-effort: any fs/parse error degrades to "no cache" so discovery just runs.
 */

import { promises as fs } from "fs";
import path from "path";

const CACHE_DIR = path.join(process.cwd(), ".data", "logo-cache");
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface CachedLogo {
  url: string;
  confidence: number;
  source: string;
}

interface CacheRecord extends CachedLogo {
  ts: number;
}

// Sanitize a domain into a safe filename (no path separators / odd chars).
const keyFor = (domain: string): string =>
  domain.toLowerCase().replace(/[^a-z0-9.-]/g, "_");

export const readLogoCache = async (
  domain: string,
): Promise<CachedLogo | null> => {
  try {
    const file = path.join(CACHE_DIR, `${keyFor(domain)}.json`);
    const raw = await fs.readFile(file, "utf-8");
    const rec = JSON.parse(raw) as CacheRecord;
    if (!rec || typeof rec.url !== "string" || typeof rec.ts !== "number") {
      return null;
    }
    if (Date.now() - rec.ts > TTL_MS) return null; // stale
    return { url: rec.url, confidence: rec.confidence, source: rec.source };
  } catch {
    return null; // no cache / unreadable → discovery runs
  }
};

export const writeLogoCache = async (
  domain: string,
  result: CachedLogo,
): Promise<void> => {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    const file = path.join(CACHE_DIR, `${keyFor(domain)}.json`);
    const rec: CacheRecord = { ...result, ts: Date.now() };
    await fs.writeFile(file, JSON.stringify(rec, null, 2), "utf-8");
  } catch {
    // best-effort — a cache write failure must not break the crawl
  }
};
