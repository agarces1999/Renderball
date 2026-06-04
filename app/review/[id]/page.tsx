import Link from "next/link";
import { notFound } from "next/navigation";
import { promises as fs } from "fs";
import path from "path";
import { loadBrief, loadScript } from "../../../lib/store";
import { EditableReview } from "./EditableReview";

/**
 * The story screen (fluid v1) — see DESIGN.md.
 *
 * Server component: loads the saved brief + generated script + any
 * prior MP4 render, then hands off to <EditableReview>, which leads
 * with the story (logline + scene sequence) and the "Build the video"
 * action. The old brief-summary recap is gone: the story IS the header.
 */
export default async function ReviewPage({
  params,
}: {
  params: { id: string };
}) {
  const brief = await loadBrief(params.id);
  if (!brief) notFound();

  const script =
    brief.status === "script_generated" && brief.script_id
      ? await loadScript(brief.script_id)
      : null;

  const existingRenderUrl = brief.script_id
    ? await checkExistingRender(brief.script_id)
    : null;

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <Link
        href="/new"
        className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted transition-colors hover:text-ink"
      >
        ← new
      </Link>

      {brief.status === "failed" && brief.error && (
        <ErrorPanel error={brief.error} />
      )}

      {!script && brief.status !== "failed" && (
        <div className="mt-10 flex items-center gap-3 font-mono text-[13px] text-muted">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent" />
          drafting your story…
        </div>
      )}

      {script && (
        <div className="mt-8">
          <EditableReview
            initialScript={script}
            briefId={brief.id}
            existingRenderUrl={existingRenderUrl}
          />
        </div>
      )}

      <footer className="mt-16 border-t border-hairline pt-6 font-mono text-[11px] text-faint">
        brief {brief.id} · {brief.status}
      </footer>
    </main>
  );
}

const checkExistingRender = async (
  scriptId: string,
): Promise<string | null> => {
  try {
    const filePath = path.join(
      process.cwd(),
      "public",
      "renders",
      `${scriptId}.mp4`,
    );
    await fs.access(filePath);
    return `/renders/${scriptId}.mp4`;
  } catch {
    return null;
  }
};

function ErrorPanel({ error }: { error: string }) {
  return (
    <section className="mt-10 rounded-md border border-red-500/30 bg-red-500/5 p-5">
      <div className="mb-2 font-mono text-[11px] uppercase tracking-widest text-red-400">
        Agent error
      </div>
      <pre className="whitespace-pre-wrap break-words font-mono text-[13px] text-red-300">
        {error}
      </pre>
    </section>
  );
}
