/**
 * The write barrier must refuse an edit that breaks a slide.
 *
 * Builds have always been render-gated; edits were only compile-gated — and an
 * edit rewrites exactly the same Composition.tsx a build does. So code that
 * PARSED and rendered `undefined` went straight into the user's live document.
 * Measured before the fix: 14 of 106 built decks on this machine carried a
 * scene that will not render, each one a deck that opens as an error message,
 * exports as an error message, and shows one to whoever the link was sent to.
 *
 * The two cases that matter are both here. An ordinary edit must still be
 * allowed — a gate that blocks real work is worse than the bug it prevents —
 * and an edit that stops a page rendering must be refused AND rolled back.
 */
import { promises as fs } from "fs";
import path from "path";
import { commitGenDir } from "./commit";
import { readManifest, writePieceBody, readDecomposed } from "../agents/lego-store";

const ID = process.env.QA_DEV_SCRIPT_ID ?? "01KY7ZGC4MVDD5J1DSB35GAW5T";
const src = path.join(process.cwd(), "src", "generated", ID);
const work = path.join(process.cwd(), ".data", "commit-barrier-scratch");

const exists = await fs.stat(path.join(src, "lego", "manifest.json")).then(() => true).catch(() => false);
if (!exists) {
  console.log(`  – skipped: no built document at ${ID} to edit`);
} else {
  await fs.rm(work, { recursive: true, force: true });
  await fs.cp(src, work, { recursive: true });
  try {
    const m = await readManifest(work);
    const pieceId = m.scenes[0].pieces.find((p) => /add/.test(p.id))?.id ?? m.scenes[0].pieces[1].id;
    const d = await readDecomposed(work);
    const original = d.scenes[0].pieces.find((p) => p.id === pieceId)!.body;

    // 1. An ordinary edit still lands.
    await writePieceBody(work, pieceId, original.replace(/>/, ' data-probe="1">'));
    const good = await commitGenDir(work, "harmless edit", { checkRender: true });
    console.log(
      `  ${good.ok ? "✓" : "✗"} an ordinary edit is still allowed${good.ok ? "" : ` — ${good.error}`}`,
    );
    if (!good.ok) process.exitCode = 1;

    // 2. One that throws at RENDER is refused. Not an unknown component —
    //    finalizeUndefinedRefs stubs those, and correctly so. This is the shape
    //    the real broken decks show: a property read off undefined.
    const before = await fs.readFile(path.join(work, "Composition.tsx"), "utf8");
    await writePieceBody(work, pieceId, `<div>{(undefined as unknown as { hex: string }).hex}</div>`);
    const bad = await commitGenDir(work, "breaking edit", { checkRender: true });
    const after = await fs.readFile(path.join(work, "Composition.tsx"), "utf8");

    const refused = !bad.ok && /page 1/.test(bad.error ?? "");
    const rolledBack = before === after;
    console.log(
      `  ${refused ? "✓" : "✗"} an edit that breaks a page is refused, and says which page` +
        (refused ? "" : ` — got ok=${bad.ok} "${bad.error ?? ""}"`),
    );
    console.log(`  ${rolledBack ? "✓" : "✗"} the previous render is put back`);
    if (!refused || !rolledBack) process.exitCode = 1;

    // 3. The refusal carries EVIDENCE (founder, 2026-08-29): the gate must
    //    hand back which stage refused and the actual per-page error — this
    //    is what the error-fed retry feeds the model and the forensic log
    //    records. Discarding it made "why did my chart fail?" unanswerable.
    const hasStage = bad.stage === "render";
    const detail = bad.refusal?.[0];
    const hasDetail = detail?.scene === 0 && typeof detail?.error === "string" && detail.error.length > 0;
    console.log(
      `  ${hasStage ? "✓" : "✗"} the refusal names its stage (render)` +
        (hasStage ? "" : ` — got ${bad.stage}`),
    );
    console.log(
      `  ${hasDetail ? "✓" : "✗"} the refusal carries the page's actual error` +
        (hasDetail ? "" : ` — got ${JSON.stringify(bad.refusal)}`),
    );
    if (!hasStage || !hasDetail) process.exitCode = 1;
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}
