//
// The two ways people actually use this product, driven end to end.
//
// Everything else in this suite tests a capability — can an element be
// resized, does a share link die when revoked. These two test a SESSION: the
// sequence a real person performs, in order, with each step depending on the
// last. That is a different question, and it is the one that decides whether
// the product works.
//
// THEY COST MONEY, which is why they sit above the free tier:
//
//   Journey A (tier "full")  — a whole deck built from a brief: ~$1.00–1.60
//                              and 20–37 minutes, then edited and exported.
//   Journey B (tier "smoke") — a blank canvas filled one drawn box at a time:
//                              a few cents per element, minutes not hours.
//
// Both clean up after themselves. A journey that leaves a deck behind makes
// the next run's document list assertions meaningless.
//
import type { Page } from "playwright";
import type { Flow } from "../harness";
import { expect, until } from "../harness";
import {
  canvasBox,
  drawBox,
  pieceIds,
  pickEditablePiece,
  pieceBox,
  selectPiece,
  tool,
  waitForCanvas,
} from "../editor";

/** Documents these journeys create, removed even if a step fails. */
const created = new Set<string>();

const openDocumentId = (page: Page): string | null =>
  /\/preview\/([^/?#]+)/.exec(page.url())?.[1] ?? null;

/** A blank document, the way the New-document button makes one. Zero tokens. */
const newDocument = async (page: Page, base: string): Promise<string> => {
  const res = await page.goto(`${base}/api/documents/new`, { waitUntil: "domcontentloaded" });
  expect((res?.status() ?? 0) < 400, `creating a document should succeed, got ${res?.status()}`);
  await until("the editor opens on the new document", async () => !!openDocumentId(page), 30000);
  const id = openDocumentId(page)!;
  created.add(id);
  return id;
};

const discard = async (page: Page, base: string, id: string): Promise<void> => {
  const res = await page.request.fetch(`${base}/api/documents/${encodeURIComponent(id)}`, {
    method: "DELETE",
    failOnStatusCode: false,
  });
  if (res.status() < 400) created.delete(id);
};

/** The generate prompt that appears inside a drawn marquee. */
const PROMPT_SEL = 'input[aria-label^="Describe the element"], input[placeholder^="What goes here"]';

/**
 * Draw a box and describe what belongs in it — the product's core gesture.
 *
 * Returns how many pieces the slide gained, so a caller can tell "the model
 * produced nothing" from "the model produced something".
 */
const generateInBox = async (
  page: Page,
  area: { x0: number; y0: number; x1: number; y1: number },
  description: string,
): Promise<number> => {
  const before = (await pieceIds(page)).length;
  await tool(page, "Generate").click();
  const c = await canvasBox(page);
  await drawBox(
    page,
    { x: c.x + c.width * area.x0, y: c.y + c.height * area.y0 },
    { x: c.x + c.width * area.x1, y: c.y + c.height * area.y1 },
  );
  await until("the prompt appears inside the box", async () =>
    page.evaluate((s) => !!document.querySelector(s), PROMPT_SEL),
  );
  await page.fill(PROMPT_SEL, description);
  await page.getByRole("button", { name: "Generate", exact: true }).last().click();
  await until(
    `an element for "${description.slice(0, 32)}…" lands`,
    async () => (await pieceIds(page)).length > before,
    240_000,
  );
  return (await pieceIds(page)).length - before;
};

export const journeyFlows: Flow[] = [
  {
    name: "JOURNEY B — build a deck from scratch, one drawn box at a time",
    tier: "smoke",
    needsAuth: true,
    mutates: true,
    run: async ({ page, base, note }) => {
      // The wedge. Nobody else can do this: draw a rectangle, say what belongs
      // there, get a real editable element rather than a picture of one.
      const id = await newDocument(page, base);
      note(`blank document ${id}`);
      try {
        await waitForCanvas(page).catch(() => {
          /* a blank canvas legitimately has no pieces yet */
        });

        // Three elements, placed where a person would place them.
        const asks: [string, { x0: number; y0: number; x1: number; y1: number }][] = [
          ["a bold headline reading “Renderball” with a one-line subtitle", { x0: 0.08, y0: 0.12, x1: 0.62, y1: 0.34 }],
          ["a KPI tile reading 10x with the caption “faster than a designer”", { x0: 0.08, y0: 0.46, x1: 0.42, y1: 0.68 }],
          ["a three-item bulleted list of product benefits", { x0: 0.50, y0: 0.46, x1: 0.92, y1: 0.78 }],
        ];
        for (const [ask, area] of asks) {
          const gained = await generateInBox(page, area, ask);
          expect(gained > 0, `"${ask.slice(0, 40)}" produced no element`);
          note(`+${gained} — ${ask.slice(0, 44)}`);
        }

        const ids = await pieceIds(page);
        expect(ids.length >= 3, `expected at least 3 elements, have ${ids.length}`);

        // Now EDIT what was generated — the half that makes this a product
        // rather than a slot machine. All deterministic, all free.
        const target = await pickEditablePiece(page);
        const before = await pieceBox(page, target);
        expect(!!before, "the generated element should be measurable");

        await selectPiece(page, target);
        await page.request.fetch(`${base}/api/preview/edit-layout`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          data: { scriptId: id, sceneIndex: 0, pieceId: target, op: "front" },
          failOnStatusCode: false,
        });
        await page.reload({ waitUntil: "domcontentloaded" });
        await waitForCanvas(page);
        expect(
          (await pieceIds(page)).length === ids.length,
          "reordering a generated element must not lose it",
        );
        note(`edited ${target}`);

        // And it has to leave the building: export, then share.
        const pdf = await page.request.fetch(`${base}/api/preview/${id}/export?format=pdf`, {
          failOnStatusCode: false,
          timeout: 180_000,
        });
        expect(pdf.status() === 200, `the deck should export, got ${pdf.status()}`);
        expect((await pdf.body()).length > 1000, "the PDF looks empty");

        const share = await page.request.fetch(`${base}/api/preview/share`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          data: { scriptId: id },
          failOnStatusCode: false,
        });
        const { url } = (await share.json()) as { url?: string };
        expect(!!url, "the finished deck should be shareable");
        const anon = await page.context().browser()!.newContext();
        try {
          const visitor = await anon.newPage();
          const opened = await visitor.goto(`${base}${url}`, { waitUntil: "domcontentloaded" });
          expect(opened?.status() === 200, `a visitor should open it, got ${opened?.status()}`);
        } finally {
          await anon.close().catch(() => {});
        }
        note(`drew 3 boxes → deck → PDF → public link`);
      } finally {
        await discard(page, base, id);
      }
    },
  },

  {
    name: "JOURNEY A — ask for a whole deck, then fix a few things",
    tier: "full",
    needsAuth: true,
    mutates: true,
    run: async ({ page, base, note }) => {
      // The headline promise: describe what you need, get a deck, change what
      // you do not like. Expensive and slow — one build is ~$1 and up to 37
      // minutes — so this only runs at the "full" tier.
      const id = await newDocument(page, base);
      note(`document ${id}`);
      try {
        // 1. The outline. Deliberately a separate step from the build, so a
        //    user sees the story before anything costs a dollar.
        const outline = await page.request.fetch(`${base}/api/documents/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          data: {
            scriptId: id,
            prompt:
              "A 4-slide investor update for Renderball, an AI design editor: " +
              "the problem with prompt-only tools, what we built, early traction, what's next.",
            pages: 4,
          },
          failOnStatusCode: false,
          timeout: 300_000,
        });
        expect(outline.status() === 200, `the outline should generate, got ${outline.status()} ${(await outline.text()).slice(0, 200)}`);
        note("outline generated");

        // 2. The build. Async by design — the request returns and the client
        //    polls, because a 20-minute request dies behind any proxy.
        const start = await page.request.fetch(`${base}/api/preview/build`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          data: { scriptId: id },
          failOnStatusCode: false,
          timeout: 120_000,
        });
        expect(start.status() < 400, `the build should start, got ${start.status()} ${(await start.text()).slice(0, 200)}`);

        const began = Date.now();
        await until(
          "the deck finishes building",
          async () => {
            const res = await page.request.fetch(
              `${base}/api/preview/build?scriptId=${encodeURIComponent(id)}`,
              { failOnStatusCode: false },
            );
            const job = (await res.json()) as { status?: string; error?: string };
            if (job.status === "failed") throw new Error(`the build failed: ${job.error ?? "no reason given"}`);
            return job.status === "done";
          },
          45 * 60_000,
        );
        note(`built in ${Math.round((Date.now() - began) / 60_000)} min`);

        // 3. Open what was built and check it is a real deck, not an empty one.
        await page.goto(`${base}/preview/${id}`, { waitUntil: "domcontentloaded" });
        await waitForCanvas(page);
        const pieces = await pieceIds(page);
        expect(pieces.length >= 3, `a built slide should have several elements, has ${pieces.length}`);
        note(`${pieces.length} elements on page 1`);

        // 4. Fix a few things — the actual reason to use this over a generator.
        const target = await pickEditablePiece(page);
        const before = await pieceBox(page, target);
        expect(!!before, "the element should be measurable");

        const resize = await page.request.fetch(`${base}/api/preview/edit-layout`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          data: {
            scriptId: id, sceneIndex: 0, pieceId: target, op: "resize",
            x: 100, y: 100, w: Math.round(before!.width * 1.2), h: before!.height,
          },
          failOnStatusCode: false,
        });
        expect(resize.status() === 200, `resizing should work on a built deck, got ${resize.status()}`);

        const brand = await page.request.fetch(`${base}/api/preview/brand`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          data: { scriptId: id, brand: { palette: { accent: "#7c3aed" } } },
          failOnStatusCode: false,
        });
        expect(brand.status() === 200, `re-branding should work, got ${brand.status()}`);
        note("resized an element and re-skinned the deck");

        // 5. Out the door.
        const pdf = await page.request.fetch(`${base}/api/preview/${id}/export?format=pdf`, {
          failOnStatusCode: false,
          timeout: 180_000,
        });
        expect(pdf.status() === 200, `the deck should export, got ${pdf.status()}`);
        note(`PDF ${Math.round((await pdf.body()).length / 1024)}KB`);
      } finally {
        await discard(page, base, id);
      }
    },
  },

  {
    name: "no journey document is left behind",
    tier: "smoke",
    needsAuth: true,
    mutates: true,
    run: async ({ page, base, note }) => {
      const leftovers = [...created];
      for (const id of leftovers) await discard(page, base, id);
      note(leftovers.length ? `cleaned up ${leftovers.length}` : "nothing left behind");
      expect(created.size === 0, `could not clean up: ${[...created].join(", ")}`);
    },
  },
];
