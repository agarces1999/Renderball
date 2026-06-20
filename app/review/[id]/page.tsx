import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "../../../lib/auth";
import { loadBrief, loadScript } from "../../../lib/store";
import { AppShellServer } from "../../../components/AppShellServer";
import { EditableReview } from "./EditableReview";

/**
 * The story screen (fluid v1) — see DESIGN.md.
 *
 * Server component: loads the saved brief + its generated script, then hands
 * off to <EditableReview>, which leads with the story (logline + scene
 * sequence) and the one loud "Build the video" action. MP4 export lives on the
 * preview screen, so it's not duplicated here.
 */
export const dynamic = "force-dynamic";

export default async function ReviewPage({
  params,
}: {
  params: { id: string };
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/");

  const brief = await loadBrief(params.id, user.id);
  if (!brief) notFound();

  // Load the script for any brief that has one (generated, approved, or
  // rendered) — not just freshly-generated — so reopening past work shows the
  // story instead of a perpetual "drafting" state.
  const script = brief.script_id
    ? await loadScript(brief.script_id, user.id)
    : null;

  return (
    <AppShellServer>
      <div className="mx-auto max-w-3xl px-6 py-10">
        {brief.status === "failed" && brief.error && (
          <ErrorPanel error={brief.error} />
        )}

        {!script && brief.status !== "failed" && (
          <div className="mt-4 flex items-center gap-3 font-mono text-[13px] text-muted">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent" />
            drafting your story…
          </div>
        )}

        {script && <EditableReview initialScript={script} />}

        <footer className="mt-16 border-t border-hairline pt-6 font-mono text-[11px] text-faint">
          brief {brief.id} · {brief.status}
        </footer>
      </div>
    </AppShellServer>
  );
}

function ErrorPanel({ error }: { error: string }) {
  return (
    <section className="mt-4 rounded-md border border-red-500/30 bg-red-500/5 p-5">
      <div className="mb-2 font-mono text-[11px] uppercase tracking-widest text-red-500">
        Agent error
      </div>
      <pre className="whitespace-pre-wrap break-words font-mono text-[13px] text-red-500/90">
        {error}
      </pre>
    </section>
  );
}
