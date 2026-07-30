import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadSharedDocument } from "../../../lib/share";
import { ShareViewer } from "./ShareViewer";

/**
 * /s/<token> — a deck anyone with the link can read.
 *
 * OUTSIDE the Clerk matcher by design. The middleware protects /documents,
 * /preview and the /api/preview family; this path is deliberately not in any of
 * those, because requiring a session would defeat the entire feature. What keeps
 * it safe is that the token IS the credential, it is 32 random bytes, and it
 * grants exactly one thing: rendering the pages of one document.
 *
 * An unknown or revoked token 404s exactly like a document that never existed,
 * so the URL space cannot be probed to learn what is out there.
 */

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: { token: string };
}): Promise<Metadata> {
  const shared = await loadSharedDocument(params.token);
  if (!shared) return { title: "Not found — Renderball" };

  // The unfurl. A shared link exists to be pasted into a chat, and a link that
  // renders as a blank grey card is one people stop forwarding — so the preview
  // is the deck's actual first slide, served by the public thumbnail route.
  const image = `/api/share/${encodeURIComponent(params.token)}/thumbnail`;
  return {
    title: `${shared.title} — Renderball`,
    description: "A presentation made with Renderball.",
    openGraph: {
      title: shared.title,
      description: "A presentation made with Renderball.",
      siteName: "Renderball",
      type: "article",
      images: [{ url: image, width: 1200, height: 675, alt: shared.title }],
    },
    twitter: { card: "summary_large_image", title: shared.title, images: [image] },
    // Unfurling is not indexing. The deck is the recipient's business and not a
    // search engine's, so the preview is offered and the crawl is refused.
    robots: { index: false, follow: false },
  };
}

export default async function SharedDeckPage({ params }: { params: { token: string } }) {
  const shared = await loadSharedDocument(params.token);
  if (!shared) notFound();

  return (
    <ShareViewer
      token={params.token}
      title={shared.title}
      pages={shared.script.scenes.map((s) => ({ label: s.label ?? "Page" }))}
    />
  );
}
