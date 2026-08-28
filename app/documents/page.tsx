import { thumbnailVersion } from "../../lib/render/thumbnail";
import Link from "next/link";
import { redirect } from "next/navigation";
import { promises as fs } from "fs";
import path from "path";
import { getCurrentUser } from "../../lib/auth";
import { listBriefsByOwner, type BriefStatus, type StoredBrief } from "../../lib/store";
import { prisma } from "../../lib/db";
import { AppShellServer } from "../../components/AppShellServer";
import { objectExists } from "../../lib/storage/r2";
import { docKey, genDirOf } from "../../lib/render/gen-store";
import { isBlankComposition } from "../../lib/documents/blank-document";
import { DeletableDocumentCard } from "./DeleteDocumentButton";
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
type Status = { label: string; tone: StatusTone };

/** Video chips keep the render vocabulary — that pipeline still walks these
 *  statuses (script_generated on outline, rendered on a finished MP4). */
const VIDEO_STATUS: Record<BriefStatus, Status> = {
  awaiting_agent_1: { label: "Drafting", tone: "wip" },
  script_generated: { label: "Story ready", tone: "ready" },
  script_approved: { label: "Approved", tone: "ready" },
  rendering: { label: "Rendering", tone: "wip" },
  rendered: { label: "Rendered", tone: "ready" },
  failed: { label: "Failed", tone: "fail" },
};

/**
 * Deck chips are derived from what the gallery can observe, not from raw
 * brief.status: the deck build path never advances the pipeline statuses
 * (nothing writes script_approved/rendering, and "rendered" belongs to the
 * MP4 export), so a status-map chip described work nobody was doing — every
 * blank document said "Drafting" forever and every built deck "Outline
 * ready". The composition check is the honest signal; it is the same one
 * that decides whether the card opens the editor.
 */
const deckStatus = (status: BriefStatus, built: boolean): Status => {
  if (status === "failed") return { label: "Failed", tone: "fail" };
  if (built) {
    // A blank document is the user's own canvas from the first click — no
    // agent drafted it and no build ran, so "Built" would overclaim.
    return status === "awaiting_agent_1"
      ? { label: "Ready to edit", tone: "ready" }
      : { label: "Built", tone: "ready" };
  }
  return status === "script_generated"
    ? { label: "Outline ready", tone: "ready" }
    : { label: "Draft", tone: "wip" };
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
  /** Deck has a composition (local or durable) that is more than the
   *  untouched blank — feeds the status chip and the editor-vs-outline link. */
  built: boolean;
};

export default async function DocumentsPage({
  searchParams,
}: {
  // Set by /api/documents/new when creation fails. Without it that route's
  // only failure mode was the browser's own bare HTTP 500 page.
  searchParams?: { error?: string; brand?: string };
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/");
  const createFailed = searchParams?.error === "create_failed";
  const briefs = await listBriefsByOwner(user.id);
  // Sidebar brand chips filter here (founder, 2026-08-29). Match on the
  // normalized host of the brand the deck was built wearing.
  const hostOf = (u?: string | null): string =>
    (u ?? "").replace(/^https?:\/\//, "").replace(/\/.*$/, "").trim().toLowerCase();
  const brandFilter = hostOf(searchParams?.brand);

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
        return { brief, kind, aspect, href: reviewHref, mp4Url: null, previewUrl: null, thumbUrl: null, built: false };
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
      // Composition-exists over-claims for one deck state: a blank document
      // keeps its published composition while a generated outline waits for
      // approval (/api/documents/generate never touches the blank pages). That
      // card must read "Outline ready" and open the review page — "Built"
      // opening an empty canvas would hide the outline the user paid for. An
      // unreadable manifest counts as not-blank so genuinely built decks whose
      // local dir was wiped by a redeploy (hasComp via R2) never downgrade.
      const outlineAwaitingApproval =
        kind === "deck" &&
        hasComp &&
        brief.status === "script_generated" &&
        (await isBlankComposition(genDirOf(sid), "not-blank"));
      const deckBuilt = kind === "deck" && hasComp && !outlineAwaitingApproval;
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
        href: deckBuilt ? `/preview/${sid}` : reviewHref,
        // Served through the owner-gated route, not the static public dir.
        mp4Url: kind === "video" && hasMp4 ? `/api/renders/${sid}` : null,
        // Only offer the live preview when there's no finished MP4 to show.
        previewUrl:
          kind === "video" && !hasMp4 && hasComp
            ? `/api/preview/${sid}/iframe?scene=0`
            : null,
        thumbUrl: deckBuilt
          ? `/api/preview/${sid}/thumbnail?v=${(await thumbnailVersion(sid)) ?? Date.parse(brief.created_at)}`
          : null,
        built: deckBuilt,
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
              {brandFilter ? (
                <>
                  {`${cards.filter((c) => hostOf(c.brief.brand_kit_url) === brandFilter).length} wearing ${brandFilter}`}
                  {" · "}
                  <Link href="/documents" className="underline decoration-hairline underline-offset-2 transition-colors hover:text-ink">
                    clear
                  </Link>
                </>
              ) : briefs.length === 0 ? (
                "Nothing here yet"
              ) : (
                `${briefs.length} ${briefs.length === 1 ? "document" : "documents"}`
              )}
            </p>
          </div>
          <Link
            href="/api/documents/new" prefetch={false}
            className="shrink-0 rounded-full bg-accent px-4 py-2.5 text-[14px] font-semibold text-accent-ink transition-all hover:brightness-110"
          >
            New document
          </Link>
        </div>

        {createFailed && (
          <div
            role="alert"
            className="mb-6 rounded-md border border-red-500/25 bg-red-500/[0.06] px-4 py-3"
          >
            <p className="text-[14px] font-medium text-ink">
              We couldn&rsquo;t start that document.
            </p>
            <p className="mt-1 font-mono text-[12px] text-muted">
              Nothing was charged. Try &ldquo;New document&rdquo; again — if it
              keeps failing, email support@renderball.com.
            </p>
          </div>
        )}

        {cards.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[...cards]
              .filter((c) => !brandFilter || hostOf(c.brief.brand_kit_url) === brandFilter)
              .sort((a, b) => Date.parse(b.brief.created_at) - Date.parse(a.brief.created_at))
              .map((c) => (
                <DocumentCard key={c.brief.id} card={c} />
              ))}
          </div>
        )}
      </div>
    </AppShellServer>
  );
}

function DocumentCard({ card }: { card: Card }) {
  const { brief, kind, aspect, href, mp4Url, previewUrl, thumbUrl, built } = card;
  const status = kind === "deck" ? deckStatus(brief.status, built) : VIDEO_STATUS[brief.status];
  const title =
    brief.purpose?.trim() || (kind === "deck" ? "Untitled deck" : "Untitled video");

  return (
    // The wrapper is the client component so a confirmed delete can collapse
    // the whole card out of the grid, not just overlay it.
    <DeletableDocumentCard id={brief.id} title={title}>
    <Link
      href={href}
      className="block overflow-hidden rounded-md border border-hairline bg-surface transition-all hover:border-hairline-strong hover:shadow-[0_14px_34px_-22px_rgba(18,26,43,0.4)]"
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
    </DeletableDocumentCard>
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
        href="/api/documents/new" prefetch={false}
        className="mt-6 inline-block rounded-full bg-accent px-5 py-2.5 text-[14px] font-semibold text-accent-ink transition-all hover:brightness-110"
      >
        Make your first deck
      </Link>
    </div>
  );
}
