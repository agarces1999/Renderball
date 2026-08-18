/**
 * The probe kit — the idioms every browser probe kept re-implementing, each
 * carrying its own copy of a lesson someone learned the hard way. One home:
 *
 * - hittablePiece / pieceCenter: display:contents pieces have NO box of
 *   their own — measure the union of child rects and VERIFY with
 *   elementFromPoint before calling a coordinate clickable (blind centers
 *   once passed a fake green by grabbing 140px off the drag surface).
 * - expect harness: ✓/✗ lines + a failure count that decides the exit code.
 * - authedPage: the QA-account context via qa/auth.ts (env harness — the
 *   only sanctioned sign-in path).
 * - pieceCount: how many pieces the LAST iframe renders (the editor canvas
 *   is always the last iframe on the page).
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { authenticator } from "./auth";

export interface ProbeHarness {
  expect: (ok: boolean, what: string) => void;
  failures: () => number;
  /** Prints the verdict line and returns the exit code. */
  finish: (label: string) => number;
}

export const harness = (): ProbeHarness => {
  let failed = 0;
  return {
    expect: (ok, what) => {
      console.log(`  ${ok ? "✓" : "✗"} ${what}`);
      if (!ok) failed++;
    },
    failures: () => failed,
    finish: (label) => {
      console.log(failed === 0 ? `\n${label}: all green` : `\n${label}: ${failed} FAILED`);
      return failed === 0 ? 0 : 1;
    },
  };
};

export interface ProbePage {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

/** A 1600×1100 page, signed in through the env harness when `authed`. */
export const probePage = async (base: string, authed: boolean): Promise<ProbePage> => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  if (authed) {
    const auth = authenticator(base);
    if (!auth) throw new Error("QA credentials not configured (QA_TEST_* env)");
    await auth(context);
  }
  return { browser, context, page: await context.newPage() };
};

/** Pieces rendered by the editor canvas (the LAST iframe on the page). */
export const pieceCount = (page: Page): Promise<number> =>
  page
    .locator("iframe")
    .last()
    .evaluate((f) => (f as HTMLIFrameElement).contentDocument?.querySelectorAll("[data-piece]").length ?? -1);

export interface HittablePiece {
  id: string;
  /** Page-coordinate centre, hit-test verified. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The first piece whose child-union centre ACTUALLY hits it (or the piece
 * named by `wantId`). Every guard here is a shipped false-green: the union
 * because pieces are display:contents, the size floor because hairlines
 * "match", the elementFromPoint check because a sibling can occlude.
 */
export const hittablePiece = (page: Page, wantId?: string): Promise<HittablePiece | null> =>
  page
    .locator("iframe")
    .last()
    .evaluate((f, want) => {
      const iframe = f as HTMLIFrameElement;
      const d = iframe.contentDocument;
      if (!d) return null;
      const host = iframe.getBoundingClientRect();
      for (const p of Array.from(d.querySelectorAll("[data-piece]"))) {
        const id = p.getAttribute("data-piece") || "";
        if (want && id !== want) continue;
        let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
        for (const c of Array.from(p.children)) {
          const bb = c.getBoundingClientRect();
          if (bb.width === 0 && bb.height === 0) continue;
          l = Math.min(l, bb.left); t = Math.min(t, bb.top);
          r = Math.max(r, bb.right); b = Math.max(b, bb.bottom);
        }
        if (!(r - l > 60 && b - t > 14)) continue;
        const cx = (l + r) / 2;
        const cy = (t + b) / 2;
        const hit = d.elementFromPoint(cx, cy);
        if (!hit || (hit.closest && hit.closest("[data-piece]") !== p)) continue;
        return { id, x: host.left + cx, y: host.top + cy, w: r - l, h: b - t };
      }
      return null;
    }, wantId ?? null);
