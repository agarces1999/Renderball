import Link from "next/link";
import { notFound } from "next/navigation";
import { promises as fs } from "fs";
import path from "path";
import { loadScript } from "../../../lib/store";
import { PreviewClient } from "./PreviewClient";
import { BuildPreviewClient } from "./BuildPreviewClient";

/**
 * /preview/[id] — browser preview of the agent-emitted Composition.tsx.
 *
 * Per the V0.4 preview-before-MP4 flow, this page mounts the static
 * React composition the Design+Choreography agents produced and plays
 * each scene back-to-back. CSS animations run natively in the browser
 * — no Remotion runtime needed. Users iterate here BEFORE paying for
 * an MP4 render.
 *
 * The [id] param is the scriptId (matches the directory under
 * src/generated/<scriptId>/Composition.tsx).
 */
export default async function PreviewPage({
  params,
}: {
  params: { id: string };
}) {
  const script = await loadScript(params.id);
  if (!script) notFound();

  // Verify the composition file exists — if Pass 1+2 hasn't run yet,
  // there's nothing to preview.
  const compPath = path.join(
    process.cwd(),
    "src",
    "generated",
    params.id,
    "Composition.tsx",
  );
  let compositionExists = false;
  try {
    await fs.access(compPath);
    compositionExists = true;
  } catch {
    compositionExists = false;
  }

  return (
    <main className="container-narrow py-12">
      <Link
        href={`/review/${params.id}`}
        className="text-xs uppercase tracking-widest text-gray-500 hover:text-gray-900 transition-colors"
      >
        ← back to script
      </Link>

      <div className="mt-6 mb-6">
        <div className="text-xs uppercase tracking-widest text-gray-500 mb-2">
          preview · browser playback
        </div>
        <h1 className="text-3xl font-semibold tracking-tight text-gray-900">
          {script.brief?.purpose ?? "Preview"}
        </h1>
        <p className="text-sm text-gray-600 mt-2">
          Frontend animations playing live. Iterate scenes here before
          rendering to MP4.
        </p>
      </div>

      {!compositionExists ? (
        <BuildPreviewClient scriptId={params.id} />
      ) : (
        <PreviewClient scriptId={params.id} script={script} />
      )}
    </main>
  );
}
