import { NextResponse } from "next/server";
import { compositionDocHeaders } from "../../../../../lib/render/iframe-csp";
import { loadSharedDocument } from "../../../../../lib/share";
import { renderSceneDoc } from "../../../../../lib/render/scene-iframe";

/**
 * One page of a SHARED deck, rendered for a visitor with no account.
 *
 * The public twin of /api/preview/[id]/iframe. Deliberately a separate route
 * rather than a "public" flag on that one, for two reasons:
 *
 *   1. /api/preview/* is inside the Clerk middleware matcher. A public path had
 *      to live outside it, and making an exception inside a protected prefix is
 *      exactly the kind of thing that gets accidentally widened later.
 *   2. This route takes a TOKEN, never a scriptId. There is no argument a
 *      visitor can supply that names a document directly, so the id space is
 *      not walkable — the only way in is a link the owner issued.
 *
 * Read-only by construction: it renders and returns HTML. Nothing here writes,
 * and the editor overlay is not part of the composition — the interactive chrome
 * lives in the parent page, which the public viewer simply does not include.
 *
 * GET /api/share/<token>/iframe?scene=<index>
 */

/**
 * The one answer for every failed lookup. Unknown, revoked, out-of-range, and
 * unrenderable are identical on purpose, so the response cannot be used to
 * learn which documents exist — and it is a full HTML document because this
 * lands inside the share viewer's frame, where a bare-text body reads as a
 * broken deck. Colors are the light-theme tokens from globals.css, inlined
 * because the framed document does not load the app stylesheet. The
 * data-share-gone attribute lets the same-origin parent detect this state.
 */
const goneDoc = () =>
  new NextResponse(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>This link is no longer active</title>
<style>
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; align-items: center; justify-content: center;
    background: #ffffff; color: #69707e; text-align: center;
    font: 400 14px/1.6 "Geist", system-ui, sans-serif;
  }
  main { padding: 24px; }
  h1 { margin: 0 0 6px; font-size: 15px; font-weight: 600; color: #10141c; }
  a { color: #047857; text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body data-share-gone>
<main>
  <h1>This link is no longer active</h1>
  <p>Ask whoever sent it for a fresh one, or <a href="/" target="_top">make your own deck with Renderball</a>.</p>
</main>
</body>
</html>`,
    { status: 404, headers: compositionDocHeaders() },
  );

export async function GET(request: Request, { params }: { params: { token: string } }) {
  const shared = await loadSharedDocument(params.token);
  if (!shared) return goneDoc();

  const url = new URL(request.url);
  const requested = parseInt(url.searchParams.get("scene") ?? "0", 10);
  const sceneIndex = Number.isFinite(requested) ? requested : 0;
  if (sceneIndex < 0 || sceneIndex >= shared.script.scenes.length) {
    return goneDoc();
  }

  // Always settled: a viewer is reading a document, not watching it assemble.
  const result = await renderSceneDoc(shared.scriptId, sceneIndex, shared.script, { settle: true });
  if (!result.ok) return goneDoc();

  return new NextResponse(result.html, { headers: compositionDocHeaders() });
}
