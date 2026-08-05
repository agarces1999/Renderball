//
// JOURNEY H — "the deck I see is the deck they get".
//
// One deck, FIVE renderers. The editor canvas, the PDF export, the per-page PNG
// export, the public share viewer and the link-preview image are five separate
// paths from the same document to the same pixels. Each is already tested ON ITS
// OWN — journey B clicks the PNG button, journeys.ts fetches a PDF, journey D
// reads a share link on a phone, share.ts probes the public routes — and every
// one of those tests can pass while the surfaces disagree with each other.
//
// That gap has already cost somebody a deck. On 2026-08-03 a build reported
// success and shipped a slide that rendered content in one surface and React's
// "Element type is invalid" in another; because the export, the share link and
// the unfurl all render the same document by different routes, the dead slide
// travelled into every one of them. The owner never saw it — they were looking at
// their editor, where it was fine — and the recipient, who did see it, had no way
// to say so.
//
// THE INVARIANT THIS FILE EXISTS FOR, stated once and asserted at the end:
//
//     No surface may render an error where another renders content, and no
//     surface may lose a page another one has.
//
// A disagreement between two renderers of the same deck is a bug even when every
// surface passes its own test. That is precisely how the 2026-08-03 slide
// shipped, and no other flow in this suite compares one surface against another.
//
// FREE TIER, on the already-built fixture deck. Exports and sharing are
// deterministic database-and-renderer work — zero model calls, zero spend — so
// this runs on every QA run. It is not fast: the PDF renders every page in a real
// Chromium and each PNG launches its own, so the export half is tens of seconds
// of legitimate work. Every wait below says out loud what it is waiting for, so a
// slow run reads as slow rather than as hung.
//
// THE `page.request` QUESTION, because journeys.ts sets the rule (if a human
// would use the mouse, so does the flow) and this file leans on the exception.
// The share link is minted and revoked by CLICKING, because the ShareButton panel
// is the control an owner actually operates. The exports are fetched, because
// what this journey needs is the bytes of EVERY page side by side, and no gesture
// produces that: the PNG button hands a person one page at a time, and journey B
// already drives it — including its busy state and its error strip. Fetching here
// buys the comparison; clicking here would buy a second copy of journey B.
//
import { PDFDocument } from "pdf-lib";
import type { BrowserContext, Locator, Page } from "playwright";
import type { Flow } from "../harness";
import { expect, until } from "../harness";
import { canvasBox, pieceIds, slideBox, waitForCanvas } from "../editor";

/** The deck the suite drives, which this journey renders five different ways. */
const fixtureId = (): string => process.env.QA_DEV_SCRIPT_ID ?? "";

/** Documents this journey MAKES (when it cannot borrow the fixture), removed
 *  even if a step throws — a comparison subject is litter once it is read. */
const created = new Set<string>();

/** Fixtures this journey turned sharing ON for, revoked even if a step throws. */
const shared = new Set<string>();

/**
 * Text that means a renderer gave up, wherever it appears.
 *
 * The first two are the 2026-08-03 signatures — the ones that shipped. The rest
 * are what the same failure looks like when it happens a layer out, in the page
 * that hosts the frame rather than in the frame itself.
 */
const RENDER_ERROR =
  /(Render error:[^\n]{0,200}|Element type is invalid[^\n]{0,160}|Application error: a client-side exception|Unhandled Runtime Error|Internal Server Error)/;

/** What one page looks like from each of the five surfaces. */
interface PageAcross {
  /** 1-based, because that is what a person calls it. */
  page: number;
  editor: "content" | "error" | "empty";
  editorSays?: string;
  pieces: number;
  /** PNG export: bytes, pixel size, or the reason there are none. */
  pngBytes: number;
  pngWidth: number;
  pngHeight: number;
  pngFailed?: string;
  /** Share viewer: what the recipient's frame did with the same page. */
  viewer: "content" | "error" | "gone" | "unchecked";
  viewerSays?: string;
  viewerPieces: number;
}

/**
 * Open the fixture deck AS ITS OWNER, or say why that is not possible.
 *
 * Mirrors the helper journey D keeps to itself, and for the same reason:
 * `/preview/[id]` is owner-scoped (`loadScript` filters by ownerId), and so is
 * the export route, so every surface below is reachable only when the account in
 * QA_TEST_EMAIL happens to own the deck the harness pinned. That is a fact about
 * the machine, not a defect in the product — a journey that went red on it would
 * be pointing at the wrong thing entirely.
 */
/**
 * Build a deck this ACCOUNT owns, out of free primitives.
 *
 * The fixture belongs to DEV_OWNER_ID so the dev harness can open it, which
 * means the signed-in QA account cannot — and every surface here is
 * owner-scoped, so the journey skipped itself entirely and tested nothing.
 * A cross-surface comparison does not need clever content: it needs a deck
 * this account owns, with something on more than one page. Text primitives
 * are deterministic and cost no tokens, so the journey can make its own.
 */
const buildOwnDeck = async (
  page: Page,
  base: string,
): Promise<{ id: string } | { skip: string }> => {
  await page.goto(`${base}/api/documents/new`, { waitUntil: "domcontentloaded" });
  // ONE retry on a sign-in bounce. Signed-in flows replay a stored session
  // rather than signing in again, and under parallel load a server-rendered
  // route can be reached before that session is accepted — which made this
  // journey SKIP, comparing nothing at all. A skip is the most expensive
  // outcome here: it looks green. Same treatment as journey F; a second
  // bounce still gives up honestly.
  if (/\/sign-in/.test(page.url())) {
    await page.waitForTimeout(1500);
    await page.goto(`${base}/api/documents/new`, { waitUntil: "domcontentloaded" });
  }
  const id = /\/preview\/([^/?#]+)/.exec(page.url())?.[1];
  if (!id) return { skip: `creating a document did not open one (landed on ${page.url()})` };

  // The route says WHY in JSON on every failure path, and this helper had been
  // reporting only the status — which is how `op: "add"` sat here mis-spelled
  // for its whole life saying nothing more than "(400)".
  const reasonFrom = async (res: { text: () => Promise<string> }): Promise<string> => {
    const said = (await res.text().catch(() => "")).slice(0, 300);
    return /"error"\s*:\s*"([^"]+)"/.exec(said)?.[1] ?? said.replace(/\s+/g, " ").trim();
  };

  // INK FIRST, THEN COPY THE PAGE — not add-a-blank-then-fill-it.
  //
  // The obvious order (add a blank page 2, then insert text into it) is the one
  // this helper used to attempt, and on a hand-built document it does not work:
  // page-op adds the blank fine, and the very next insert-element into that new
  // scene answers 400 "inserted element did not materialize in the composition"
  // — the piece is written and then rolled back because the reassembled
  // template comes back without its slot. Measured on this checkout, twice.
  // Whether a deck that has actually been BUILT behaves the same way is not
  // something this journey established, so nothing here claims it.
  //
  // Duplicating a page that already has ink sidesteps that path entirely, and
  // it is a gesture the product offers anyway. Both pages then carry the same
  // three lines, which costs the comparison nothing: this journey compares each
  // page across surfaces, never one page against another.
  //
  // Enough ink to be a slide, not a word on a ground. PNG_INK_FLOOR is 20KB and
  // a single line compresses to ~13KB, so a one-element page would trip the
  // journey's own emptiness assertion on a deck that is perfectly fine — the
  // floor is the calibrated part and must not move, so the subject gets heavier.
  const lines = [
    { y: 220, h: 200, text: "The deck I see is the deck they get" },
    { y: 440, h: 240, text: "The same words should reach every surface it is rendered on." },
    { y: 700, h: 240, text: "Editor, PDF, PNG, shared viewer, link preview — five paths, one deck." },
  ];
  for (const line of lines) {
    const ins = await page.request.post(`${base}/api/preview/insert-element`, {
      data: {
        scriptId: id,
        sceneIndex: 0,
        bounds: { x: 160, y: line.y, w: 1600, h: line.h },
        mode: "primitive",
        primitive: "text",
        text: line.text,
      },
      failOnStatusCode: false,
    });
    if (ins.status() >= 400) {
      return { skip: `could not put text on page 1 (${ins.status()} — ${await reasonFrom(ins)})` };
    }
  }

  // A second page, because one page would let every per-page comparison below
  // pass without ever comparing anything.
  const dup = await page.request.post(`${base}/api/preview/page-op`, {
    data: { scriptId: id, op: "duplicate", page: 0 },
    failOnStatusCode: false,
  });
  if (dup.status() >= 400) {
    return { skip: `could not make a second page (${dup.status()} — ${await reasonFrom(dup)})` };
  }

  await page.goto(`${base}/preview/${id}`, { waitUntil: "domcontentloaded" });
  return { id };
};

const openFixtureAsOwner = async (
  page: Page,
  base: string,
): Promise<{ id: string } | { skip: string }> => {
  const id = fixtureId();
  if (!id) return { skip: "no fixture document is configured (QA_DEV_SCRIPT_ID is empty)" };

  const res = await page.goto(`${base}/preview/${encodeURIComponent(id)}`, {
    waitUntil: "domcontentloaded",
  });
  const status = res?.status() ?? 0;
  if (status >= 400 || !/\/preview\//.test(page.url())) {
    return {
      skip:
        `the fixture deck ${id} does not belong to the signed-in QA account ` +
        `(/preview/${id} answered ${status} and landed on ${page.url()}) — ` +
        "point QA_DEV_SCRIPT_ID at a deck that account owns, or sign in as its owner",
    };
  }

  // CAN OPEN and OWNS are different questions, and the share surfaces need the
  // second one. `loadScript` ORs in DEV_OWNER_ID outside production, so the
  // signed-in QA account opens the dev harness's fixture perfectly well — while
  // `shareStateFor`/`enableShare`/`disableShare` filter on ownerId STRICTLY,
  // with no such fallback. Measured on this checkout: the fixture is owned by
  // "dev-local", the QA account is a different user row, and the strict query
  // for that pair returns null, so GET /api/preview/share answers 404 forever.
  // The panel parks in its error branch and NO number of Try again presses can
  // move it — which is precisely how this journey came to compare three
  // surfaces out of five and report a pass. Asking the share route itself is
  // the only probe that answers the question the next 200 lines actually ask.
  const owns = await page.request.fetch(
    `${base}/api/preview/share?scriptId=${encodeURIComponent(id)}`,
    { failOnStatusCode: false },
  );
  if (owns.status() !== 200) {
    return {
      skip:
        `the fixture deck ${id} opens for the signed-in QA account but is not OWNED by it — the ` +
        `share status route answers ${owns.status()} for it, so its link, its viewer and its ` +
        "preview image can never be reached from this account (a dev-only read fallback makes it " +
        "readable; sharing has no such fallback)",
    };
  }
  return { id };
};

/**
 * The deck's pages as the rail lists them.
 *
 * Two digits, not `0\d`: the rail zero-pads (`String(i + 1).padStart(2, "0")`),
 * so page 10 reads "10" and a `0\d` filter silently stops counting at nine — the
 * page-count assertions below would then compare a truncated editor against a
 * complete PDF and blame the export. The aside's only other button is the "+",
 * whose text is a glyph, so digits are enough to tell them apart.
 */
const railPages = (page: Page) => page.locator("aside button").filter({ hasText: /^\s*\d\d/ });

/**
 * Which page the canvas is ACTUALLY showing, read from the loaded document.
 *
 * Not from the iframe's `src`, and not from its title: both change the instant
 * the rail is clicked, while the frame still holds the previous page. Reading
 * pieces in that window compares page N−1's canvas against page N's PNG, which
 * is the same shape of harness bug that once reported three product failures
 * that were not there. `contentWindow.location` is same-origin and only flips
 * when the new document commits, so it is the one thing on the page that answers
 * "what is on screen" rather than "what was asked for".
 */
const sceneOnScreen = async (page: Page): Promise<number | null> =>
  page.evaluate(() => {
    const f = document.querySelector("iframe") as HTMLIFrameElement | null;
    try {
      const href = f?.contentWindow?.location?.href ?? "";
      const scene = new URL(href, document.baseURI).searchParams.get("scene");
      return scene === null ? null : Number(scene);
    } catch {
      return null;
    }
  });

/**
 * Whatever a rendered frame is currently saying, once it has laid out.
 *
 * innerText needs LAYOUT — at domcontentloaded it answers "" for a document
 * whose markup is perfectly fine, which has already read as "the page is blank"
 * once in this suite. So it polls for text before reporting, and reports
 * whatever it finds rather than waiting for something specific: a page that
 * loads empty should be described as empty, not as a timeout.
 */
const frameText = async (page: Page, timeoutMs = 10_000): Promise<string> => {
  const read = async (): Promise<string> =>
    page.evaluate(() => {
      const d = (document.querySelector("iframe") as HTMLIFrameElement | null)?.contentDocument;
      return (d?.body?.innerText ?? "").replace(/\s+/g, " ").trim();
    });
  await until("the frame renders its text", async () => (await read()).length > 0, timeoutMs).catch(
    () => {},
  );
  return read();
};

/** The error a surface is showing, if it is showing one. Frame and host both. */
const renderErrorOn = async (page: Page): Promise<string | null> => {
  const inFrame = RENDER_ERROR.exec(await frameText(page, 4_000));
  if (inFrame) return inFrame[1];
  const host = await page.evaluate(() => (document.body?.innerText ?? "").replace(/\s+/g, " ").trim());
  return RENDER_ERROR.exec(host)?.[1] ?? null;
};

/**
 * One page of an export, or the reason the server would not produce it.
 *
 * The route answers JSON `{error}` with a sentence on every failure path, so a
 * failed export can say what a person would have been told instead of "500".
 */
const exportOf = async (
  page: Page,
  base: string,
  id: string,
  query: string,
  timeoutMs: number,
): Promise<{ bytes: Buffer | null; failed: string | null }> => {
  const res = await page.request.fetch(
    `${base}/api/preview/${encodeURIComponent(id)}/export?${query}`,
    { failOnStatusCode: false, timeout: timeoutMs },
  );
  if (res.status() !== 200) {
    const said = (await res.text().catch(() => "")).slice(0, 300);
    const human = /"error"\s*:\s*"([^"]+)"/.exec(said)?.[1] ?? said.replace(/\s+/g, " ").trim();
    return { bytes: null, failed: `${res.status()} — ${human || "no reason given"}` };
  }
  return { bytes: await res.body(), failed: null };
};

/**
 * A PNG's real pixel dimensions, straight out of its IHDR header.
 *
 * Eight bytes of signature, a chunk length, "IHDR", then width and height as
 * big-endian 32-bit ints. No decoder and no dependency — and it doubles as a
 * validity check, because anything that is not a PNG fails at the signature
 * rather than at some later assertion about its size.
 */
const pngSize = (bytes: Buffer): { width: number; height: number } | null => {
  if (bytes.length < 24) return null;
  if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return null;
  if (bytes.subarray(12, 16).toString("latin1") !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};

/**
 * The floor under "this PNG has something on it", MEASURED rather than guessed.
 *
 * Rendered at 1920×1080 through this same Chromium: a solid-colour page is 8.5KB,
 * one word on a plain ground is 12.8KB, and React's "Element type is invalid"
 * message — the thing this journey exists to catch — is 14.3KB. Real built slides
 * in src/generated run 199KB to 1.8MB. 20KB sits in that gap and close to the
 * noise floor on purpose: it fires on a blank rectangle or an error page and
 * cannot fire on a sparse-but-real slide, because a suite that cries wolf gets
 * ignored precisely when it is right.
 *
 * The one thing it assumes is a full-size canvas. A deck rendered much smaller
 * than 1920×1080 would compress under this honestly, and the flow would call a
 * real slide empty — so the per-page sizes are noted every run alongside the
 * assertion, and a red here should be read against those numbers first.
 */
const PNG_INK_FLOOR = 20_000;

/**
 * How many times the owner presses "Try again" before the flow gives up.
 *
 * Bounded, not infinite: the point of retrying is to survive a status fetch that
 * lost a race, not to hide a share API that is genuinely down. Three presses of
 * a button a person would press once is generous; a fourth would be the flow
 * refusing to report bad news.
 */
const SHARE_RETRY_PRESSES = 3;

/**
 * The share panel's link, created by clicking, exactly as journey D does it.
 *
 * waitFor, never isVisible({timeout}): the panel fetches its share state before
 * it can render anything and shows "Checking…" meanwhile, so a non-polling check
 * answers false and the button is never pressed. Duplicated rather than shared
 * because the two journeys assert different things about the same panel, and a
 * helper that has to serve both ends up asserting neither.
 *
 * WHY THIS RETRIES, and why it is not papering over a bug. The panel loads its
 * status once, AT MOUNT — long before this journey reaches step 4, because the
 * PDF and the PNGs in front of it take minutes. A status fetch that lost its
 * race back then leaves the panel parked in its error branch ("Couldn't check
 * the share status" + a Try again button) for the rest of the page's life, and
 * the earlier version of this helper read that branch as "never resolved",
 * skipped, and compared three surfaces out of five. The share route itself was
 * healthy throughout — probed on a fresh document, it answered 200 four times
 * running. So the recovery is the one the product already offers its owner:
 * press Try again. The panel's error branch is a REAL state a user can be in,
 * and a flow that cannot get past it is not testing the surfaces that matter
 * most — the viewer and the unfurl are what a RECIPIENT sees, and the only two
 * surfaces here that nobody signed in ever looks at.
 */
const shareLinkByClicking = async (
  page: Page,
): Promise<{ url: string; retried: number } | { skip: string }> => {
  const button = page.locator("[data-rb-share]").first();
  const present = await button
    .waitFor({ state: "visible", timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  if (!present) return { skip: "the editor opened but never showed a share control" };
  await button.click();

  const panel = page.getByRole("dialog", { name: /share this document/i });
  await panel.waitFor({ state: "visible", timeout: 15_000 });

  const create = panel.getByRole("button", { name: /create a link/i }).first();
  const field = panel.getByRole("textbox", { name: /public link/i }).first();
  const tryAgain = panel.getByRole("button", { name: /try again/i }).first();
  // isVisible with no timeout INSIDE until() is the correct pairing — until does
  // the polling, the check answers now.
  const showing = (l: Locator): Promise<boolean> => l.isVisible().catch(() => false);

  let retried = 0;
  let ready = false;
  let stuckOnChecking = false;
  for (;;) {
    // SETTLED means the panel has stopped saying "Checking…" — three of its
    // four states, not just the two good ones. Waiting only for the good two is
    // what made the error branch indistinguishable from a hang, and the flow
    // then spent its whole budget confirming a state it could have fixed in a
    // click. The first pass keeps the original 25s tolerance because that one
    // may still be waiting on a genuinely cold fetch; the retries are short,
    // because by then the route has answered once and the journey has already
    // spent minutes on the exports.
    const settled = await until(
      retried === 0
        ? "the share panel finishes checking and offers either a link or a way to make one"
        : `the share panel finishes re-checking after Try again (press ${retried} of ${SHARE_RETRY_PRESSES})`,
      async () => (await showing(create)) || (await showing(field)) || (await showing(tryAgain)),
      retried === 0 ? 25_000 : 12_000,
    )
      .then(() => true)
      .catch(() => false);

    if (settled && ((await showing(create)) || (await showing(field)))) {
      ready = true;
      break;
    }
    if (!settled) {
      // Never left "Checking…" at all: there is no control to press, so there
      // is nothing a retry could do that this wait did not already do.
      stuckOnChecking = true;
      break;
    }
    if (retried >= SHARE_RETRY_PRESSES) break;
    retried++;
    await tryAgain.click().catch(() => {});
    // load() clears the error before it re-fetches, so the button goes away and
    // "Checking…" comes back. Waiting for that hand-off keeps the next poll
    // from reading the pre-click frame and burning a press on it.
    await tryAgain.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
  }

  if (!ready) {
    const said = (await panel.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    return {
      skip: stuckOnChecking
        ? `the share panel never left "Checking…" — it says: "${said.slice(0, 120)}"`
        : `the share panel could not read the share status, and ${SHARE_RETRY_PRESSES} presses of ` +
          `its own Try again button did not change that — it says: "${said.slice(0, 120)}"`,
    };
  }

  if (await showing(create)) await create.click();
  await field.waitFor({ state: "visible", timeout: 20_000 });
  const url = await field.inputValue();
  expect(
    /\/s\/[^/]+$/.test(url),
    `the panel should hand the owner a public link to send, and instead shows "${url}"`,
  );
  return { url, retried };
};

/** Turn sharing off through the panel, the way the owner would. */
const stopSharingByClicking = async (page: Page): Promise<boolean> => {
  const panel = page.getByRole("dialog", { name: /share this document/i });
  if (!(await panel.isVisible().catch(() => false))) {
    const opened = await page
      .locator("[data-rb-share]")
      .first()
      .click()
      .then(() => true)
      .catch(() => false);
    if (!opened) return false;
    const showed = await panel
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    if (!showed) return false;
  }
  const stop = panel.getByRole("button", { name: /stop sharing/i }).first();
  const clickable = await stop
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!clickable) return false;
  await stop.click();
  // The owner's own proof it worked: the panel falls back to offering a new one.
  return panel
    .getByRole("button", { name: /create a link/i })
    .first()
    .waitFor({ state: "visible", timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
};

/** Revoke whatever this journey left on the fixture, from anywhere. */
const revoke = async (page: Page, base: string, id: string): Promise<void> => {
  const res = await page.context().request.fetch(`${base}/api/preview/share`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    data: { scriptId: id },
    failOnStatusCode: false,
  });
  // Already private is the goal state for a cleanup, not a failure.
  if (res.status() < 400 || res.status() === 404) shared.delete(id);
};

/** A browser holding none of the owner's cookies — what a recipient is. */
const strangerContext = async (page: Page): Promise<BrowserContext> =>
  page.context().browser()!.newContext({ viewport: { width: 1440, height: 900 } });

/**
 * Where the recipient is in the deck, as two numbers.
 *
 * Read as digits, never matched against a string: the counter carries live
 * state, and a flow that hardcodes "1 / 5" breaks the day somebody improves the
 * label — which has already happened once in this suite, to the PNG button.
 */
const counterOn = async (visitor: Page): Promise<{ at: number; of: number } | null> =>
  visitor.evaluate(() => {
    const m = /(\d+)\s*\/\s*(\d+)/.exec(document.querySelector("footer")?.innerText ?? "");
    return m ? { at: Number(m[1]), of: Number(m[2]) } : null;
  });

/**
 * What the share viewer's frame is showing for the page it is on.
 *
 * `covered` is the loading veil the viewer paints over the frame until the
 * document loads; nothing can be concluded until it lifts. `gone` is the public
 * route's own quiet document — it serves one for a revoked link AND one for a
 * page it could not render, which is exactly the disagreement this journey
 * hunts, so the heading is carried out to tell those two apart.
 */
const viewerFrame = async (
  visitor: Page,
): Promise<{ covered: boolean; gone: boolean; heading: string; pieces: number; text: string }> =>
  visitor.evaluate(() => {
    const empty = { covered: true, gone: false, heading: "", pieces: 0, text: "" };
    const f = document.querySelector("iframe") as HTMLIFrameElement | null;
    const d = f?.contentDocument;
    if (!f || !d?.body) return empty;
    const host = f.getBoundingClientRect();
    const onTop = document.elementFromPoint(host.left + host.width / 2, host.top + host.height / 2);
    const ids = new Set<string>();
    for (const el of Array.from(d.querySelectorAll("[data-piece]"))) {
      const id = el.getAttribute("data-piece");
      if (id) ids.add(id);
    }
    return {
      covered: onTop?.tagName !== "IFRAME",
      gone: d.body.hasAttribute("data-share-gone"),
      heading: (d.querySelector("h1")?.textContent ?? "").trim(),
      pieces: ids.size,
      text: (d.body.innerText ?? "").replace(/\s+/g, " ").trim(),
    };
  });

/**
 * Wait for the veil to lift, then report whatever is behind it.
 *
 * 90s for the first page: the frame is compiled on demand (esbuild over
 * Composition.tsx) and the suite runs several flows against one dev server, so a
 * cold page legitimately takes far longer than a warm one. A wait sized to the
 * warm case reports a healthy product as broken.
 */
const viewerPage = async (
  visitor: Page,
  what: string,
  timeoutMs = 90_000,
): Promise<Awaited<ReturnType<typeof viewerFrame>>> => {
  await until(what, async () => !(await viewerFrame(visitor)).covered, timeoutMs);
  await visitor.waitForTimeout(300); // a beat for the frame to paint what it loaded
  return viewerFrame(visitor);
};

export const surfaceFlows: Flow[] = [
  {
    name: "JOURNEY H — the deck I see is the deck they get, in all five places it is rendered",
    // FREE: exports and sharing are deterministic. Nothing here calls a model.
    tier: "free",
    needsAuth: true,
    // Writes a share token onto the fixture's row, so it runs alone — and so it
    // cannot race share.ts, which asserts the same fixture is NOT shared.
    mutates: true,
    run: async ({ page, base, note }) => {
      // Prefer a deck this account already owns; otherwise build one. The
      // fixture is owned by the dev harness, so on most machines this journey
      // makes its own subject rather than skipping and testing nothing.
      const owned = await openFixtureAsOwner(page, base);
      let subject: { id: string };
      let builtItself = false;
      if ("skip" in owned) {
        note(`not using the configured fixture: ${owned.skip}`);
        const made = await buildOwnDeck(page, base);
        if ("skip" in made) {
          note(`skipped: ${made.skip}`);
          return;
        }
        subject = made;
        builtItself = true;
      } else {
        subject = owned;
      }
      const { id } = subject;
      // Only decks this journey BUILT are litter. Registering a borrowed
      // fixture here hands it to the cleanup flow's DELETE — which no-ops today
      // only because the fixture belongs to someone else, and would succeed the
      // moment the QA account really does own the deck it was pointed at.
      if (builtItself) created.add(id);
      note(
        `comparing surfaces for ${id} ` +
          (builtItself ? "(built by this journey)" : "(the configured fixture)"),
      );

      // ── 1. THE EDITOR — the surface the owner judges the deck by ────────────
      // Everything below is compared against this one, so if the deck is broken
      // here there is nothing to compare and saying so is more useful than a red.
      const ownerSees = await until(
        "the owner's own canvas renders the deck",
        async () => (await pieceIds(page)).length > 0,
        90_000,
      )
        .then(() => true)
        .catch(() => false);
      if (!ownerSees) {
        note(
          `skipped: the fixture deck ${id} renders nothing for its OWNER, so every other surface ` +
            "would be judged against a deck that has nothing on it",
        );
        return;
      }

      const rail = railPages(page);
      const pages = Math.max(1, await rail.count());
      const across: PageAcross[] = [];
      note(`the editor lists ${pages} page${pages === 1 ? "" : "s"} in the rail`);

      for (let i = 0; i < pages; i++) {
        if (i > 0) await rail.nth(i).click();
        const showing = await until(
          `the canvas to finish switching to page ${i + 1}`,
          async () => (await sceneOnScreen(page)) === i,
          30_000,
        )
          .then(() => true)
          .catch(() => false);
        if (!showing) {
          // Said out loud rather than slept through: if the flow cannot confirm
          // which page the canvas holds, the comparison it is about to make is
          // between two pages that may not be the same one.
          note(
            `could not confirm the canvas switched to page ${i + 1} — the frame's own URL never ` +
              "said so, so this page's editor reading may describe its neighbour",
          );
          await page.waitForTimeout(3000);
        }
        // Swallowed on purpose: a page with nothing on it is a VERDICT this
        // journey records ("empty") and compares against the other surfaces, not
        // a timeout to fail on. On a built fixture every page has pieces, so the
        // 90s inside waitForCanvas — sized for a cold on-demand esbuild compile
        // under parallel load — is a ceiling that is never actually reached.
        await waitForCanvas(page).catch(() => {});
        const says = await renderErrorOn(page);
        const pieces = (await pieceIds(page)).length;
        across.push({
          page: i + 1,
          editor: says ? "error" : pieces > 0 ? "content" : "empty",
          ...(says ? { editorSays: says.slice(0, 120) } : {}),
          pieces,
          pngBytes: 0,
          pngWidth: 0,
          pngHeight: 0,
          viewer: "unchecked",
          viewerPieces: 0,
        });
      }
      const withInk = across.filter((p) => p.editor === "content");
      note(
        `editor: ${withInk.length} page(s) with content, ` +
          `${across.filter((p) => p.editor === "empty").length} empty, ` +
          `${across.filter((p) => p.editor === "error").length} showing an error`,
      );

      // Fail here rather than at the invariant if the EDITOR is the broken one.
      // Not only because a slide the owner cannot see is a bug on its own, but
      // because the invariant at the end compares surfaces against each other:
      // if every surface faithfully reproduces the same dead slide they all
      // agree, and a check that only asks about agreement would call that fine.
      const deadInEditor = across.filter((p) => p.editor === "error");
      expect(
        deadInEditor.length === 0,
        `the deck the owner has open renders an error instead of a slide on page ` +
          `${deadInEditor.map((p) => `${p.page} ("${p.editorSays}")`).join(", ")} — the export, the ` +
          "share link and the link preview all render from this same document, so whoever it is " +
          "sent to inherits the dead page too",
      );

      // The aspect the owner is looking at, for the geometry comparison below.
      // Measured off the canvas rather than read off the "1920 × 1080" readout:
      // a number in the chrome is what the app CLAIMS, and the frame is what it
      // actually gave the user.
      // The SLIDE, not the frame around it: the frame's height follows the
      // editor chrome, so measuring it reported the deck as stretched when it
      // was only letterboxed. Verified at the harness's own viewport — the
      // slide is 1.778 in both the dev and production editors.
      const stage = (await slideBox(page).catch(() => null)) ?? (await canvasBox(page).catch(() => null));
      const editorAspect = stage && stage.height > 0 ? stage.width / stage.height : null;

      // ── 2. THE PDF — the file people email ──────────────────────────────────
      note("asking for the whole deck as a PDF — every page is rendered in a real browser, so this takes tens of seconds");
      const pdfOut = await exportOf(page, base, id, "format=pdf", 300_000);
      expect(
        pdfOut.failed === null,
        `the deck the owner is looking at, page by page, would not export as a PDF: ${pdfOut.failed}`,
      );
      const pdfBytes = pdfOut.bytes!;

      // COUNTING THE PAGES, and why not by counting bytes. The obvious
      // dependency-free trick — counting "/Type /Page" in the raw file — returns
      // ZERO for every deck this product makes, measured on a PDF built exactly
      // the way lib/render/export-static.ts builds one: pdf-lib's save() packs
      // page dictionaries into Flate-compressed object streams, so the string is
      // never in the bytes. Parsing with pdf-lib instead is not a new dependency
      // (it is already what writes the file) and it is a real parse of the real
      // container — and the number it yields is compared against the EDITOR's
      // page count, not against the exporter's own idea of one, so a page the
      // export silently drops still fails here.
      let pdfAspect: number | null = null;
      const parsed = await PDFDocument.load(pdfBytes).catch(() => null);
      expect(
        parsed !== null,
        `the deck exported ${Math.round(pdfBytes.length / 1024)}KB that is not a PDF a reader could ` +
          "open — whatever the owner downloads, it is not their deck",
      );
      const pdfPages = parsed!.getPageCount();
      const firstPdfPage = pdfPages > 0 ? parsed!.getPage(0).getSize() : null;
      if (firstPdfPage && firstPdfPage.height > 0) pdfAspect = firstPdfPage.width / firstPdfPage.height;
      note(
        `PDF: ${pdfPages} page(s), ${Math.round(pdfBytes.length / 1024)}KB` +
          (firstPdfPage ? `, ${Math.round(firstPdfPage.width)}×${Math.round(firstPdfPage.height)}pt` : ""),
      );
      expect(
        pdfPages === pages,
        `the deck has ${pages} page(s) on screen and its PDF has ${pdfPages} — whoever the owner ` +
          `sends this file to reads a different document from the one the owner made`,
      );

      // ── 3. THE PNGs — one page at a time, the way people put slides in docs ──
      note(`exporting all ${pages} page(s) as PNGs — each one launches its own renderer, so allow a minute or two`);
      for (const entry of across) {
        const shot = await exportOf(page, base, id, `format=png&scene=${entry.page - 1}`, 180_000);
        if (shot.failed !== null || shot.bytes === null) {
          entry.pngFailed = shot.failed ?? "the server answered 200 with no image in it";
          continue;
        }
        const size = pngSize(shot.bytes);
        entry.pngBytes = shot.bytes.length;
        entry.pngWidth = size?.width ?? 0;
        entry.pngHeight = size?.height ?? 0;
        if (!size) entry.pngFailed = "the bytes came back as something that is not a PNG";
      }
      note(
        `PNG sizes by page: ${across
          .map((p) => (p.pngFailed ? `${p.page}:FAILED` : `${p.page}:${Math.round(p.pngBytes / 1024)}KB`))
          .join("  ")}`,
      );

      const pngBroken = across.filter((p) => p.pngFailed);
      expect(
        pngBroken.length === 0,
        `page ${pngBroken
          .map((p) => `${p.page} (${p.pngFailed}; the editor shows ${p.pieces} element(s) there)`)
          .join(", ")} would not export as an image — the owner goes to drop a slide into a doc ` +
          "and gets nothing, from a page they can see perfectly well",
      );

      // A page with ink on it in the editor must arrive as an image with ink in
      // it. See PNG_INK_FLOOR for the measurements behind the number.
      const thin = withInk.filter((p) => p.pngBytes < PNG_INK_FLOOR);
      expect(
        thin.length === 0,
        `page ${thin
          .map((p) => `${p.page} (${Math.round(p.pngBytes / 1024)}KB)`)
          .join(", ")} exported as an image far too small to have anything on it, while the editor ` +
          `renders ${thin.map((p) => p.pieces).join("/")} element(s) there — that is what a blank ` +
          "rectangle or an error message costs to compress, not a slide",
      );

      // Every page is the same shape as every other, and the same shape the
      // owner is looking at. A deck whose page 3 exports letterboxed is a deck
      // nobody can present.
      const sized = across.filter((p) => p.pngWidth > 0);
      const odd = sized.filter(
        (p) => p.pngWidth !== sized[0].pngWidth || p.pngHeight !== sized[0].pngHeight,
      );
      expect(
        odd.length === 0,
        `the exported pages are not all the same size — page ${odd
          .map((p) => `${p.page} is ${p.pngWidth}×${p.pngHeight}`)
          .join(", ")} against ${sized[0]?.pngWidth}×${sized[0]?.pngHeight} for the rest; a deck ` +
          "whose pages change shape halfway cannot be presented",
      );
      if (sized.length && sized[0].pngHeight > 0) {
        const pngAspect = sized[0].pngWidth / sized[0].pngHeight;
        note(
          `geometry: canvas ${editorAspect ? editorAspect.toFixed(3) : "unmeasured"} · ` +
            `PDF ${pdfAspect ? pdfAspect.toFixed(3) : "unmeasured"} · PNG ${pngAspect.toFixed(3)}`,
        );
        if (pdfAspect) {
          expect(
            Math.abs(pngAspect - pdfAspect) / pdfAspect < 0.02,
            `the PDF pages are ${pdfAspect.toFixed(3)}:1 and the PNGs are ${pngAspect.toFixed(3)}:1 — ` +
              "the same slide is being stretched or letterboxed in one of the two files somebody sends",
          );
        }
        if (editorAspect) {
          expect(
            Math.abs(pngAspect - editorAspect) / editorAspect < 0.02,
            `the owner is composing on a ${editorAspect.toFixed(3)}:1 canvas and exporting ` +
              `${pngAspect.toFixed(3)}:1 images — what they arrange is not what comes out`,
          );
        }
      }

      // ── 4. THE SHARE VIEWER — the same deck, to somebody with no account ─────
      const link = await shareLinkByClicking(page);
      if ("skip" in link) {
        // Spelled out, because the honest-but-quiet version of this line read
        // like a footnote and the run passed looking complete. Two of the five
        // surfaces are missing, and they are the two only a RECIPIENT ever
        // sees — nothing below can vouch for them.
        note(
          `PARTIAL COMPARISON — 3 of 5 surfaces only. The share viewer and the link-preview ` +
            `image were NOT compared this run, so a page that renders for the owner and breaks ` +
            `for the recipient would NOT have been caught. Reason: ${link.skip}`,
        );
      } else {
        shared.add(id);
        if (link.retried > 0) {
          note(
            `the share panel came up unable to read its status; it took ${link.retried} press(es) ` +
              "of its own Try again button to get a link (the panel loads its status at mount, " +
              "minutes before this step)",
          );
        }
        // Navigate against the base under test, not the origin baked into the
        // panel's value, so this still works through a tunnel or a preview
        // deployment. The panel's own URL is asserted inside the helper.
        const linkPath = link.url.replace(/^https?:\/\/[^/]+/, "");
        note(`owner created ${linkPath}`);

        const stranger = await strangerContext(page);
        try {
          const visitor = await stranger.newPage();
          const landed = await visitor.goto(`${base}${linkPath}`, { waitUntil: "domcontentloaded" });
          expect(
            landed?.status() === 200,
            `the link the owner just created does not open for anyone else, it answers ${landed?.status()}`,
          );

          // Polled, not read once. The counter lives in innerText, and innerText
          // needs LAYOUT — at domcontentloaded it answers "" for markup that is
          // perfectly correct, which this suite has already once read as missing
          // copy. So this waits for the viewer to actually say a number before
          // concluding it never says one.
          const counter = await until(
            "the shared deck to tell the recipient how many pages it has",
            async () => (await counterOn(visitor)) !== null,
            30_000,
          )
            .then(() => counterOn(visitor))
            .catch(() => null);
          expect(
            !!counter,
            "the shared deck never told the recipient how long it is — there is no page count on screen",
          );
          expect(
            counter!.of === pages,
            `the owner's editor lists ${pages} page(s) and the link they sent offers ${counter!.of} — ` +
              "the recipient is reading a different document from the one the owner is looking at",
          );

          for (let i = 0; i < pages; i++) {
            if (i > 0) {
              // The arrow, matched by what it MEANS: the button wears a glyph
              // and the counter beside it carries live state, so neither is
              // something to match on.
              const forward = visitor.getByRole("button", { name: /next page/i }).first();
              await forward.waitFor({ state: "visible", timeout: 15_000 });
              await forward.click();
              // Caught rather than thrown: whether the arrows work is journey
              // D's subject, and a stranded page turn here should record what
              // this surface showed for that page, not replace the whole
              // cross-surface table with a navigation timeout.
              const arrived = await until(
                `the recipient's viewer to reach page ${i + 1}`,
                async () => (await counterOn(visitor))?.at === i + 1,
                30_000,
              )
                .then(() => true)
                .catch(() => false);
              if (!arrived) {
                across[i].viewer = "error";
                across[i].viewerSays = "the recipient could not get to this page at all";
                continue;
              }
            }
            const frame = await viewerPage(
              visitor,
              `page ${i + 1} of the deck appears for the recipient`,
              i === 0 ? 90_000 : 60_000,
            ).catch(() => null);
            const entry = across[i];
            if (!frame) {
              entry.viewer = "error";
              entry.viewerSays = "the page never finished loading for the recipient";
              continue;
            }
            entry.viewerPieces = frame.pieces;
            if (frame.gone) {
              // The public route serves its quiet document for BOTH a dead link
              // and a page it could not render, and the heading is the only
              // thing that separates them — the second is precisely the
              // disagreement this journey is looking for.
              entry.viewer = /no longer active/i.test(frame.heading) ? "gone" : "error";
              entry.viewerSays = frame.heading || frame.text.slice(0, 120);
            } else if (RENDER_ERROR.test(frame.text)) {
              entry.viewer = "error";
              entry.viewerSays = RENDER_ERROR.exec(frame.text)?.[1]?.slice(0, 120);
            } else {
              entry.viewer = frame.pieces > 0 || frame.text.length > 0 ? "content" : "error";
              if (entry.viewer === "error") entry.viewerSays = "the page arrived as an empty frame";
            }
          }
          note(
            `shared viewer, pieces per page (editor / recipient): ${across
              .map((p) => `${p.page}: ${p.pieces}/${p.viewerPieces}`)
              .join("  ")}`,
          );

          // ── 5. THE LINK PREVIEW — the deck as a chat client draws it ─────────
          // Fetched, not read off the DOM: the consumer of this surface is an
          // unfurler that pulls the HTML and never runs a line of JavaScript, so
          // fetching is what a faithful test of it looks like.
          const html = await (
            await visitor.request.fetch(`${base}${linkPath}`, { failOnStatusCode: false })
          ).text();
          const declared = /<meta property="og:image" content="([^"]+)"/.exec(html)?.[1] ?? "";
          expect(
            !!declared,
            "the shared page declares no preview image — pasted into a chat, the deck unfurls as nothing",
          );
          // The declared URL is absolute against metadataBase, which falls back
          // to https://renderball.com whenever NEXT_PUBLIC_APP_URL is unset — as
          // it is on a dev checkout. Fetching it verbatim would quietly test
          // PRODUCTION from a local run and report its health as this build's.
          const ogPath = declared.replace(/^https?:\/\/[^/]+/, "");
          const card = await visitor.request.fetch(`${base}${ogPath}`, {
            failOnStatusCode: false,
            timeout: 120_000,
          });
          expect(
            card.status() === 200,
            `the link preview image answers ${card.status()} for the deck the recipient can read ` +
              "perfectly well — the link unfurls as a broken card in every chat it is pasted into",
          );
          const cardBytes = await card.body();
          const looksLikeAnImage =
            !!pngSize(cardBytes) || cardBytes.subarray(0, 3).toString("hex") === "ffd8ff";
          expect(
            looksLikeAnImage,
            `the link preview served ${cardBytes.length} bytes that are not an image ` +
              `(content-type "${card.headers()["content-type"] ?? "none"}")`,
          );
          note(`og:image ${ogPath} — ${Math.round(cardBytes.length / 1024)}KB, a real image`);

          // The owner turns it off again, by clicking, because that is the
          // control they operate. The finally below is the safety net, not the
          // asserted path.
          const off = await stopSharingByClicking(page);
          if (off) {
            shared.delete(id);
            note("owner clicked Stop sharing, and the panel offered to make a new link");
          } else {
            note("could not turn sharing off through the panel — the link is revoked below instead");
          }
        } finally {
          await stranger.close().catch(() => {});
          // The one place `request` belongs in this file's owner half: after a
          // failed assertion the owner's page can be anywhere at all and there
          // may be no panel left to click, but the fixture deck must not stay
          // public just because this flow went red. The CLICKED path above is
          // the asserted one; this is the safety net under it.
          if (shared.has(id)) await revoke(page, base, id);
        }
      }

      // ── 6. THE INVARIANT ─────────────────────────────────────────────────────
      // Every individual surface above has now passed its own test. This is the
      // assertion none of them can make: that they AGREE. A page that renders
      // content in one place and an error in another is the 2026-08-03 bug, and
      // it is a bug whichever of the two is right.
      const disagreements: string[] = [];
      for (const p of across) {
        const surfaces: string[] = [];
        if (p.editor === "content") surfaces.push("the editor shows it");
        if (p.editor === "error") surfaces.push(`the editor shows "${p.editorSays}"`);
        if (p.pngFailed) surfaces.push(`the PNG export failed (${p.pngFailed})`);
        else if (p.editor === "content" && p.pngBytes < PNG_INK_FLOOR) {
          surfaces.push(`the PNG came out empty (${Math.round(p.pngBytes / 1024)}KB)`);
        }
        if (p.viewer === "error") surfaces.push(`the shared link shows "${p.viewerSays}"`);
        if (p.viewer === "gone") surfaces.push("the shared link says the deck is no longer available");
        if (p.editor === "content" && p.viewer === "content") continue;
        const broken =
          p.editor === "error" ||
          !!p.pngFailed ||
          p.viewer === "error" ||
          p.viewer === "gone" ||
          (p.editor === "content" && p.pngBytes < PNG_INK_FLOOR);
        const fine = p.editor === "content" || p.viewer === "content" || p.pngBytes >= PNG_INK_FLOOR;
        if (broken && fine) disagreements.push(`page ${p.page}: ${surfaces.join("; ")}`);
      }
      expect(
        disagreements.length === 0,
        `the same deck renders differently depending on where it is opened — ${disagreements.join(
          " | ",
        )}. Whichever surface is right, the owner cannot see the broken one from their editor, and ` +
          "the person they sent it to has no way to tell them",
      );
      const full = across.some((p) => p.viewer !== "unchecked");
      note(
        full
          ? `all ${pages} page(s) agree across all five surfaces: the editor, the PDF, the PNGs, ` +
              "the shared link and its preview image"
          : `all ${pages} page(s) agree across the editor, the PDF and the PNGs — 3 SURFACES OF 5. ` +
              "The shared link and its preview image were not compared, so this run does NOT say " +
              "the deck the owner sees is the deck a recipient gets",
      );
    },
  },

  {
    name: "no share link from the surfaces journey is left behind",
    tier: "free",
    needsAuth: true,
    mutates: true,
    run: async ({ page, base, note }) => {
      const leftovers = [...shared];
      for (const id of leftovers) await revoke(page, base, id);

      // The journey builds its own subject when the fixture is not its to
      // read; that document is scaffolding, not a result.
      const mine = [...created];
      // WARM THE SESSION FIRST, with a real page load.
      //
      // page.request.fetch sends the stored cookie but runs no client JS, so
      // it cannot refresh a Clerk token that has aged out during the run — it
      // just posts a stale JWT and collects a 401. A navigation does refresh
      // it, because the app boots. That is why a late cleanup failed twice in
      // a row while every earlier flow was fine, and why a document was left
      // on a real account.
      if (mine.length) {
        await page.goto(`${base}/documents`, { waitUntil: "domcontentloaded" }).catch(() => {});
      }
      for (const id of mine) {
        // Two attempts. A replayed session can be refused mid-suite (the same
        // bounce that made this journey skip), and a cleanup that gives up on
        // the first 401 leaves a real document behind on a real account —
        // which is exactly what happened, and it is litter, not a false red.
        let status = 0;
        for (let attempt = 0; attempt < 2; attempt++) {
          const res = await page.request.fetch(`${base}/api/documents/${encodeURIComponent(id)}`, {
            method: "DELETE",
            failOnStatusCode: false,
          });
          status = res.status();
          if (status < 400 || status === 404) break;
          await page.waitForTimeout(1500);
        }
        if (status < 400 || status === 404) created.delete(id);
        else note(`! deleting ${id} answered ${status} twice`);
      }
      if (mine.length) note(`discarded ${mine.length} document(s) the journey built to compare`);
      expect(
        created.size === 0,
        `could not clean up the comparison document(s): ${[...created].join(", ")}`,
      );
      note(
        leftovers.length
          ? `revoked ${leftovers.length} link${leftovers.length > 1 ? "s" : ""} the journey left live`
          : "nothing left shared",
      );
      expect(
        shared.size === 0,
        `could not turn sharing back off for: ${[...shared].join(", ")} — the fixture deck is now ` +
          "public to anyone holding the link this run created",
      );
    },
  },
];
