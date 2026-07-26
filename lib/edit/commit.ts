//
// The shared write barrier for every editor mutation.
//
// Reassemble the CURRENT on-disk manifest → finalize undefined refs (imports/stubs
// a regen may have reached for) → compile-check the whole file → write
// Composition.tsx ONLY if it compiles. Callers mutate the store first, then call
// this; on a non-ok result they roll their mutation back, so the manifest and the
// render source can never desync (Composition.tsx is written last, only on success).
//
// Extracted so insert / layout / text-format / undo all share one definition —
// previously each op carried its own copy of this sequence.
//
import { promises as fs } from "fs";
import { persistGenDir } from "../render/gen-store";
import path from "path";
import { reassembleFromDisk } from "../agents/lego-store";
import { finalizeUndefinedRefs } from "../agents/finalize-refs";
import { verifyCompilable } from "../agents/code-extraction";

export interface CommitResult {
  ok: boolean;
  code?: string;
  error?: string;
}

/** @param what - noun used in the failure message ("layout edit", "inserted element", …) */
export const commitGenDir = async (genDir: string, what = "edit"): Promise<CommitResult> => {
  const reassembled = await reassembleFromDisk(genDir);
  const { code } = await finalizeUndefinedRefs(reassembled);
  const compileError = await verifyCompilable(code);
  if (compileError) return { ok: false, error: `${what} does not compile: ${compileError}` };
  await fs.writeFile(path.join(genDir, "Composition.tsx"), code, "utf8");
  // Republish so the edit survives the next deploy too — otherwise a restored
  // document would silently roll back to its as-built state.
  await persistGenDir(path.basename(genDir));
  return { ok: true, code };
};
