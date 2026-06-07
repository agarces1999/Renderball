import Link from "next/link";
import { notFound } from "next/navigation";
import { promises as fs } from "fs";
import path from "path";
import { loadScript, loadBriefByScriptId } from "../../../lib/store";
import { AppHeader } from "../../../components/AppHeader";
import { PreviewClient } from "./PreviewClient";
import { BuildPreviewClient } from "./BuildPreviewClient";

/**
 * /preview/[id] — browser preview of the agent-emitted Composition.tsx.
 *
 * The [id] param is the scriptId (matches src/generated/<scriptId>/). If no
 * composition exists yet, the build ceremony runs (BuildPreviewClient);
 * otherwise the live playback surface mounts (PreviewClient). Per DESIGN.md
 * the chrome stays quiet here so the user's brand-colored video is loudest.
 */
export default async function PreviewPage({
  params,
}: {
  params: { id: string };
}) {
  const script = await loadScript(params.id);
  if (!script) notFound();

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

  // Recover the brief id so "back to story" lands on the right review page
  // (review is keyed by briefId, not scriptId).
  const brief = await loadBriefByScriptId(params.id);
  const backHref = brief ? `/review/${brief.id}` : "/videos";

  return (
    <>
      <AppHeader />
      {!compositionExists ? (
        <BuildPreviewClient
          scriptId={params.id}
          sceneLabels={script.scenes.map((s) => s.label ?? "")}
        />
      ) : (
        <main className="mx-auto max-w-5xl px-6 py-8">
          <Link
            href={backHref}
            className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted transition-colors hover:text-ink"
          >
            ← story
          </Link>
          <div className="mb-6 mt-5">
            <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted">
              Preview · live playback
            </div>
            <h1 className="font-display text-[clamp(22px,3vw,30px)] font-semibold tracking-tight text-ink">
              {script.brief?.purpose ?? "Preview"}
            </h1>
            <p className="mt-1.5 text-[14px] leading-relaxed text-muted">
              Playing live in your browser. Tweak any scene, then export to MP4.
            </p>
          </div>
          <PreviewClient scriptId={params.id} script={script} />
        </main>
      )}
    </>
  );
}
