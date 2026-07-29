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
  return {
    title: `${shared.title} — Renderball`,
    description: "A presentation made with Renderball.",
    // A shared link is meant to be pasted into chat, but the deck is the
    // recipient's business and not search engines'.
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
