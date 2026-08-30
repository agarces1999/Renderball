//
// The shared write barrier for every editor mutation.
//
// Reassemble the CURRENT on-disk manifest → finalize undefined refs (imports/stubs
// a regen may have reached for) → compile-check → RENDER-check → write
// Composition.tsx ONLY if both pass. Callers mutate the store first, then call
// this; on a non-ok result they roll their mutation back, so the manifest and the
// render source can never desync (Composition.tsx is written last, only on success).
//
// Extracted so insert / layout / text-format / undo all share one definition —
// previously each op carried its own copy of this sequence.
//
// WHY THE RENDER CHECK EXISTS. This barrier used to check only that the code
// PARSED. Builds have always been render-gated — run-preview-build.ts SSRs every
// Section and refuses to finish if one throws — but edits were not, and an edit
// rewrites exactly the same file. So any edit that produced code which parses
// and renders `undefined` was written straight into the live document, and the
// user's slide became React's "Element type is invalid" instead of their work.
//
// Measured before the fix: SSR-checking all 106 built decks on the author's
// machine found 14 with a scene that will not render — a deck that opens as an
// error message, that exports as an error message, and that a share link shows
// to whoever it was sent to.
//
import { promises as fs } from "fs";
import { persistGenDir } from "../render/gen-store";
import path from "path";
import { reassembleFromDisk } from "../agents/lego-store";
import { finalizeUndefinedRefs } from "../agents/finalize-refs";
import { verifyCompilable } from "../agents/code-extraction";
import { verifyScenesRender } from "../render/ssr-render";

export interface CommitResult {
  ok: boolean;
  code?: string;
  error?: string;
  /** Which gate refused — lets callers decide if a model-repair retry makes sense. */
  stage?: "compile" | "render";
  /** The render check's ACTUAL per-page errors. Discarding these is why a
   *  refused insert used to leave zero evidence (founder, 2026-08-29). */
  refusal?: { scene: number; error: string }[];
}

/**
 * Which scenes fail to render right now, as a set of indices.
 *
 * Returns null when the question cannot be asked — no script on disk, a
 * document that has never been built. A missing answer must not block an edit;
 * this gate exists to stop an edit making things WORSE, and it cannot judge
 * that without a baseline.
 */
const failingScenes = async (genDir: string): Promise<Map<number, string> | null> => {
  try {
    const raw = await fs.readFile(path.join(genDir, "script.json"), "utf8");
    const script = JSON.parse(raw) as { scenes?: unknown[] };
    const count = script.scenes?.length ?? 0;
    if (!count) return null;
    const check = await verifyScenesRender(genDir, count, script);
    return new Map(check.errors.map((e) => [e.scene, e.error]));
  } catch {
    return null;
  }
};

/**
 * @param what - noun used in the failure message ("layout edit", "inserted element", …)
 * @param opts.checkRender - SSR every scene before accepting the write.
 *
 * OPT-IN, because it is not free. Bundling and SSR-ing the whole composition
 * takes about a second, and an edit is a ~126ms interaction; running it on
 * every commit added forty-odd seconds to the page-op flows alone.
 *
 * It is on for the ops that write NEW COMPONENT CODE — a model wrote it, so it
 * can reference something that does not exist. It is off for the ops that only
 * move, resize, reorder or duplicate what is already there: those rewrite style
 * strings and shuffle slots, and cannot introduce a component reference that
 * was not already rendering a moment ago.
 */
export const commitGenDir = async (
  genDir: string,
  what = "edit",
  opts: { checkRender?: boolean } = {},
): Promise<CommitResult> => {
  const reassembled = await reassembleFromDisk(genDir);
  const { code } = await finalizeUndefinedRefs(reassembled);
  const compileError = await verifyCompilable(code);
  if (compileError) return { ok: false, stage: "compile", error: `${what} does not compile: ${compileError}` };

  const compPath = path.join(genDir, "Composition.tsx");
  const previous = await fs.readFile(compPath, "utf8").catch(() => null);
  await fs.writeFile(compPath, code, "utf8");

  // ONE check on the happy path. Bundling and SSR-ing the composition is real
  // work, and an edit is a ~126ms interaction — doing it twice to establish a
  // baseline first put a second of latency on every drag and resize, and blew
  // the page-op flows past their timeouts. So: check the NEW code, and only if
  // something is broken pay to find out whether it was already broken.
  const after = opts.checkRender ? await failingScenes(genDir) : null;
  if (after && after.size > 0 && previous !== null) {
    await fs.writeFile(compPath, previous, "utf8");
    const before = (await failingScenes(genDir)) ?? new Set<number>();
    // A deck that already has a broken scene must stay editable — otherwise one
    // bad slide would freeze the document and the user could not even delete
    // the thing that broke it. Only a NEW failure is refused.
    const introduced = [...after.keys()].filter((s) => !before.has(s));
    if (introduced.length === 0) {
      await fs.writeFile(compPath, code, "utf8"); // no worse than it was — let it through
    } else {
      // The old render stays on disk. The caller rolls its own store mutation
      // back on !ok, so the manifest and Composition.tsx stay in agreement.
      const refusal = introduced.map((s) => ({ scene: s, error: after.get(s) ?? "render failed" }));
      console.error(
        `[commit] ${what} refused for ${path.basename(genDir)}: ` +
          refusal.map((r) => `page ${r.scene + 1}: ${r.error}`).join(" | "),
      );
      const scenes = introduced.map((s) => `page ${s + 1}`).join(", ");
      return {
        ok: false,
        stage: "render",
        refusal,
        error:
          `${what} would stop ${scenes} rendering, so it was not applied. ` +
          `Nothing changed — try again, or regenerate that element.`,
      };
    }
  }

  // Republish so the edit survives the next deploy — otherwise a restored
  // document would silently roll back to its as-built state.
  //
  // NOT awaited: this is a readdir + gzip + network PUT, and editor ops are a
  // ~126ms interaction. Awaiting it put a round-trip in the critical path of
  // every drag, resize and retype. The local write above has already
  // succeeded, so the edit is real either way; a failed publish logs loudly
  // and the next edit republishes the same directory.
  void persistGenDir(path.basename(genDir)).catch(() => {});
  return { ok: true, code };
};
