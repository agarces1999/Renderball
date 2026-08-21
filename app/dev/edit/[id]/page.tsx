import { promises as fs } from "fs";
import path from "path";
import { notFound } from "next/navigation";
import { DEV_OWNER_ID } from "../../../../lib/auth";
import { loadScript } from "../../../../lib/store";
import { dimensionsForScript } from "../../../../lib/render/build-wrapper";
import { DevEditClient } from "./DevEditClient";

/**
 * Dev-only element-editor harness (NODE_ENV-gated). Loads a script built under
 * DEV_OWNER_ID and renders the M4 editor with no Clerk session, so the editor loop
 * (click → regenerate/move/delete) can be exercised + verified in a browser.
 * GET /dev/edit/<scriptId>
 */
export default async function DevEditPage({ params }: { params: { id: string } }) {
  if (process.env.NODE_ENV === "production") notFound();

  const script = await loadScript(params.id, DEV_OWNER_ID);
  if (!script) notFound();

  const dims = dimensionsForScript(script);

  // The same three keys the production surface reads. Best-effort: a document
  // with no warnings.json simply has nothing to report.
  const warnings = await fs
    .readFile(path.join(process.cwd(), "src", "generated", params.id, "warnings.json"), "utf8")
    .then((raw) => JSON.parse(raw) as Record<string, unknown>)
    .catch(() => ({}) as Record<string, unknown>);
  const structural = ["structural_unresolved", "render_truth_unresolved", "render_truth_advisory"]
    .flatMap((k) => (Array.isArray(warnings[k]) ? (warnings[k] as string[]) : []));

  return (
    <DevEditClient
      scriptId={params.id}
      scenes={script.scenes.map((s) => ({
        label: s.label,
        description: s.description ?? null,
        seconds: Math.max(0, (s.end_seconds ?? 0) - (s.start_seconds ?? 0)),
      }))}
      logline={script.narrative?.logline ?? null}
      structural={structural}
      width={dims.width}
      height={dims.height}
    />
  );
}
