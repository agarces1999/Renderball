import Link from "next/link";
import { listBriefs, type BriefStatus, type StoredBrief } from "../../lib/store";
import { AppHeader } from "../../components/AppHeader";

/**
 * /videos — "Your videos" gallery (the app's home base for returning users).
 *
 * Lists every saved brief newest-first as quiet cards. The front door
 * (/new) stays the create-first entry; this is where you come back to
 * reopen work. Per DESIGN.md the chrome is quiet: greyscale cards, the
 * emerald accent only on status and the one loud "New video" action.
 */
export const dynamic = "force-dynamic";

const ASPECT: Record<NonNullable<StoredBrief["distribution_format"]>, string> = {
  "mobile-feed": "9:16",
  square: "1:1",
  landscape: "16:9",
};

const STATUS: Record<BriefStatus, { label: string; tone: "ready" | "wip" | "fail" }> = {
  awaiting_agent_1: { label: "Drafting", tone: "wip" },
  script_generated: { label: "Story ready", tone: "ready" },
  script_approved: { label: "Approved", tone: "ready" },
  rendering: { label: "Rendering", tone: "wip" },
  rendered: { label: "Rendered", tone: "ready" },
  failed: { label: "Failed", tone: "fail" },
};

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default async function VideosPage() {
  const briefs = await listBriefs();

  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-5xl px-6 py-10">
        <div className="mb-8 flex items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-[clamp(26px,3.4vw,34px)] font-semibold tracking-tight text-ink">
              Your videos
            </h1>
            <p className="mt-1.5 font-mono text-[12px] text-muted">
              {briefs.length === 0
                ? "Nothing here yet"
                : `${briefs.length} ${briefs.length === 1 ? "project" : "projects"}`}
            </p>
          </div>
          <Link
            href="/new"
            className="shrink-0 rounded-md bg-accent px-4 py-2.5 text-[14px] font-semibold text-accent-ink transition-all hover:brightness-110"
          >
            New video
          </Link>
        </div>

        {briefs.length === 0 ? (
          <EmptyState />
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {briefs.map((b) => (
              <VideoCard key={b.id} brief={b} />
            ))}
          </ul>
        )}
      </main>
    </>
  );
}

function VideoCard({ brief }: { brief: StoredBrief }) {
  const status = STATUS[brief.status];
  const aspect = brief.distribution_format
    ? ASPECT[brief.distribution_format]
    : null;
  const title = brief.purpose?.trim() || "Untitled video";

  return (
    <li>
      <Link
        href={`/review/${brief.id}`}
        className="group flex h-full flex-col rounded-md border border-hairline bg-surface p-5 transition-all hover:border-hairline-strong hover:shadow-[0_14px_34px_-22px_rgba(18,26,43,0.4)]"
      >
        <div className="mb-3 flex items-center justify-between gap-2 font-mono text-[11px] text-faint">
          <span className="uppercase tracking-[0.12em]">
            {aspect ?? "—"} · {brief.duration_seconds}s
          </span>
          <span>{fmtDate(brief.created_at)}</span>
        </div>
        <p className="line-clamp-3 flex-1 text-[15px] leading-snug text-ink transition-colors group-hover:text-ink">
          {title}
        </p>
        <div className="mt-4 flex items-center gap-2">
          <StatusChip tone={status.tone} label={status.label} />
          {brief.brand_kit_url && (
            <span className="truncate font-mono text-[11px] text-faint">
              {brief.brand_kit_url.replace(/^https?:\/\//, "")}
            </span>
          )}
        </div>
      </Link>
    </li>
  );
}

function StatusChip({
  tone,
  label,
}: {
  tone: "ready" | "wip" | "fail";
  label: string;
}) {
  const cls =
    tone === "ready"
      ? "border-accent-line bg-accent-soft text-accent-text"
      : tone === "fail"
        ? "border-red-500/30 bg-red-500/10 text-red-500"
        : "border-hairline-strong bg-surface-2 text-muted";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[11px] ${cls}`}
    >
      {tone === "ready" && (
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />
      )}
      {label}
    </span>
  );
}

function EmptyState() {
  return (
    <div className="rounded-lg border border-hairline bg-surface px-6 py-16 text-center">
      <div className="orb mx-auto mb-5 h-12 w-12" aria-hidden />
      <h2 className="font-display text-[20px] font-semibold tracking-tight text-ink">
        No videos yet
      </h2>
      <p className="mx-auto mt-2 max-w-[40ch] text-[14px] leading-relaxed text-muted">
        Start with a prompt and your site. We&apos;ll draft a story you can
        shape before anything renders.
      </p>
      <Link
        href="/new"
        className="mt-6 inline-block rounded-md bg-accent px-5 py-2.5 text-[14px] font-semibold text-accent-ink transition-all hover:brightness-110"
      >
        Make your first video
      </Link>
    </div>
  );
}
