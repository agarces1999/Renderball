//
// Driving the editor the way a person does.
//
// The canvas is an IFRAME and the editing chrome is an overlay above it, which
// is the single most awkward fact about automating this product: elements are
// found inside the frame, but every grip, menu and prompt is painted outside it.
// These helpers hide that seam so a flow reads like a description of what the
// user did.
//
// A second trap, learned the expensive way: the <Piece> shim wraps elements in
// `display: contents`, so a piece's OWN bounding box is 0×0 and its children
// carry the geometry. Anything measuring a piece must union its descendants —
// `pieceBox` below — or it will silently compute nonsense.
//
import type { Page, FrameLocator } from "playwright";
import { until, expect } from "./harness";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The canvas iframe, which hosts the rendered slide. */
export const canvas = (page: Page): FrameLocator => page.frameLocator("iframe").first();

/** Ids of every top-level piece currently on the slide. */
export const pieceIds = async (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const d = (document.querySelector("iframe") as HTMLIFrameElement | null)?.contentDocument;
    if (!d) return [] as string[];
    const seen = new Set<string>();
    for (const el of Array.from(d.querySelectorAll("[data-piece]"))) {
      const id = el.getAttribute("data-piece");
      if (id) seen.add(id);
    }
    return Array.from(seen);
  });

/**
 * A piece's box in PAGE coordinates, ready to click.
 *
 * Unions the piece's descendants because the piece element itself is
 * `display: contents` and measures 0×0. Returns null when the piece has no
 * visible geometry at all.
 */
export const pieceBox = async (page: Page, pieceId: string): Promise<Box | null> =>
  page.evaluate((id) => {
    const frame = document.querySelector("iframe") as HTMLIFrameElement | null;
    const d = frame?.contentDocument;
    if (!frame || !d) return null;
    const host = frame.getBoundingClientRect();
    const el = d.querySelector(`[data-piece="${id}"]`);
    if (!el) return null;
    let L = Infinity, T = Infinity, R = -Infinity, B = -Infinity;
    for (const c of Array.from(el.querySelectorAll("*"))) {
      const r = c.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      L = Math.min(L, r.left); T = Math.min(T, r.top);
      R = Math.max(R, r.right); B = Math.max(B, r.bottom);
    }
    if (L === Infinity) return null;
    // iframe-local → page coordinates
    return { x: host.left + L, y: host.top + T, width: R - L, height: B - T };
  }, pieceId);

/**
 * Pick a piece a person would actually click.
 *
 * Not every piece is a target: `atmosphere` pieces are decorative gradient
 * washes (often blurred, sometimes pointer-transparent) and `chrome` is the
 * page furniture. Selecting one of those and then asserting the editor
 * responded tests nothing and fails confusingly, which is exactly what the
 * first run of this suite did. Prefer real content, largest first.
 */
export const pickEditablePiece = async (page: Page): Promise<string> => {
  const candidates = await page.evaluate(() => {
    const d = (document.querySelector("iframe") as HTMLIFrameElement | null)?.contentDocument;
    if (!d) return [] as { id: string; kind: string; area: number }[];
    const out: { id: string; kind: string; area: number }[] = [];
    const seen = new Set<string>();
    for (const el of Array.from(d.querySelectorAll("[data-piece]"))) {
      const id = el.getAttribute("data-piece");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      // Largest LEAF, not the union: a sparse union is a bad click target.
      let area = 0;
      for (const c of Array.from(el.querySelectorAll("*"))) {
        if (c.querySelector("*")) continue;
        const r = c.getBoundingClientRect();
        if (r.width >= 8 && r.height >= 8) area = Math.max(area, r.width * r.height);
      }
      out.push({ id, kind: el.getAttribute("data-kind") ?? "", area });
    }
    return out;
  });
  const usable = candidates
    .filter((c) => c.area > 400 && !["atmosphere", "chrome"].includes(c.kind))
    .sort((a, b) => b.area - a.area);
  expect(usable.length > 0, "the slide should contain at least one interactive element");
  return usable[0].id;
};

/**
 * A point on the piece that actually has something on it.
 *
 * NOT the centre of its bounding box. A piece's box is the union of its
 * descendants, and a text piece's descendants are scattered — headline at the
 * top, caption at the bottom — so the union's middle is usually empty canvas and
 * a click there selects nothing. Aim at the largest visible leaf instead, which
 * is what a person clicks.
 */
export const clickablePoint = async (
  page: Page,
  pieceId: string,
): Promise<{ x: number; y: number } | null> =>
  page.evaluate((id) => {
    const frame = document.querySelector("iframe") as HTMLIFrameElement | null;
    const d = frame?.contentDocument;
    if (!frame || !d) return null;
    const host = frame.getBoundingClientRect();
    const el = d.querySelector(`[data-piece="${id}"]`);
    if (!el) return null;
    let best: { area: number; cx: number; cy: number } | null = null;
    for (const c of Array.from(el.querySelectorAll("*"))) {
      if (c.querySelector("*")) continue; // leaves carry the ink
      const r = c.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      const area = r.width * r.height;
      if (!best || area > best.area) {
        best = { area, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
      }
    }
    if (!best) return null;
    return { x: host.left + best.cx, y: host.top + best.cy };
  }, pieceId);

/** Click a piece where it is actually visible, to select it. */
export const selectPiece = async (page: Page, pieceId: string): Promise<void> => {
  const point = await clickablePoint(page, pieceId);
  expect(!!point, `piece "${pieceId}" should have a visible spot to click`);
  await page.mouse.click(point!.x, point!.y);
  // Clicking a piece may select an ancestor or a nested child depending on where
  // the pointer lands, so assert that SOMETHING is selected and report which.
  await until(`a piece is selected after clicking "${pieceId}"`, async () => isSelected(page));
};

/**
 * Which piece is selected, if any.
 *
 * Reads the selection frame's `data-rb-selection` rather than inferring from
 * styling or button text. The toolbar's accessible names are long help hints,
 * so matching on prose is both fragile and wrong.
 */
export const selectedPiece = async (page: Page): Promise<string | null> =>
  page
    .evaluate(() => document.querySelector("[data-rb-selection]")?.getAttribute("data-rb-selection") ?? null)
    .catch(() => null);

export const isSelected = async (page: Page): Promise<boolean> =>
  (await selectedPiece(page)) !== null;

/** A toolbar tool, by its stable hook (see EditorShell ToolButton). */
export const tool = (page: Page, label: "Select" | "Generate" | "Text" | "Image" | "Undo") =>
  page.locator(`[data-rb-tool="${label.toLowerCase()}"]`);

/** Drag a rectangle on the canvas — the marquee. */
export const drawBox = async (
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // Several intermediate moves: the marquee only starts after a travel
  // threshold, and one jump can be coalesced away.
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * i) / steps,
      from.y + ((to.y - from.y) * i) / steps,
    );
  }
  await page.mouse.up();
};

/** Geometry of the canvas iframe itself, for placing marquees. */
export const canvasBox = async (page: Page): Promise<Box> => {
  const b = await page.evaluate(() => {
    const f = document.querySelector("iframe") as HTMLIFrameElement | null;
    if (!f) return null;
    const r = f.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  });
  expect(!!b, "the canvas iframe should be present and measurable");
  expect(b!.width > 0 && b!.height > 0, "the canvas should have a non-zero size");
  return b!;
};

/** Wait for the slide to finish (re)loading and expose pieces. */
export const waitForCanvas = async (page: Page): Promise<void> => {
  await until("the canvas renders at least one piece", async () => (await pieceIds(page)).length > 0, 30000);
};

/** The inline error toast, if one is showing. */
export const errorToast = async (page: Page): Promise<string | null> =>
  page.evaluate(() => {
    const el = Array.from(document.querySelectorAll("div,span")).find((n) =>
      /request failed|could not|couldn't|error/i.test(n.textContent ?? ""),
    );
    return el ? (el.textContent ?? "").trim().slice(0, 160) : null;
  });

/** Assert no error surfaced during an interaction. */
export const expectNoError = async (page: Page, during: string): Promise<void> => {
  const t = await errorToast(page);
  expect(!t, `no error should appear while ${during}, but saw: ${t}`);
};
