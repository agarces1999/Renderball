//
// SEAMS — the boundaries between subsystems, which is where this product
// actually breaks.
//
// On 2026-08-21 the founder found seven bugs by hand in about half an hour,
// against a suite of 1904 unit tests and 123 QA flows that were all green.
// Six of the seven lived in a seam:
//
//   the build → R2 snapshot boundary   the store was written AFTER the snapshot,
//                                      so a deploy restored the store from
//                                      before the build and move, delete,
//                                      upload, add-page, apply-brand and
//                                      change-logo ALL failed at once
//   the detect → report boundary       a real page-2 collision was seen by the
//                                      gate, demoted for untrusted text metrics,
//                                      and then reached no human at all
//   the dev → production lane boundary four route pairs had drifted, so the
//                                      harness was exercising a program
//                                      production does not run
//   the test → production environment  brand webfonts load from disk here and
//                                      over a CDN there; when they fail, an
//                                      entire family of gates goes advisory
//   the PNG → WebP branch boundary     the 304 path compared one format's ETag
//                                      and returned the other's
//   the shared-barrier boundary        regeneration wrote Composition.tsx
//                                      directly instead of through the write
//                                      barrier every other edit op uses
//
// Every existing flow in this suite drives a JOURNEY: a person goes somewhere
// and does something. That is the right shape for finding what a person hits,
// and it found none of the above, because each of those bugs needs two
// subsystems put side by side before it is visible at all.
//
// THE INVARIANT THIS FILE EXISTS FOR:
//
//     What one subsystem produces, the next must be able to consume — across
//     a deploy, across the two route lanes, across a degraded network, and
//     from a detector to a human's eyes.
//
// FREE TIER. Every flow here is deterministic filesystem, HTTP and browser work
// against the already-built fixture deck: zero model calls, zero spend. They run
// on every QA run, because a seam that is only checked before a release is a
// seam that breaks after one.
//
import type { Flow } from "../harness";
import { expect, until } from "../harness";
import { pieceIds, pieceBox, pickEditablePiece, selectPiece, waitForCanvas } from "../editor";
import { promises as fs } from "fs";
import path from "path";

const fixtureId = (): string => process.env.QA_DEV_SCRIPT_ID ?? "";
const genDirOf = (id: string): string => path.join(process.cwd(), "src", "generated", id);

// ── seam 1: the deploy boundary ──────────────────────────────────────────────

/**
 * What the R2 snapshot actually restored: the one-scene `s0.hint` scaffold a
 * blank document is created with, sitting on top of a fully built deck.
 *
 * Written as a FIXTURE rather than by mutating whatever is on disk, so the flow
 * reproduces the exact shape that shipped rather than an approximation of it.
 */
const STALE_MANIFEST = {
  preamble: 'import React from "react";\nimport { Piece } from "./Piece";\n',
  tail: "",
  scenes: [
    {
      sceneIndex: 0,
      template:
        'export const Section0: React.FC<{ script: any }> = () => (\n  <div>\n    {/*RB:s0.hint*/}\n  </div>\n);\n',
      pieces: [
        {
          id: "s0.hint",
          kind: "text",
          openTag: '<Piece id="s0.hint" kind="text">',
          file: "pieces/s0.hint.tsx",
        },
      ],
    },
  ],
};

/** Snapshot the lego store so the flow can put the document back exactly. */
const readStore = async (dir: string): Promise<Map<string, string>> => {
  const out = new Map<string, string>();
  const legoDir = path.join(dir, "lego");
  const walk = async (rel: string): Promise<void> => {
    for (const e of await fs.readdir(path.join(legoDir, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) await walk(r);
      else out.set(r, await fs.readFile(path.join(legoDir, r), "utf8"));
    }
  };
  await walk(".");
  return out;
};

const writeStore = async (dir: string, files: Map<string, string>): Promise<void> => {
  const legoDir = path.join(dir, "lego");
  await fs.rm(legoDir, { recursive: true, force: true });
  for (const [rel, body] of files) {
    const p = path.join(legoDir, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, body, "utf8");
  }
};

const seamDeploy: Flow = {
  name: "seam: a document rehydrated from storage is still editable",
  tier: "free",
  mutates: true,
  run: async (c) => {
    const id = fixtureId();
    expect(!!id, "the suite needs a fixture document");
    const dir = genDirOf(id);

    const original = await readStore(dir);
    expect(original.size > 0, "the fixture must have a lego store to begin with");

    try {
      // Put the document into the exact state a deploy left it in: the built
      // Composition.tsx untouched, the store from BEFORE the build.
      await writeStore(
        dir,
        new Map([
          ["manifest.json", JSON.stringify(STALE_MANIFEST, null, 2)],
          [path.join("pieces", "s0.hint.tsx"), "<p>Describe this page</p>"],
        ]),
      );
      c.note("store replaced with the pre-build scaffold (1 scene, s0.hint)");

      // Now do the first thing the founder did. Nothing here knows the store is
      // stale; the product has to notice and repair it on its own.
      await c.page.goto(`${c.base}/dev/edit/${id}`, { waitUntil: "domcontentloaded" });
      await waitForCanvas(c.page);

      const ids = await pieceIds(c.page);
      expect(
        ids.length > 1,
        `a rehydrated deck must still offer its elements — the editor saw ${ids.length} piece(s) (${ids.slice(0, 4).join(", ")})`,
      );

      // The repair runs on a MUTATION, not on a page load — so the order here
      // matters and an earlier version of this flow got it backwards, asserting
      // the store was repaired before doing the thing that repairs it.
      //
      // The element to move is named from the store as it was BEFORE corruption,
      // which is exactly what a person's editor session would still be holding:
      // they had the deck open, the container restarted underneath them, and the
      // id in their hand is one the document legitimately has.
      const known = JSON.parse(original.get("manifest.json") ?? "{}") as {
        scenes?: { sceneIndex: number; pieces: { id: string; kind: string }[] }[];
      };
      const spot = (known.scenes ?? [])
        .flatMap((sc) => sc.pieces.map((pc) => ({ scene: sc.sceneIndex, id: pc.id, kind: pc.kind })))
        .find((pc) => pc.kind !== "chrome" && pc.kind !== "atmosphere");
      expect(!!spot, "the fixture must contain a movable element to aim at");

      const res = await c.page.request.post(`${c.base}/api/dev/edit-layout`, {
        data: { scriptId: id, sceneIndex: spot!.scene, pieceId: spot!.id, op: "move", dx: 24, dy: 12 },
        failOnStatusCode: false,
      });
      expect(
        res.ok(),
        `moving an element on a rehydrated deck must work — got ${res.status()} ${(await res.text()).slice(0, 160)}`,
      );

      // And the repair must be real, not a one-off dodge inside that request.
      const healed = JSON.parse(
        await fs.readFile(path.join(dir, "lego", "manifest.json"), "utf8"),
      ) as { scenes: { sceneIndex: number }[] };
      expect(
        healed.scenes.length > 1,
        `the edit must leave the store repaired on disk — it still describes ${healed.scenes.length} scene(s)`,
      );
      c.note(
        `moved ${spot!.id} on page ${spot!.scene + 1}; the store went 1 → ${healed.scenes.length} scenes`,
      );
    } finally {
      // The fixture is shared; leave it exactly as found even if an assert threw.
      await writeStore(dir, original);
    }
  },
};

// ── seam 2: the two route lanes ──────────────────────────────────────────────

/**
 * The dev harness exists so this suite can drive the product without signing
 * in. That only works while the two lanes are the SAME PROGRAM.
 *
 * They drifted. On 2026-08-21 an audit found four pairs where a guard existed
 * on one side only: dev/edit-layout took a move with no deltas and sent NaN
 * into the mover, dev/regenerate-element allowed the blind reroll production
 * refuses, dev/suggest-layout billed a model call for a page that does not
 * exist, and dev/render skipped disallowRebuild — an unmetered rebuild path.
 * Each one means a green QA run was evidence about a program no user can reach.
 *
 * So: fire the SAME malformed request at both lanes and require them to agree
 * about refusing it. Every payload below is invalid, so nothing is mutated and
 * this flow stays safe to run concurrently.
 */
interface LanePair {
  what: string;
  route: string;
  body: Record<string, unknown>;
}

const LANE_PAIRS: LanePair[] = [
  {
    what: "a move with no deltas",
    route: "edit-layout",
    body: { sceneIndex: 0, pieceId: "s0.copy", op: "move" },
  },
  {
    what: "a resize with non-numeric bounds",
    route: "edit-layout",
    body: { sceneIndex: 0, pieceId: "s0.copy", op: "resize", x: "wide", y: 0, w: 10, h: 10 },
  },
  {
    what: "an unknown op",
    route: "edit-layout",
    body: { sceneIndex: 0, pieceId: "s0.copy", op: "explode" },
  },
  {
    what: "a regenerate with no instruction",
    route: "regenerate-element",
    body: { sceneIndex: 0, pieceId: "s0.copy" },
  },
  {
    what: "a page index past the end of the deck",
    route: "suggest-layout",
    body: { sceneIndex: 9999, prompt: "a chart" },
  },
];

const seamLanes: Flow = {
  name: "seam: the dev and production lanes refuse the same malformed request",
  tier: "free",
  run: async (c) => {
    const id = fixtureId();
    expect(!!id, "the suite needs a fixture document");
    const disagreements: string[] = [];

    for (const p of LANE_PAIRS) {
      const data = { ...p.body, scriptId: id };
      const [dev, prod] = await Promise.all([
        c.page.request.post(`${c.base}/api/dev/${p.route}`, { data, failOnStatusCode: false }),
        c.page.request.post(`${c.base}/api/preview/${p.route}`, { data, failOnStatusCode: false }),
      ]);

      // Production answers 401 when this run has no session. That is not drift:
      // it means the request never reached the handler, so the pair is simply
      // not comparable here and the dev side is judged on its own.
      const prodGated = prod.status() === 401 || prod.status() === 403;
      const devRefused = !dev.ok();
      const prodRefused = !prod.ok();

      if (!devRefused) {
        disagreements.push(
          `dev/${p.route} ACCEPTED ${p.what} (${dev.status()}) — production ${prodGated ? "requires auth here, but this input is invalid on any lane" : `refused it (${prod.status()})`}`,
        );
        continue;
      }
      if (!prodGated && !prodRefused) {
        disagreements.push(
          `preview/${p.route} ACCEPTED ${p.what} (${prod.status()}) while dev refused it (${dev.status()})`,
        );
      }
    }

    c.note(`compared ${LANE_PAIRS.length} malformed requests across both lanes`);
    expect(
      disagreements.length === 0,
      `the lanes disagree, so a green QA run is evidence about the wrong program:\n      ${disagreements.join("\n      ")}`,
    );
  },
};

// ── seam 3: detection → a human ──────────────────────────────────────────────

/**
 * A defect the build FOUND has to reach the person holding the deck.
 *
 * Page 2 of the Anthropic deck collided visibly. The gate caught it — replaying
 * the shipped composition reproduces the finding exactly — but the scene's brand
 * fonts had not loaded, the measurement-trust rule demoted the finding from
 * blocking to advisory, and `render_truth_unresolved` is only written when the
 * repair ladder fails. So the deck shipped reporting "checks passed" over a
 * collision the system had already seen.
 *
 * This asserts the CHANNEL, not the detector: whatever a build recorded as a
 * quality note must be visible in the editor. A finding that exists only in a
 * JSON file nobody opens is the same as no finding at all.
 */
const REPORTED_KEYS = [
  "structural_unresolved",
  "render_truth_unresolved",
  "render_truth_advisory",
] as const;

const seamReporting: Flow = {
  name: "seam: a defect the build recorded is visible to the person holding the deck",
  tier: "free",
  // WRITES warnings.json in the shared document (see the injection below), so
  // it must be serialized. Marked read-only at first, it recompiled the page
  // out from under a flow running beside it and both timed out — the harness
  // header warns about exactly this, and I earned the warning.
  mutates: true,
  run: async (c) => {
    const id = fixtureId();
    expect(!!id, "the suite needs a fixture document");

    const warnPath = path.join(genDirOf(id), "warnings.json");
    const raw = await fs.readFile(warnPath, "utf8").catch(() => "");
    const warnings = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    let recorded = REPORTED_KEYS.flatMap((k) => {
      const v = warnings[k];
      return Array.isArray(v) ? (v as string[]) : [];
    });

    // A clean fixture would make this flow pass by testing nothing — which is
    // the failure mode that let a real collision ship as "checks passed". So
    // when there is nothing recorded, RECORD something and require the editor
    // to show it. Restored in the finally below.
    const injected = recorded.length === 0;
    const PROBE = "Page 2: seam probe — a finding the build recorded";
    try {
      if (injected) {
        await fs.writeFile(
          warnPath,
          JSON.stringify({ ...warnings, render_truth_advisory: [PROBE] }, null, 2),
          "utf8",
        );
        recorded = [PROBE];
        c.note("fixture had no findings — injected one to exercise the channel");
      }

      // FETCH the markup rather than navigating. This panel is server-rendered,
      // so the served HTML is the whole answer — while a browser navigation to
      // the same URL can be satisfied from the router cache with a payload from
      // BEFORE the finding was written, which reported a missing panel against
      // a product that was in fact rendering it correctly.
      const html = await (
        await c.page.request.get(`${c.base}/dev/edit/${id}?qa=${Date.now()}`)
      ).text();
      const shown = html.replace(/\\n/g, " ").replace(/\s+/g, " ");

    // Match on the page NUMBER and the defect wording the build wrote, not on
    // the whole sentence — the panel is free to shorten, never to omit.
    const missing = recorded.filter((issue) => {
      const head = issue.split("—")[0].trim().replace(/\s+/g, " ");
      return head.length > 0 && !shown.includes(head);
    });

      c.note(`${recorded.length} recorded finding(s); ${recorded.length - missing.length} visible in the editor`);
      expect(
        missing.length === 0,
        `the build recorded findings the editor never shows — this is exactly how a real collision shipped as "checks passed":\n      ${missing.join("\n      ")}`,
      );
    } finally {
      if (injected) {
        if (raw) await fs.writeFile(warnPath, raw, "utf8");
        else await fs.rm(warnPath, { force: true });
      }
    }
  },
};

// ── seam 4: the environment boundary ─────────────────────────────────────────

/**
 * Here, brand fonts come off local disk and always load. In production they come
 * from whatever CDN the crawled brand uses, and when one of those does not
 * answer, an entire family of gates stops being able to block — because a
 * measurement that cannot trust its own glyph widths must not refuse a deck.
 *
 * That rule is correct. What is not acceptable is the deck falling apart, or the
 * page failing to render at all, when the network is slightly worse than ours.
 * So: block every third-party font request and require the document to still
 * render its pages.
 */
const seamDegradedFonts: Flow = {
  name: "seam: the deck still renders when brand webfonts fail to load",
  tier: "free",
  run: async (c) => {
    const id = fixtureId();
    expect(!!id, "the suite needs a fixture document");

    // Off-origin only: same-origin assets are ours and are not the risk.
    const FONT_URL = /^https?:\/\/(?!localhost|127\.0\.0\.1)[^/]+\/.*\.(woff2?|ttf|otf)(\?.*)?$/i;
    let blocked = 0;
    const blockFonts = async (route: import("playwright").Route) => {
      blocked++;
      await route.abort();
    };
    await c.page.route(FONT_URL, blockFonts);

    try {
      await c.page.goto(`${c.base}/dev/edit/${id}`, { waitUntil: "domcontentloaded" });
      await waitForCanvas(c.page);
      const ids = await pieceIds(c.page);
      expect(
        ids.length > 0,
        "with brand fonts blocked the deck rendered no elements at all — a font failure must degrade type, never the document",
      );
      // And the text has to still occupy the page, not collapse to nothing.
      const box = await pieceBox(c.page, ids.find((p) => !p.endsWith(".chrome")) ?? ids[0]);
      expect(!!box && box.width > 1 && box.height > 1, "an element measured as empty with fallback fonts");
      c.note(`${blocked} off-origin font request(s) blocked; ${ids.length} element(s) still rendered`);
    } finally {
      await c.page.unroute(FONT_URL, blockFonts);
    }
  },
};

// ── seam 5: the store is a decomposition of what renders ─────────────────────

/**
 * The cheap invariant that would have caught the deploy bug a week early, run
 * here against the document this suite is about to drive.
 *
 * `npm run invariants` sweeps every stored deck for the same thing; this is the
 * one-document version, so a QA run fails on a broken fixture instead of
 * reporting six confusing flow failures downstream of it. That failure mode is
 * not hypothetical — it is written at the top of scripts/run-qa.mjs.
 */
const seamStoreParity: Flow = {
  name: "seam: the fixture's store describes the document that actually renders",
  tier: "free",
  run: async (c) => {
    const id = fixtureId();
    expect(!!id, "the suite needs a fixture document");
    const dir = genDirOf(id);

    const script = JSON.parse(await fs.readFile(path.join(dir, "script.json"), "utf8")) as {
      scenes?: unknown[];
    };
    const manifest = JSON.parse(
      await fs.readFile(path.join(dir, "lego", "manifest.json"), "utf8"),
    ) as { scenes?: { pieces: { id: string }[] }[] };

    const scriptScenes = script.scenes?.length ?? 0;
    const storeScenes = manifest.scenes?.length ?? 0;
    expect(
      storeScenes === scriptScenes,
      `store/script scene mismatch (${storeScenes} vs ${scriptScenes}) — every edit op reads this store, so it fails them all at once`,
    );

    const code = await fs.readFile(path.join(dir, "Composition.tsx"), "utf8");
    const orphans = (manifest.scenes ?? [])
      .flatMap((s) => s.pieces.map((p) => p.id))
      .filter((pid) => !code.includes(`id="${pid}"`));
    expect(
      orphans.length === 0,
      `the store offers the editor ${orphans.length} element(s) the render source does not have: ${orphans.slice(0, 5).join(", ")}`,
    );
    c.note(`${storeScenes} scenes, ${(manifest.scenes ?? []).flatMap((s) => s.pieces).length} pieces, all present in the composition`);
  },
};

export const seamFlows: Flow[] = [
  seamStoreParity,
  seamLanes,
  seamReporting,
  seamDegradedFonts,
  seamDeploy,
];

void until;
