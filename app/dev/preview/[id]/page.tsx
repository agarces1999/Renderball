import { notFound } from "next/navigation";
import { DEV_OWNER_ID } from "../../../../lib/auth";
import { loadScript } from "../../../../lib/store";
import { PreviewClient } from "../../../preview/[id]/PreviewClient";

/**
 * Dev-only harness that renders the REAL production PreviewClient (NODE_ENV
 * gated), so the shell chrome for decks can be eyeballed without a Clerk
 * session. Note: the canvas iframe + edit/export APIs it calls are
 * Clerk-protected (/api/preview/*), so the slide itself renders blank here —
 * this harness verifies the SHELL (rail, toolbar, page panel, actions, banner),
 * not the canvas. The canvas loop is verified on /dev/edit, which uses the
 * unauthenticated /api/dev endpoints.
 *
 * GET /dev/preview/<scriptId>
 */
export default async function DevPreviewPage({
  params,
}: {
  params: { id: string };
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const script = await loadScript(params.id, DEV_OWNER_ID);
  if (!script) notFound();
  return (
    <PreviewClient scriptId={params.id} script={script} initialWarnings={null} />
  );
}
