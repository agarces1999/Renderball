import Link from "next/link";
import { redirect } from "next/navigation";
import { promises as fs } from "fs";
import path from "path";
import { getCurrentUser } from "../../lib/auth";
import { listBriefsByOwner, type BriefStatus, type StoredBrief } from "../../lib/store";
import { AppShellServer } from "../../components/AppShellServer";
import { ProjectThumb } from "../../components/ProjectThumb";

/**
 * /videos — "Your videos" gallery (the app's home base for returning users).
 *
 * Each card leads with the work: the rendered MP4 (plays on hover) when it
 * exists, otherwise the live composition preview (loads on hover), otherwise a
 * branded placeholder. Newest first, true aspect ratios in a masonry layout.
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

const exists = async (p: string): Promise<boolean> => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
};

type Card = {
  brief: StoredBrief;
  aspect: string;
  mp4Url: string | null;
  previewUrl: string | null;
};

export default async function VideosPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/");
  const briefs = await listBriefsByOwner(user.id);

  const cards: Card[] = await Promise.all(
    briefs.map(async (brief): Promise<Card> => {
      // Fall back to 16:9 for legacy briefs whose stored format isn't one of
      // the known keys (the .data JSON predates the current type).
      const aspect =
        (brief.distribution_format && ASPECT[brief.distribution_format]) ||
        "16:9";
      const sid = brief.script_id;
      if (!sid) return { brief, aspect, mp4Url: null, previewUrl: null };
      const [hasMp4, hasComp] = await Promise.all([
        exists(path.join(process.cwd(), ".data", "renders", `${sid}.mp4`)),
        exists(
          path.join(process.cwd(), "src", "generated", sid, "Composition.tsx"),
        ),
      ]);
      return {
        brief,
        aspect,
        // Served through the owner-gated route, not the static public dir.
        mp4Url: hasMp4 ? `/api/renders/${sid}` : null,
        // Only offer the live preview when there's no finished MP4 to show.
        previewUrl:
          !hasMp4 && hasComp
            ? `/api/preview/${sid}/iframe?scene=0`
            : null,
      };
    }),
  );

  return (
    <AppShellServer>
      <div className="mx-auto max-w-5xl px-6 py-10">
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

        {cards.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="columns-1 gap-3 sm:columns-2 lg:columns-3">
            {cards.map((c) => (
              <VideoCard key={c.brief.id} card={c} />
            ))}
          </div>
        )}
      </div>
    </AppShellServer>
  );
}

function VideoCard({ card }: { card: Card }) {
  const { brief, aspect, mp4Url, previewUrl } = card;
  const status = STATUS[brief.status];
  const title = brief.purpose?.trim() || "Untitled video";

  return (
    <Link
      href={`/review/${brief.id}`}
      className="group mb-3 block break-inside-avoid overflow-hidden rounded-md border border-hairline bg-surface transition-all hover:border-hairline-strong hover:shadow-[0_14px_34px_-22px_rgba(18,26,43,0.4)]"
    >
      <ProjectThumb aspect={aspect} mp4Url={mp4Url} previewUrl={previewUrl} />
      <div className="p-4">
        <div className="mb-2 flex items-center justify-between gap-2 font-mono text-[11px] text-faint">
          <span className="uppercase tracking-[0.12em]">
            {aspect} · {brief.duration_seconds}s
          </span>
          <span>{fmtDate(brief.created_at)}</span>
        </div>
        <p className="line-clamp-3 text-[14px] leading-snug text-ink">{title}</p>
        <div className="mt-3 flex items-center gap-2">
          <StatusChip tone={status.tone} label={status.label} />
          {brief.brand_kit_url && (
            <span className="truncate font-mono text-[11px] text-faint">
              {brief.brand_kit_url.replace(/^https?:\/\//, "")}
            </span>
          )}
        </div>
      </div>
    </Link>
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
