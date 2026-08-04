/** PROBE: does insert-element hang specifically on a FRESH BLANK doc via the preview API? */
import { chromium } from "playwright";
import { authenticator } from "./auth";
const BASE = process.env.QA_BASE ?? "http://localhost:3000";
const run = async () => {
  const auth = authenticator(BASE)!;
  const browser = await chromium.launch();
  const context = await browser.newContext();
  await auth(context);
  const page = await context.newPage();
  await page.goto(`${BASE}/api/documents/new`, { waitUntil: "domcontentloaded" });
  const id = /\/preview\/([A-Z0-9]+)/i.exec(page.url())?.[1];
  console.log("blank doc:", id);
  const t0 = Date.now();
  const res = await page.request.post(`${BASE}/api/preview/insert-element`, {
    data: { scriptId: id, sceneIndex: 0, bounds: { x: 120, y: 120, w: 500, h: 200 }, mode: "generate", prompt: "a small caption reading probe" },
    timeout: 180_000,
    failOnStatusCode: false,
  }).catch((e) => { console.log(`REQUEST DIED after ${((Date.now()-t0)/1000).toFixed(1)}s: ${String(e).slice(0,150)}`); return null; });
  if (res) console.log(`insert on blank doc: ${res.status()} in ${((Date.now()-t0)/1000).toFixed(1)}s — ${(await res.text()).slice(0, 200)}`);
  if (id) await page.request.fetch(`${BASE}/api/documents/${id}`, { method: "DELETE", failOnStatusCode: false });
  await browser.close();
};
run().catch((e) => { console.error(e); process.exit(1); });
