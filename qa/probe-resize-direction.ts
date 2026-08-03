/**
 * PROBE, not a test: does resize behave differently expanding vs contracting?
 *
 * Founder report (2026-08-03): "resizing regenerates the figure only for
 * contracting it, not expanding it." The server resize path is direction-
 * agnostic, so this drives the REAL editor UI both ways on the same element
 * and records (a) which API calls each direction makes and (b) what the
 * rendered content actually does.
 *
 * regenerate-element is BLOCKED at the network layer — the probe observes
 * whether a rebuild was ATTEMPTED without spending tokens.
 *
 *   npx tsx qa/probe-resize-direction.ts [scriptId]
 */
import { chromium } from "playwright";
import { pieceBox, pickEditablePiece, selectPiece, waitForCanvas, waitIdle } from "./editor";

const BASE = process.env.QA_BASE ?? "http://localhost:3000";
const ID = process.argv[2] ?? process.env.QA_DEV_SCRIPT_ID ?? "01KY7ZGC4MVDD5J1DSB35GAW5T";

const run = async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

  const calls: string[] = [];
  await page.route("**/api/dev/regenerate-element", async (route) => {
    calls.push(`REBUILD-ATTEMPT ${route.request().postData()?.slice(0, 120) ?? ""}`);
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: "probe: rebuild blocked" }) });
  });
  page.on("request", (r) => {
    if (r.url().includes("/api/dev/") && r.method() === "POST") {
      calls.push(`${r.url().split("/api/dev/")[1]} ${r.postData()?.slice(0, 140) ?? ""}`);
    }
  });
  page.on("response", (r) => {
    if (r.url().includes("/api/dev/edit-layout")) {
      void r.text().then((t) => calls.push(`  -> ${r.status()} ${t.slice(0, 160)}`)).catch(() => {});
    }
  });

  await page.goto(`${BASE}/dev/edit/${ID}`, { waitUntil: "domcontentloaded" });
  await waitForCanvas(page);

  const target = await pickEditablePiece(page);

  const dragEast = async (dx: number) => {
    await selectPiece(page, target);
    const grip = page.getByRole("slider", { name: "Resize e" });
    await grip.waitFor({ state: "visible", timeout: 15_000 });
    const gb = (await grip.boundingBox())!;
    const cx = gb.x + gb.width / 2;
    const cy = gb.y + gb.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    const steps = 10;
    for (let i = 1; i <= steps; i++) await page.mouse.move(cx + (dx * i) / steps, cy);
    await page.mouse.up();
    await waitIdle(page).catch(() => {});
    await page.waitForTimeout(1500);
  };

  const undo = async () => {
    await page.request.post(`${BASE}/api/dev/undo`, { data: { scriptId: ID } });
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForCanvas(page);
  };

  const w = async () => Math.round((await pieceBox(page, target))?.width ?? 0);

  // Contract FIRST this time — if expand still fails second, it is the
  // direction, not drag-ordering or a cold first drag.
  for (const [label, dx] of [["CONTRACT -120", -120], ["EXPAND +120", 120], ["EXPAND again +120", 120]] as const) {
    const before = await w();
    calls.push(`--- ${label} ---`);
    await dragEast(dx);
    const after = await w();
    calls.push(`    content width ${before} -> ${after}`);
    console.log(`${label}: content width ${before} -> ${after}`);
    await undo();
  }
  console.log(`piece: ${target}`);
  console.log("\napi calls:");
  for (const c of calls) console.log("  " + c);

  await browser.close();
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
