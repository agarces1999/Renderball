import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { promises as fs } from "fs";
import path from "path";
import { getCurrentUser } from "../../../lib/auth";
import { loadScript, loadBriefByScriptId } from "../../../lib/store";
import { AppHeader } from "../../../components/AppHeader";
import { hydrateGenDir } from "../../../lib/render/gen-store";
import { isBlankDocument } from "../../../lib/documents/blank-document";
import { PreviewClient } from "./PreviewClient";
import { BuildPreviewClient } from "./BuildPreviewClient";

/**
 * /preview/[id] — browser preview of the agent-emitted Composition.tsx.
 *
 * The [id] param is the scriptId (matches src/generated/<scriptId>/). If no
 * composition exists yet, the build ceremony runs (BuildPreviewClient);
 * otherwise the editor/playback surface mounts (PreviewClient). Per DESIGN.md
 * the chrome stays quiet here so the user's brand-colored work is loudest.
 */
export default async function PreviewPage({
  params,
}: {
  params: { id: string };
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/");

  const script = await loadScript(params.id, user.id);
  if (!script) notFound();

  // Restore from durable storage first. Without this a redeploy makes the
  // check below fail for a document that still exists, and the page silently
  // fires a brand-new full-price build that yields a DIFFERENT design.
  await hydrateGenDir(params.id);

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

  // Persisted build warnings (warnings.json next to the composition). Without
  // this the client only learns warnings after a regen/export action — a fresh
  // page load of a shipped-with-defects build (structural_unresolved) would
  // show nothing. Best-effort: a missing/corrupt file is just "no warnings".
  let initialWarnings: Record<string, unknown> | null = null;
  if (compositionExists) {
    try {
      const raw = await fs.readFile(
        path.join(process.cwd(), "src", "generated", params.id, "warnings.json"),
        "utf8",
      );
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && Object.keys(parsed).length > 0) {
        initialWarnings = parsed;
      }
    } catch {
      /* no warnings file — nothing to surface */
    }
  }

  // Recover the brief id so the back link lands on the right review page
  // (review is keyed by briefId, not scriptId).
  const brief = await loadBriefByScriptId(params.id, user.id);
  const backHref = brief ? `/review/${brief.id}` : "/documents";
  const isDeck = script.config.kind === "deck";

  // A built deck is a full-bleed editor app (EditorShell owns its own chrome —
  // rail, toolbar, canvas — matching the landing). No AppHeader or centered doc
  // wrapper here: the shell's rail carries the wordmark and "← Documents".
  if (compositionExists && isDeck) {
    return (
      <PreviewClient
        scriptId={params.id}
        script={script}
        initialWarnings={initialWarnings}
        // A blank document HAS a composition (blankScript synthesises one), so
        // it reaches THIS branch — omitting the prop here is exactly how the
        // "how do you want to start?" panel silently vanished when decks moved
        // onto the shell: the prop stayed behind on the legacy branch below.
        // Founder-found (2026-08-03): "no clear way to get it generated".
        // STRUCTURAL blankness, not script blankness — hand edits never touch
        // scene descriptions, so isBlankScript alone reopened the wizard over
        // decks people had already built by hand.
        isBlank={await isBlankDocument(path.dirname(compPath), script)}
      />
    );
  }

  return (
    <>
      <AppHeader />
      {!compositionExists ? (
        <BuildPreviewClient
          scriptId={params.id}
          kind={isDeck ? "deck" : "video"}
          sceneLabels={script.scenes.map((s) => s.label ?? "")}
        />
      ) : (
        <main className="mx-auto max-w-5xl px-6 py-8">
          <Link
            href={backHref}
            className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted transition-colors hover:text-ink"
          >
            ← {isDeck ? "outline" : "story"}
          </Link>
          <div className="mb-6 mt-5">
            <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted">
              {isDeck ? "Editor · every element editable" : "Preview · live playback"}
            </div>
            <h1 className="font-display text-[clamp(22px,3vw,30px)] font-semibold tracking-tight text-ink">
              {script.brief?.purpose ?? "Preview"}
            </h1>
            <p className="mt-1.5 text-[14px] leading-relaxed text-muted">
              {isDeck
                ? "Move, resize, or rewrite anything — or draw a box to generate an element in place. Then export PDF or PNG."
                : "Playing live in your browser. Tweak any scene, then export to MP4."}
            </p>
          </div>
          <PreviewClient
            scriptId={params.id}
            script={script}
            initialWarnings={initialWarnings}
            isBlank={await isBlankDocument(path.dirname(compPath), script)}
          />
        </main>
      )}
    </>
  );
}
