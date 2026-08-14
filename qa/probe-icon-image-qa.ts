/**
 * QA: icon/image generation + Match style, as a USER experiences it — the
 * signed-in editor, the real prod route with its gates, the panel, undo,
 * delete, export. Runs on the kept QA deck (no build spend); generations
 * cost ~$0.06 total.
 *
 *   npx tsx qa/probe-icon-image-qa.ts
 */
import { chromium, type Page } from "playwright";
import { authenticator } from "./auth";

const BASE = process.env.QA_BASE ?? "http://localhost:3000";
const DOC = "01KZXQDA10N4EWYDPRTQSXDKSZ"; // kept Northwind fixture, QA-owned
const SHOTS = "/private/tmp/claude-501/-Users-alfonsogarces-VIDEO-GEN/66a0320e-ab42-4115-8600-78bdda8062ed/scratchpad";

let failures = 0;
const expect = (ok: boolean, what: string) => {
  console.log(`  ${ok ? "✓" : "✗"} ${what}`);
  if (!ok) failures++;
};

type ProvMap = Record<string, { prompt?: string; genMeta?: { kind: string; model: string; seed: number } }>;
const provenance = async (page: Page): Promise<ProvMap> => {
  const res = await page.request.get(`${BASE}/api/preview/provenance?scriptId=${DOC}`);
  if (!res.ok()) return {};
  const data = (await res.json()) as { provenance?: ProvMap };
  return data.provenance ?? {};
};

const pieceCount = (page: Page): Promise<number> =>
  page
    .locator("iframe")
    .last()
    .evaluate((f) => (f as HTMLIFrameElement).contentDocument?.querySelectorAll("[data-piece]").length ?? -1);

/** Marquee + prompt + Generate; waits for the busy pill to clear and the piece count to rise. */
const generateInBox = async (
  page: Page,
  kind: "icon" | "image",
  prompt: string,
  at: { x0: number; y0: number; x1: number; y1: number },
  match: boolean,
): Promise<boolean> => {
  const before = await pieceCount(page);
  await page.locator('[data-rb-tool="generate"]').click();
  const box = await page.locator("iframe").last().boundingBox();
  if (!box) throw new Error("no canvas");
  const from = { x: box.x + box.width * at.x0, y: box.y + box.height * at.y0 };
  const to = { x: box.x + box.width * at.x1, y: box.y + box.height * at.y1 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8);
  }
  await page.mouse.up();
  await page.getByRole("button", { name: kind, exact: true }).waitFor({ timeout: 5000 });
  await page.getByRole("button", { name: kind, exact: true }).click();
  const toggle = page.getByRole("switch", { name: /Match my existing/ });
  const pressed = (await toggle.getAttribute("aria-checked")) === "true";
  if (pressed !== match) await toggle.click();
  await page
    .getByPlaceholder(kind === "icon" ? /Name the icon/ : /Describe the image/)
    .fill(prompt);
  await page.getByRole("button", { name: "Generate", exact: true }).last().click();
  // Done = the piece count rose (the editor reloads the scene on success).
  const t0 = Date.now();
  while (Date.now() - t0 < 90_000) {
    if ((await pieceCount(page).catch(() => -1)) > before) return true;
    await page.waitForTimeout(1000);
  }
  return false;
};

/** Hit-test-verified center click on a specific piece (display:contents rules). */
const clickPiece = async (page: Page, pieceId: string): Promise<boolean> => {
  const target = await page
    .locator("iframe")
    .last()
    .evaluate((f, id) => {
      const iframe = f as HTMLIFrameElement;
      const d = iframe.contentDocument;
      if (!d) return null;
      const host = iframe.getBoundingClientRect();
      const p = d.querySelector(`[data-piece="${id}"]`);
      if (!p) return null;
      let l = Infinity, t = Infinity, r = -Infinity, b2 = -Infinity;
      for (const c of p.children) {
        const b = c.getBoundingClientRect();
        if (b.width === 0 && b.height === 0) continue;
        l = Math.min(l, b.left); t = Math.min(t, b.top);
        r = Math.max(r, b.right); b2 = Math.max(b2, b.bottom);
      }
      if (!(r > l)) return null;
      const cx = (l + r) / 2;
      const cy = (t + b2) / 2;
      if (d.elementFromPoint(cx, cy)?.closest?.("[data-piece]") !== p) return null;
      return { x: host.left + cx, y: host.top + cy };
    }, pieceId);
  if (!target) return false;
  await page.mouse.click(target.x, target.y);
  await page.waitForTimeout(900);
  return true;
};

const run = async () => {
  const auth = authenticator(BASE);
  if (!auth) {
    console.error("no QA credentials configured");
    process.exit(1);
  }
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  await auth(context);
  const page: Page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message.slice(0, 120)}`));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(`console: ${m.text().slice(0, 120)}`);
  });
  const added: string[] = [];

  try {
    await page.goto(`${BASE}/preview/${DOC}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /select/i }).first().waitFor({ timeout: 30_000 });
    await page.waitForTimeout(3000);

    // ── A: generate an icon through the real route ─────────────────────────
    const provBefore = await provenance(page);
    const a = await generateInBox(page, "icon", "a coffee cup", { x0: 0.06, y0: 0.62, x1: 0.16, y1: 0.8 }, true);
    expect(a, "icon generated and landed on the canvas (signed-in route, gates passed)");
    let prov = await provenance(page);
    const newA = Object.keys(prov).find((k) => !(k in provBefore) && prov[k].genMeta?.kind === "icon");
    if (newA) added.push(newA);
    expect(!!newA && !!prov[newA!].genMeta, `provenance recorded with genMeta (${newA})`);
    const seedA = newA ? prov[newA].genMeta!.seed : -1;
    await page.screenshot({ path: `${SHOTS}/qa-icon-a.png` });

    // ── B: the Element panel knows what made it ────────────────────────────
    if (newA) {
      const clicked = await clickPiece(page, newA);
      const asked = clicked
        ? await page.getByText("You asked for:").isVisible().catch(() => false)
        : false;
      const promptShown = clicked
        ? await page
            .locator("textarea")
            .last()
            .inputValue()
            .then((v) => v.includes("a coffee cup"))
            .catch(() => false)
        : false;
      expect(clicked && asked && promptShown, "clicking the icon opens its panel with the marquee prompt");
      await page.screenshot({ path: `${SHOTS}/qa-icon-panel.png` });
      await page.keyboard.press("Escape");
    }

    // ── C: undo removes it ─────────────────────────────────────────────────
    const beforeUndo = await pieceCount(page);
    await page.locator('[data-rb-tool="undo"]').click();
    const undone = await (async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 20_000) {
        if ((await pieceCount(page).catch(() => -1)) < beforeUndo) return true;
        await page.waitForTimeout(800);
      }
      return false;
    })();
    expect(undone, "Undo removes the generated icon");
    if (undone && newA) added.splice(added.indexOf(newA), 1);

    // ── D: a family across PAGES (match on, doc-wide reference) ────────────
    const d1 = await generateInBox(page, "icon", "a coffee bean bag", { x0: 0.06, y0: 0.62, x1: 0.16, y1: 0.8 }, true);
    expect(d1, "family anchor icon generated (page 1)");
    prov = await provenance(page);
    const anchor = Object.keys(prov).find((k) => !added.includes(k) && k !== newA && prov[k].genMeta?.kind === "icon");
    if (anchor) added.push(anchor);
    const seedAnchor = anchor ? prov[anchor].genMeta!.seed : -2;

    await page.locator('button:has(span:text-is("02"))').first().click();
    await page.waitForTimeout(2500);
    const d2 = await generateInBox(page, "icon", "a delivery truck", { x0: 0.06, y0: 0.62, x1: 0.16, y1: 0.8 }, true);
    expect(d2, "matched icon generated on page 2");
    prov = await provenance(page);
    const matched = Object.keys(prov).find((k) => !added.includes(k) && k !== newA && prov[k].genMeta?.kind === "icon");
    if (matched) added.push(matched);
    expect(!!matched && prov[matched].genMeta!.seed === seedAnchor, `cross-page match reuses the anchor seed (${seedAnchor})`);
    await page.screenshot({ path: `${SHOTS}/qa-icon-family-p2.png` });

    // ── E: match OFF generates its own seed ────────────────────────────────
    const e1 = await generateInBox(page, "icon", "a globe", { x0: 0.2, y0: 0.62, x1: 0.3, y1: 0.8 }, false);
    expect(e1, "match-off icon generated");
    prov = await provenance(page);
    const solo = Object.keys(prov).find((k) => !added.includes(k) && k !== newA && prov[k].genMeta?.kind === "icon");
    if (solo) added.push(solo);
    expect(!!solo && prov[solo].genMeta!.seed !== seedAnchor, "match-off icon rolled its own seed");

    // ── F: image mode on the new default model ─────────────────────────────
    const f1 = await generateInBox(page, "image", "warm photo of a coffee shop counter", { x0: 0.34, y0: 0.6, x1: 0.56, y1: 0.85 }, false);
    expect(f1, "image generated through the editor");
    prov = await provenance(page);
    const img = Object.keys(prov).find((k) => !added.includes(k) && prov[k].genMeta?.kind === "image");
    if (img) added.push(img);
    expect(!!img && /playground-v2-5/.test(prov[img].genMeta!.model), `image used the new default model (${img ? prov[img].genMeta!.model.split("/").pop() : "?"})`);
    await page.screenshot({ path: `${SHOTS}/qa-image-mode.png` });

    // ── G: icons move and delete like citizens ─────────────────────────────
    if (matched) {
      const sel = await clickPiece(page, matched);
      if (sel) {
        // Measure the IMG: a moved piece gains a full-canvas offset wrapper
        // (manifest offset mechanism) and a child union reads the wrapper,
        // not the visual — the first run of this beat failed on exactly that.
        const before = await page
          .locator("iframe")
          .last()
          .evaluate((f, id) => {
            const img = (f as HTMLIFrameElement).contentDocument?.querySelector(`[data-piece="${id}"] img`);
            return img ? img.getBoundingClientRect().left : -1;
          }, matched);
        // Drag the selection 60px right via its drag surface (mouse on center).
        const t = await page.locator("iframe").last().boundingBox();
        const selBox = await page.locator("[data-rb-selection]").boundingBox().catch(() => null);
        if (selBox && t) {
          await page.mouse.move(selBox.x + selBox.width / 2, selBox.y + selBox.height / 2);
          await page.mouse.down();
          for (let i = 1; i <= 6; i++) await page.mouse.move(selBox.x + selBox.width / 2 + i * 10, selBox.y + selBox.height / 2);
          await page.mouse.up();
          await page.waitForTimeout(2500);
          const after = await page
            .locator("iframe")
            .last()
            .evaluate((f, id) => {
              const img = (f as HTMLIFrameElement).contentDocument?.querySelector(`[data-piece="${id}"] img`);
              return img ? img.getBoundingClientRect().left : -1;
            }, matched);
          expect(after > before, `dragging an icon moves it (${Math.round(before)} → ${Math.round(after)})`);
        } else {
          expect(false, "selection frame present for drag");
        }
      } else {
        expect(false, "icon selectable for move");
      }
    }

    // ── H: export carries the transparent icon ─────────────────────────────
    const dl = page.waitForEvent("download", { timeout: 60_000 }).catch(() => null);
    await page.getByRole("button", { name: /PNG$/ }).click();
    const download = await dl;
    expect(!!download, "page PNG export downloads");
    if (download) {
      await download.saveAs(`${SHOTS}/qa-export-page2.png`);
    }

    // ── cleanup: sweep EVERY genMeta-bearing piece (exercises Delete on
    // icons/images). On this fixture, generated test pieces are the only ones
    // that carry genMeta — this also collects strays from crashed runs.
    prov = await provenance(page);
    const strays = Object.keys(prov).filter((k) => prov[k].genMeta);
    let left = strays.length;
    for (const railChip of ['"02"', '"01"', '"02"', '"01"']) {
      if (left === 0) break;
      await page.locator(`button:has(span:text-is(${railChip}))`).first().click();
      await page.waitForTimeout(2500);
      for (const id of strays) {
        const sel = await clickPiece(page, id);
        if (!sel) continue;
        await page.keyboard.press("Delete");
        await page.waitForTimeout(2500);
        const gone = (await page
          .locator("iframe")
          .last()
          .evaluate((f, pid) => !(f as HTMLIFrameElement).contentDocument?.querySelector(`[data-piece="${pid}"]`), id)
          .catch(() => false));
        if (gone) {
          left--;
          console.log(`    cleaned ${id}`);
        }
      }
    }
    expect(left === 0, `all test pieces deleted (${left} left of ${strays.length})`);

    const realErrors = consoleErrors.filter((e) => !/favicon|hydrat/i.test(e));
    expect(realErrors.length === 0, `no console/page errors (${realErrors.length ? realErrors.slice(0, 3).join(" | ") : "clean"})`);
  } finally {
    await browser.close();
  }

  console.log(failures === 0 ? "\nicon/image QA: all green" : `\nicon/image QA: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
};
void run();
