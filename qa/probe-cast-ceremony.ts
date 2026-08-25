/**
 * CAST CEREMONY WITNESS v2 — minimum environmental surface, maximum product
 * truth: the build starts through the REAL prod route (POST /api/preview/build
 * from the authed browser context), the ceremony is watched at /preview/<id>,
 * and the script is FRESH (prescaffold only, no piece cache) so the build is
 * genuinely multi-minute and the Stop click genuinely mid-flight.
 *
 * Asserts the two things the founder's first prod build broke:
 *   (1) page 1's row ticks DONE while the build runs (cast marks → ceremony)
 *   (2) Stop reaches a terminal state within 90s (checkCancel wiring)
 *
 *   QA_BASE=http://localhost:3001 SCRIPT_ID=... npx tsx qa/probe-cast-ceremony.ts
 */
import { chromium } from "playwright";
import { authenticator } from "./auth";

const BASE = process.env.QA_BASE ?? "http://localhost:3001";
const SCRIPT_ID = process.env.SCRIPT_ID!;
const SHOTS = "/private/tmp/claude-501/-Users-alfonsogarces-VIDEO-GEN/66a0320e-ab42-4115-8600-78bdda8062ed/scratchpad";

void (async () => {
  const auth = authenticator(BASE);
  if (!auth) { console.error("no QA credentials"); process.exit(1); }
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await auth(context);
  const page = await context.newPage();
  let ok = true;
  const expect = (c: boolean, m: string) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) ok = false; };

  // Real prod route, real session — returns 202 (job started) or attaches.
  await page.goto(`${BASE}/documents`, { waitUntil: "domcontentloaded" }); // establish session
  const started = await page.request.post(`${BASE}/api/preview/build`, {
    data: { scriptId: SCRIPT_ID },
    failOnStatusCode: false,
  });
  console.log(`build POST → ${started.status()}`);
  expect(started.status() === 202 || started.status() === 200, "build accepted by the prod route");

  await page.goto(`${BASE}/preview/${SCRIPT_ID}`, { waitUntil: "domcontentloaded" });
  const t0 = Date.now();

  const rows = await page
    .waitForFunction(
      () => Array.from(document.querySelectorAll("li, div")).some((e) => /Designing page 1/.test(e.textContent ?? "")),
      undefined,
      { timeout: 60_000 },
    )
    .then(() => true).catch(() => false);
  expect(rows, "ceremony renders the page rows");

  // page 1 ticks DONE mid-build — cast head is minutes, pages land after.
  const ticked = await page
    .waitForFunction(
      () => {
        const els = Array.from(document.querySelectorAll("li"));
        const r = els.find((e) => /Designing page 1/.test(e.textContent ?? ""));
        if (!r) return false;
        if (r.querySelector("svg") !== null) return true;
        const st = r.getAttribute("data-status") ?? "";
        return /done/i.test(st) || /done/i.test(r.className);
      },
      undefined,
      { timeout: 10 * 60_000, polling: 2_000 },
    )
    .then(() => true).catch(() => false);
  expect(ticked, `page 1 ticked DONE mid-build (${Math.round((Date.now() - t0) / 1000)}s in)`);
  await page.screenshot({ path: `${SHOTS}/cast-v2-ticking.png` });

  const stopBtn = page.getByRole("button", { name: /stop this build/i });
  const stopVisible = await stopBtn.isVisible().catch(() => false);
  expect(stopVisible, "stop button present while building");
  if (stopVisible) await stopBtn.click().catch(() => {});
  const tStop = Date.now();
  let terminal = "";
  while (Date.now() - tStop < 90_000) {
    const res = await page.request.get(`${BASE}/api/preview/build?scriptId=${SCRIPT_ID}`, { failOnStatusCode: false });
    if (res.ok()) {
      const j = await res.json();
      if (["cancelled", "done", "error"].includes(j.status)) { terminal = j.status; break; }
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log(`  terminal state: "${terminal}" ${Math.round((Date.now() - tStop) / 1000)}s after Stop`);
  expect(terminal === "cancelled" || terminal === "done", "Stop landed within 90s");
  await page.screenshot({ path: `${SHOTS}/cast-v2-stopped.png` });

  await browser.close();
  console.log(ok ? "\nWITNESS PASSED" : "\nWITNESS FAILED");
  process.exit(ok ? 0 : 1);
})();
