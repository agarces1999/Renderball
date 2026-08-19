process.env.RB_RENDER_TIMEOUT_MS = "2500";

import { strict as assert } from "assert";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { RENDER_ALLOWED_MODULES } from "../code-guard";
import { renderSceneSandboxed, sandboxState, stopRenderSandbox } from "./pool";

/**
 * The sandbox exists for two reasons, and both are asserted here.
 *
 * 1. Composition code is written by a model whose prompt carries crawled
 *    third-party text. It must not run next to DATABASE_URL, CLERK_SECRET_KEY,
 *    STRIPE_SECRET_KEY or RB_FIREWORKS_KEY.
 * 2. `new Function(...)()` is synchronous and uninterruptible, so in-process a
 *    composition with an infinite loop froze the entire server for every user,
 *    permanently. Only a separate process can be given a stopwatch.
 *
 * Everything below was written against a real failure this suite caught. The
 * first cut of the pool never recovered after a timeout — one hung document
 * broke all subsequent renders forever — and the second cut still failed a
 * good render that merely ran CONCURRENTLY with a hung one, because a single
 * child renders serially.
 */

const tmp = path.join(os.tmpdir(), `rb-sandbox-test-${process.pid}`);
const write = async (name: string, src: string): Promise<string> => {
  await fs.mkdir(tmp, { recursive: true });
  const p = path.join(tmp, name);
  await fs.writeFile(p, src, "utf8");
  return p;
};

const GOOD = `
import React from "react";
export const Section0 = () => React.createElement("div", { className: "ok" }, "hello");
`;
const HANG = `export const Section0 = () => { while (true) {} };`;
const THROWS = `export const Section0 = () => { throw new Error("boom"); };`;

const tests: Array<[string, () => Promise<void>]> = [];
const test = (n: string, f: () => Promise<void>) => tests.push([n, f]);

test("renders a composition to HTML", async () => {
  const p = await write("good.tsx", GOOD);
  const r = await renderSceneSandboxed(p, 0, { scenes: [] });
  assert.equal(r.ok, true, r.ok ? "" : r.message);
  if (r.ok) assert.match(r.html, /hello/);
});

test("<style> children keep REAL quotes — React's escaping is undone there", async () => {
  // React escapes text children even inside <style>, where browsers never
  // decode entities — content: &quot;0&quot; is invalid CSS, so count-up
  // animations were silently dead in SSR (found by the client-preview
  // parity gate, 2026-08-20). The worker decodes entities in style blocks
  // only; everywhere else escaping must survive.
  const p = await write(
    "styled.tsx",
    `import React from "react";
     export const Section0 = () => React.createElement("div", null,
       React.createElement("style", null, '@keyframes c { 0% { content: "0"; } 100% { content: "9 & done"; } }'),
       React.createElement("span", null, 'a < b & "c"'),
     );`,
  );
  const r = await renderSceneSandboxed(p, 0, { scenes: [] });
  assert.equal(r.ok, true, r.ok ? "" : r.message);
  if (r.ok) {
    assert.match(r.html, /content: "0"/, "style block must carry real quotes");
    assert.match(r.html, /"9 & done"/, "ampersand in style must be literal");
    assert.doesNotMatch(r.html, /<style>[^<]*&quot;/, "no entities inside style");
    assert.match(r.html, /a &lt; b &amp; &quot;c&quot;/, "escaping OUTSIDE style must survive");
  }
});

test("the child holds NO secrets — the whole point of the boundary", async () => {
  // Function("return this")() defeats identifier shadowing (that is why the
  // previous in-process attempt failed), so this reaches the REAL global and
  // the real process.env. It must simply find nothing worth having.
  const p = await write(
    "probe.tsx",
    `export const Section0 = () => {
       const h = Function("return this")();
       const e = h.process ? h.process.env : {};
       const leaked = ["DATABASE_URL","CLERK_SECRET_KEY","STRIPE_SECRET_KEY","RB_FIREWORKS_KEY"]
         .filter((k) => e[k]);
       return "leaked:" + (leaked.join(",") || "NONE");
     };`,
  );
  const r = await renderSceneSandboxed(p, 0, { scenes: [] });
  assert.equal(r.ok, true);
  if (r.ok) assert.match(r.html, /leaked:NONE/);
});

test("an infinite loop is stopped instead of freezing the server", async () => {
  const p = await write("hang.tsx", HANG);
  const t = Date.now();
  const r = await renderSceneSandboxed(p, 0, { scenes: [] });
  assert.equal(r.ok, false);
  assert.ok(Date.now() - t < 8000, "stopped near the timeout, not never");
  if (!r.ok) assert.match(r.message, /took too long/);
});

test("the pool recovers after a hang killed a child", async () => {
  // The first implementation failed exactly here: the dead child's exit event
  // failed pending requests belonging to its own replacement, so every later
  // render returned "render sandbox was killed (SIGKILL)".
  const hang = await write("hang2.tsx", HANG);
  await renderSceneSandboxed(hang, 0, { scenes: [] });
  const good = await write("good2.tsx", GOOD);
  const r = await renderSceneSandboxed(good, 0, { scenes: [] });
  assert.equal(r.ok, true, r.ok ? "" : r.message);
});

test("a hung render does not take down a CONCURRENT good one", async () => {
  // A child renders serially, so with a pool of one both requests queued and
  // timed out together. This is why the pool has more than one child.
  const hang = await write("hang3.tsx", HANG);
  const good = await write("good3.tsx", GOOD);
  const [a, b] = await Promise.all([
    renderSceneSandboxed(good, 0, { scenes: [] }),
    renderSceneSandboxed(hang, 0, { scenes: [] }),
  ]);
  assert.equal(a.ok, true, "the good render survives");
  assert.equal(b.ok, false, "the hung one is stopped");
});

test("a composition that throws fails cleanly, without killing the child", async () => {
  const p = await write("throws.tsx", THROWS);
  const r = await renderSceneSandboxed(p, 0, { scenes: [] });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.message, /Render error|boom/);
  const good = await write("good4.tsx", GOOD);
  assert.equal((await renderSceneSandboxed(good, 0, { scenes: [] })).ok, true);
});

test("a missing export is reported, not crashed", async () => {
  const p = await write("empty.tsx", `export const NotASection = 1;`);
  const r = await renderSceneSandboxed(p, 0, { scenes: [] });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.message, /No Section0 exported/);
});

test("concurrent renders all succeed", async () => {
  const p = await write("good5.tsx", GOOD);
  const all = await Promise.all(
    Array.from({ length: 8 }, () => renderSceneSandboxed(p, 0, { scenes: [] })),
  );
  assert.ok(all.every((r) => r.ok), "all 8 concurrent renders ok");
  assert.ok(sandboxState().size >= 1);
});

test("the worker's allowlist has not drifted from code-guard's", async () => {
  // render-worker.cjs duplicates the list because it is standalone .cjs with
  // no TS build step. code-guard.ts is the source of truth; this catches drift.
  const src = await fs.readFile(
    path.join(process.cwd(), "lib", "render", "sandbox", "render-worker.cjs"),
    "utf8",
  );
  const block = /const ALLOWED = \[([\s\S]*?)\];/.exec(src);
  assert.ok(block, "ALLOWED list found in the worker");
  const inWorker = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(inWorker, [...RENDER_ALLOWED_MODULES].sort());
});

const main = async (): Promise<void> => {
  let pass = 0;
  let fail = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      pass++;
    } catch (err) {
      console.error(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`);
      fail++;
    }
  }
  stopRenderSandbox();
  await fs.rm(tmp, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
};

void main();
