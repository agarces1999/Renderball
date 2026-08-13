import { PDFDocument } from "pdf-lib";
import type { Script } from "../../src/schema";
import { renderSceneDoc } from "./scene-iframe";
import { dimensionsForScript } from "./build-wrapper";

/**
 * Static export (canvas pivot, docs/PIVOT.md): a deck's product output is its
 * settled frames. This promotes the QA-gate capture path (SSR via
 * renderSceneDoc in settle mode + a Playwright screenshot at exact canvas
 * dims — the same truth measure-scene.ts gates on) to a user-facing export:
 *   - PNG of one page at exact pixel dimensions
 *   - multi-page PDF of the whole document (one page per scene)
 *
 * Zero LLM calls, zero Remotion. Works for any generated composition —
 * decks are the primary consumer, but a video's stills export fine too.
 */

export type StaticExportResult =
  | { ok: true; data: Buffer; contentType: string; filename: string }
  | { ok: false; status: number; message: string };

/** Same CJS/ESM interop dance as measure-scene.ts — under Next dev a
 *  hot-recompile can re-wrap the module so `chromium` lands on `.default`. */
const resolveChromium = async (): Promise<typeof import("playwright").chromium> => {
  const pw = (await import("playwright")) as unknown as {
    chromium?: typeof import("playwright").chromium;
    default?: { chromium?: typeof import("playwright").chromium };
  };
  const resolved = pw.chromium ?? pw.default?.chromium;
  if (!resolved) {
    throw new Error("playwright loaded but its `chromium` export is undefined (module interop)");
  }
  return resolved;
};

/** SSR + screenshot the given scenes settled, at exact canvas dims. */
const screenshotScenes = async (
  scriptId: string,
  script: Script,
  sceneIndexes: number[],
): Promise<{ ok: true; pngs: Buffer[] } | { ok: false; status: number; message: string }> => {
  const dims = dimensionsForScript(script);

  // SSR every page first — fail fast (and cheap) before a browser launches.
  const docs: string[] = [];
  for (const i of sceneIndexes) {
    const doc = await renderSceneDoc(scriptId, i, script, { settle: true });
    if (!doc.ok) return { ok: false, status: doc.status, message: `page ${i + 1}: ${doc.message}` };
    docs.push(doc.html);
  }

  let chromium: Awaited<ReturnType<typeof resolveChromium>>;
  try {
    chromium = await resolveChromium();
  } catch (err) {
    return { ok: false, status: 503, message: `playwright unavailable: ${err instanceof Error ? err.message : String(err)}` };
  }
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  try {
    browser = await chromium.launch({ args: ["--no-sandbox"] });
  } catch (err) {
    const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
    return { ok: false, status: 503, message: `browser launch failed: ${msg}` };
  }

  try {
    const page = await browser.newPage({
      viewport: { width: dims.width, height: dims.height },
      deviceScaleFactor: 1,
    });
    const pngs: Buffer[] = [];
    for (const html of docs) {
      // networkidle waits on the brand's remote images/fonts; retry once on
      // the lenient `load` so a transient stall doesn't fail the export
      // (same policy as the measurement gate).
      try {
        await page.setContent(html, { waitUntil: "networkidle", timeout: 30000 });
      } catch {
        await page.setContent(html, { waitUntil: "load", timeout: 30000 });
      }
      await page.evaluate("document.fonts && document.fonts.ready").catch(() => {});
      // Text fit runs post-fonts (fit-text.ts); exporting before it finishes
      // would ship the unfitted frame the editor never shows.
      await page.evaluate("window.__rbFitDone").catch(() => {});
      // Belt + braces over settle-mode CSS: jump any finite animation to its
      // end state (infinite ambient loops throw on finish() → skipped).
      await page
        .evaluate(
          "try{(document.getAnimations?document.getAnimations():[]).forEach(function(a){try{a.finish()}catch(e){}})}catch(e){}",
        )
        .catch(() => {});
      await page.waitForTimeout(150).catch(() => {});
      pngs.push(
        await page.screenshot({ clip: { x: 0, y: 0, width: dims.width, height: dims.height } }),
      );
    }
    return { ok: true, pngs };
  } catch (err) {
    return { ok: false, status: 500, message: `capture failed: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await browser.close().catch(() => {});
  }
};

/** One page as a PNG at exact canvas pixel dimensions. */
export const exportPagePng = async (
  scriptId: string,
  script: Script,
  sceneIndex: number,
): Promise<StaticExportResult> => {
  if (sceneIndex < 0 || sceneIndex >= script.scenes.length) {
    return { ok: false, status: 400, message: `page ${sceneIndex + 1} out of range (1..${script.scenes.length})` };
  }
  const shots = await screenshotScenes(scriptId, script, [sceneIndex]);
  if (!shots.ok) return shots;
  return {
    ok: true,
    data: shots.pngs[0],
    contentType: "image/png",
    filename: `${scriptId}-page-${sceneIndex + 1}.png`,
  };
};

/** The whole document as a PDF, one page per scene, in order. Page size is
 *  canvas px × 0.5pt — 1920×1080 → 960×540pt (13.33in × 7.5in), exactly the
 *  standard 16:9 presentation page, with the 1:1-px raster giving 2× density. */
export const exportDeckPdf = async (
  scriptId: string,
  script: Script,
): Promise<StaticExportResult> => {
  const indexes = script.scenes.map((_, i) => i);
  if (indexes.length === 0) return { ok: false, status: 400, message: "document has no pages" };
  const shots = await screenshotScenes(scriptId, script, indexes);
  if (!shots.ok) return shots;

  const dims = dimensionsForScript(script);
  const pdf = await PDFDocument.create();
  pdf.setTitle(script.narrative?.logline ?? scriptId);
  pdf.setProducer("Renderball");
  for (const png of shots.pngs) {
    const img = await pdf.embedPng(png);
    const page = pdf.addPage([dims.width / 2, dims.height / 2]);
    page.drawImage(img, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
  }
  const bytes = await pdf.save();
  return {
    ok: true,
    data: Buffer.from(bytes),
    contentType: "application/pdf",
    filename: `${scriptId}-deck.pdf`,
  };
};
