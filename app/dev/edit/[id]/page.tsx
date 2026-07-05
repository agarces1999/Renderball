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
  return (
    <DevEditClient
      scriptId={params.id}
      scenes={script.scenes.map((s) => ({
        label: s.label,
        description: s.description ?? null,
        seconds: Math.max(0, (s.end_seconds ?? 0) - (s.start_seconds ?? 0)),
      }))}
      logline={script.narrative?.logline ?? null}
      width={dims.width}
      height={dims.height}
    />
  );
}
