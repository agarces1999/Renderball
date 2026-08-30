/**
 * The refused-code forensic sidecar: every refusal leaves evidence, the
 * directory never grows past its cap, and a broken genDir cannot make
 * recording throw (log-only paths must never break the edit they document).
 */
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { recordRefused } from "./refused-log";

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : extra}`);
};

console.log("refused-log");

void (async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "rb-refused-"));
  try {
    await recordRefused(work, {
      op: "insert-element",
      sceneIndex: 2,
      prompt: "bar chart with sales in the last quarter",
      body: "<div>{BROKEN.ref}</div>",
      error: "page 3: BROKEN is not defined",
      model: "qwen-3.8",
      attempt: 0,
    });
    const dir = path.join(work, "lego", "refused");
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
    check("a refusal writes one sidecar", files.length === 1, ` — got ${files.length}`);

    const entry = JSON.parse(await fs.readFile(path.join(dir, files[0]), "utf8"));
    check(
      "the sidecar carries prompt, code, and the actual error",
      entry.prompt?.includes("bar chart") && entry.body?.includes("BROKEN") && /not defined/.test(entry.error),
      ` — got ${JSON.stringify(entry).slice(0, 120)}`,
    );

    for (let i = 0; i < 12; i++) {
      await recordRefused(work, { op: "insert-element", sceneIndex: 0, body: `<div>${i}</div>`, error: `e${i}` });
      // Distinct mtime-independent names come from the ISO stamp; a burst in
      // the same millisecond would collide, so space the stamps out.
      await new Promise((r) => setTimeout(r, 3));
    }
    const afterBurst = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
    check("the directory is pruned to its cap", afterBurst.length <= 8, ` — got ${afterBurst.length}`);

    // A genDir where lego/ is an unwritable FILE — recording must not throw.
    const hostile = await fs.mkdtemp(path.join(os.tmpdir(), "rb-refused-hostile-"));
    await fs.writeFile(path.join(hostile, "lego"), "not a directory");
    let threw = false;
    try {
      await recordRefused(hostile, { op: "x", sceneIndex: 0, body: "b", error: "e" });
    } catch {
      threw = true;
    }
    check("recording never throws, even when it cannot write", !threw);
    await fs.rm(hostile, { recursive: true, force: true });
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }

  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
})();
