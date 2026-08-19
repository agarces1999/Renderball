/**
 * CLIENT PREVIEW Phase 1 (docs/CLIENT_PREVIEW_SPIKE.md, founder GO
 * 2026-08-19): compile a deck's Composition.tsx into a self-contained
 * BROWSER bundle so the sandboxed preview iframe can execute the SAME
 * artifact the server SSRs — one compile source, two executors, parity by
 * construction.
 *
 * Security posture (unchanged): this module only COMPILES — esbuild parses
 * and bundles, it never evaluates. Execution happens where LLM code already
 * runs today: the user's browser inside the sandboxed cross-origin iframe
 * (choreography has executed there since the beginning). The server-side
 * eval jail (sandbox/pool.ts) is untouched.
 *
 * The bundle pins its OWN React 18.3.1 (bundled in, exposed on
 * window.__rbComposition) so hydration/JSX-transform versions can never
 * drift from the compile — the spike's "pinned React runtime" trap.
 */
import { promises as fs } from "fs";
import path from "path";
import { createHash } from "crypto";
import * as esbuild from "esbuild";
import { hydrateGenDir } from "./gen-store";

export type ClientBundleResult =
  | { ok: true; js: string; hash: string; cacheHit: boolean }
  | { ok: false; status: number; message: string };

export const clientPreviewEnabled = (): boolean =>
  process.env.RB_CLIENT_PREVIEW === "on";

const CACHE_MAX = 24; // bundles are ~1MB minified — keep the LRU small
const g = globalThis as unknown as {
  __rbClientBundleCache?: Map<string, { js: string; hash: string }>;
};
const cache: Map<string, { js: string; hash: string }> = (g.__rbClientBundleCache ??= new Map());

export async function compileClientBundle(scriptId: string): Promise<ClientBundleResult> {
  await hydrateGenDir(scriptId);
  const compPath = path.join(process.cwd(), "src", "generated", scriptId, "Composition.tsx");
  let compBytes: Buffer;
  try {
    compBytes = await fs.readFile(compPath);
  } catch {
    return { ok: false, status: 404, message: `Composition.tsx not found for ${scriptId}` };
  }

  const key = createHash("sha1")
    .update(scriptId)
    .update("|")
    .update(compBytes)
    .update("|client-v1")
    .digest("hex");
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return { ok: true, js: hit.js, hash: hit.hash, cacheHit: true };
  }

  // Synthetic entry: the composition's exports + the runtime the parity
  // script needs, all inside ONE bundle so nothing resolves at run time.
  const entry = [
    `import * as Comp from ${JSON.stringify(compPath)};`,
    `import React from "react";`,
    `import { createRoot } from "react-dom/client";`,
    `import { flushSync } from "react-dom";`,
    `(window as unknown as { __rbComposition: unknown }).__rbComposition = { Comp, React, createRoot, flushSync };`,
  ].join("\n");

  try {
    const result = await esbuild.build({
      stdin: { contents: entry, resolveDir: process.cwd(), loader: "ts" },
      bundle: true,
      format: "iife",
      platform: "browser",
      target: "es2019",
      jsx: "automatic",
      minify: true,
      write: false,
      logLevel: "silent",
      define: { "process.env.NODE_ENV": '"production"' },
    });
    const js = result.outputFiles[0].text;
    cache.set(key, { js, hash: key });
    if (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return { ok: true, js, hash: key, cacheHit: false };
  } catch (e) {
    // Fail-open by contract: a composition that won't bundle for the browser
    // (unusual import, node-only API) simply keeps its SSR-only preview.
    return {
      ok: false,
      status: 422,
      message: `client bundle failed: ${e instanceof Error ? e.message.split("\n")[0] : e}`,
    };
  }
}
