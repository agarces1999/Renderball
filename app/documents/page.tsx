import Link from "next/link";
import { redirect } from "next/navigation";
import { promises as fs } from "fs";
import path from "path";
import { getCurrentUser } from "../../lib/auth";
import { listBriefsByOwner, type BriefStatus, type StoredBrief } from "../../lib/store";
import { prisma } from "../../lib/db";
import { AppShellServer } from "../../components/AppShellServer";
import { objectExists } from "../../lib/storage/r2";
import { docKey } from "../../lib/render/gen-store";
import { ProjectThumb } from "../../components/ProjectThumb";

/**
 * /documents — "Your documents" gallery (the app's home base for returning
 * users; /videos permanently redirects here since the canvas pivot).
 *
 * Every document the user has made, newest first, with a kind badge (deck /
 * video). Deck cards lead with a cached page-1 thumbnail (see
 * /api/preview/[id]/thumbnail) and open straight into the preview editor once
 * built; unbuilt documents open their outline. Video cards keep the rendered
 * MP4 (plays on hover-in-view) or the live composition preview on hover.
 */
export const dynamic = "force-dynamic";

const ASPECT: Record<NonNullable<StoredBrief["distribution_format"]>, string> = {
  "mobile-feed": "9:16",
  square: "1:1",
  landscape: "16:9",
};

type StatusTone = "ready" | "wip" | "fail";

/** Status labels per document kind — decks speak outline/build, videos keep
 *  the render vocabulary (that pipeline still renders MP4s). */
const STATUS: Record<"deck" | "video", Record<BriefStatus, { label: string; tone: StatusTone }>> = {
  deck: {
    awaiting_agent_1: { label: "Drafting", tone: "wip" },
    script_generated: { label: "Outline ready", tone: "ready" },
    script_approved: { label: "Approved", tone: "ready" },
    rendering: { label: "Building", tone: "wip" },
    rendered: { label: "Built", tone: "ready" },
    failed: { label: "Failed", tone: "fail" },
  },
  video: {
    awaiting_agent_1: { label: "Drafting", tone: "wip" },
    script_generated: { label: "Story ready", tone: "ready" },
    script_approved: { label: "Approved", tone: "ready" },
    rendering: { label: "Rendering", tone: "wip" },
    rendered: { label: "Rendered", tone: "ready" },
    failed: { label: "Failed", tone: "fail" },
  },
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
  kind: "deck" | "video";
  aspect: string;
  href: string;
  mp4Url: string | null;
  previewUrl: string | null;
  thumbUrl: string | null;
};

export default async function DocumentsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/");
  const briefs = await listBriefsByOwner(user.id);

  // Durable-render set: which projects have a completed Render row. This is the
  // source of truth for "a finished MP4 exists" — local disk is only a warm
  // cache (wiped on redeploy), and brief.status is never set to "rendered".
  // One indexed query for the whole gallery (no per-card R2 HEAD).
  const renderedProjectIds = new Set(
    (
      await prisma.render
        .findMany({ where: { ownerId: user.id, status: "complete" }, select: { projectId: true } })
        .catch(() => [])
    ).map((r) => r.projectId),
  );

  const cards: Card[] = await Promise.all(
    briefs.map(async (brief): Promise<Card> => {
      // Absent kind = legacy brief from the video era.
      const kind = brief.kind ?? "video";
      // Fall back to 16:9 for legacy briefs whose stored format isn't one of
      // the known keys (the .data JSON predates the current type).
      const aspect =
        (brief.distribution_format && ASPECT[brief.distribution_format]) ||
        "16:9";
      const sid = brief.script_id;
      const reviewHref = `/review/${brief.id}`;
      if (!sid) {
        return { brief, kind, aspect, href: reviewHref, mp4Url: null, previewUrl: null, thumbUrl: null };
      }
      const [hasLocalMp4, hasLocalComp] = await Promise.all([
        exists(path.join(process.cwd(), ".data", "renders", `${sid}.mp4`)),
        exists(
          path.join(process.cwd(), "src", "generated", sid, "Composition.tsx"),
        ),
      ]);
      // Same reasoning as the MP4 line below: local disk is a warm cache, so a
      // durable bundle in storage also means "built" — without that check every
      // card silently downgrades to the outline link after a redeploy. But only
      // ASK storage when the local answer is already "missing": checking it
      // unconditionally was one HEAD per card per page view, unbounded-parallel,
      // for an answer the filesystem had already given us.
      const hasComp = hasLocalComp || (await objectExists(docKey(sid)));
      // Show the MP4 if it's on the warm local disk OR a completed Render row
      // proves it's durably in R2 (survives a fresh container).
      const hasMp4 = hasLocalMp4 || renderedProjectIds.has(brief.id);
      return {
        brief,
        kind,
        aspect,
        // Built decks open the editor. Everything else opens the outline —
        // /preview/[id] auto-starts the (expensive) build when no composition
        // exists, so an unbuilt card must never link there.
        href: kind === "deck" && hasComp ? `/preview/${sid}` : reviewHref,
        // Served through the owner-gated route, not the static public dir.
        mp4Url: kind === "video" && hasMp4 ? `/api/renders/${sid}` : null,
        // Only offer the live preview when there's no finished MP4 to show.
        previewUrl:
          kind === "video" && !hasMp4 && hasComp
            ? `/api/preview/${sid}/iframe?scene=0`
            : null,
        thumbUrl: kind === "deck" && hasComp ? `/api/preview/${sid}/thumbnail` : null,
      };
    }),
  );

  return (
    <AppShellServer>
      <div className="mx-auto max-w-5xl px-6 py-10">
        <div className="mb-8 flex items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-[clamp(26px,3.4vw,34px)] font-semibold tracking-tight text-ink">
              Your documents
            </h1>
            <p className="mt-1.5 font-mono text-[12px] text-muted">
              {briefs.length === 0
                ? "Nothing here yet"
                : `${briefs.length} ${briefs.length === 1 ? "document" : "documents"}`}
            </p>
          </div>
          <Link
            href="/api/documents/new"
            className="shrink-0 rounded-md bg-accent px-4 py-2.5 text-[14px] font-semibold text-accent-ink transition-all hover:brightness-110"
          >
            New document
          </Link>
        </div>

        {cards.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="columns-1 gap-3 sm:columns-2 lg:columns-3">
            {cards.map((c) => (
              <DocumentCard key={c.brief.id} card={c} />
            ))}
          </div>
        )}
      </div>
    </AppShellServer>
  );
}

function DocumentCard({ card }: { card: Card }) {
  const { brief, kind, aspect, href, mp4Url, previewUrl, thumbUrl } = card;
  const status = STATUS[kind][brief.status];
  const title =
    brief.purpose?.trim() || (kind === "deck" ? "Untitled deck" : "Untitled video");

  return (
    <Link
      href={href}
      className="group mb-3 block break-inside-avoid overflow-hidden rounded-md border border-hairline bg-surface transition-all hover:border-hairline-strong hover:shadow-[0_14px_34px_-22px_rgba(18,26,43,0.4)]"
    >
      <ProjectThumb
        aspect={aspect}
        mp4Url={mp4Url}
        previewUrl={previewUrl}
        thumbUrl={thumbUrl}
      />
      <div className="p-4">
        <div className="mb-2 flex items-center justify-between gap-2 font-mono text-[11px] text-faint">
          <span className="flex items-center gap-2">
            <KindBadge kind={kind} />
            <span className="uppercase tracking-[0.12em]">
              {aspect}
              {kind === "video" ? ` · ${brief.duration_seconds}s` : ""}
            </span>
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

function KindBadge({ kind }: { kind: "deck" | "video" }) {
  return (
    <span
      className={
        kind === "deck"
          ? "rounded-full border border-accent-line bg-accent-soft px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-accent-text"
          : "rounded-full border border-hairline-strong bg-surface-2 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-muted"
      }
    >
      {kind === "deck" ? "Deck" : "Video"}
    </span>
  );
}

function StatusChip({
  tone,
  label,
}: {
  tone: StatusTone;
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
        No documents yet
      </h2>
      <p className="mx-auto mt-2 max-w-[40ch] text-[14px] leading-relaxed text-muted">
        Start with a prompt and your site. We&apos;ll draft an outline you can
        shape before anything builds.
      </p>
      <Link
        href="/api/documents/new"
        className="mt-6 inline-block rounded-md bg-accent px-5 py-2.5 text-[14px] font-semibold text-accent-ink transition-all hover:brightness-110"
      >
        Make your first deck
      </Link>
    </div>
  );
}
