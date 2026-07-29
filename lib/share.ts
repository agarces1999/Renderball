//
// Public share links — a deck anyone can open, like a Google Slides link.
//
// THE WHOLE SECURITY MODEL IS THE TOKEN, so it is worth being explicit about
// what that means:
//
//   * The token is 32 random bytes, not derived from the document id. Knowing a
//     scriptId — which appears in the owner's own URLs, in exports and in
//     support conversations — must never be enough to read the deck.
//   * A share grants READ of the rendered pages and nothing else. It is not a
//     session: it cannot edit, cannot export, cannot list the owner's other
//     documents, and cannot reach any /api/preview route (those stay behind
//     Clerk, which is why the public surface lives under /s and /api/share).
//   * Revoking sets the token to NULL and takes effect on the next request. A
//     revoked link is indistinguishable from one that never existed — both 404 —
//     so a visitor cannot learn whether a document is there but withdrawn.
//   * Rotating issues a fresh token and invalidates the old one in the same
//     write, so "unshare and reshare" cannot leave two live links.
//
// Lookups are by token ONLY. There is deliberately no function here that takes a
// scriptId and returns a document without an owner — that shape is how a public
// route accidentally becomes a way to read anything.
//
import { randomBytes } from "crypto";
import { prisma } from "./db";
import type { Script } from "../src/schema";

/**
 * 43 URL-safe characters from 32 random bytes.
 *
 * Base64url rather than hex: same entropy in two-thirds the length, and it
 * survives being pasted into chat clients that linkify aggressively.
 */
export const newShareToken = (): string => randomBytes(32).toString("base64url");

export interface SharedDocument {
  scriptId: string;
  script: Script;
  title: string;
}

/**
 * A document's `purpose` is a brief, not a name — often a full sentence, and on
 * generated decks sometimes a paragraph. It is the only human label a document
 * has, so it is what a visitor sees; it just cannot go into a browser tab at
 * full length. First sentence, then a word boundary, then give up and cut.
 */
export const shareTitle = (purpose: string): string => {
  const flat = purpose.replace(/\s+/g, " ").trim();
  if (!flat) return "Untitled document";
  const sentence = flat.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? flat;
  const candidate = sentence.length <= 72 ? sentence : flat;
  if (candidate.length <= 72) return candidate.replace(/[.]$/, "");
  const cut = candidate.slice(0, 72);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.]+$/, "")}…`;
};

/**
 * Resolve a share token to the document it points at.
 *
 * Returns null for an unknown token, a revoked one, or a project that has no
 * built script yet — the caller turns all three into the same 404 so the
 * response cannot be used to probe which documents exist.
 */
export const loadSharedDocument = async (token: string): Promise<SharedDocument | null> => {
  if (!token || token.length < 20) return null; // nothing real is this short

  const project = await prisma.project.findUnique({
    where: { shareToken: token },
    select: { scriptId: true, purpose: true, shareToken: true },
  });
  // findUnique on a nullable unique column cannot match NULL, so a revoked
  // document is already unreachable — this is belt and braces.
  if (!project?.shareToken || !project.scriptId) return null;

  const doc = await prisma.scriptDoc.findUnique({ where: { id: project.scriptId } });
  if (!doc) return null;

  return {
    scriptId: project.scriptId,
    script: doc.json as unknown as Script,
    title: shareTitle(project.purpose ?? ""),
  };
};

export interface ShareState {
  shared: boolean;
  token?: string;
  sharedAt?: Date | null;
}

/** What the owner's editor shows: is this document shared, and under what link. */
export const shareStateFor = async (
  scriptId: string,
  ownerId: string,
): Promise<ShareState | null> => {
  const project = await prisma.project.findFirst({
    where: { scriptId, ownerId },
    select: { shareToken: true, sharedAt: true },
  });
  if (!project) return null; // not theirs, or not a document
  return project.shareToken
    ? { shared: true, token: project.shareToken, sharedAt: project.sharedAt }
    : { shared: false };
};

/**
 * Turn sharing on (or rotate the link). Owner-scoped: the update is filtered by
 * ownerId, so a caller cannot share a document they do not own even if they know
 * its id.
 */
export const enableShare = async (
  scriptId: string,
  ownerId: string,
  { rotate = false }: { rotate?: boolean } = {},
): Promise<ShareState | null> => {
  const project = await prisma.project.findFirst({
    where: { scriptId, ownerId },
    select: { id: true, shareToken: true },
  });
  if (!project) return null;

  // Already shared and not rotating — return the existing link rather than
  // minting a second one, so the URL a user has already sent keeps working.
  if (project.shareToken && !rotate) {
    const existing = await prisma.project.findUnique({
      where: { id: project.id },
      select: { shareToken: true, sharedAt: true },
    });
    return { shared: true, token: existing!.shareToken!, sharedAt: existing!.sharedAt };
  }

  const token = newShareToken();
  const updated = await prisma.project.update({
    where: { id: project.id },
    data: { shareToken: token, sharedAt: new Date() },
    select: { shareToken: true, sharedAt: true },
  });
  return { shared: true, token: updated.shareToken!, sharedAt: updated.sharedAt };
};

/** Turn sharing off. Idempotent: revoking an unshared document is a no-op. */
export const disableShare = async (scriptId: string, ownerId: string): Promise<ShareState | null> => {
  const project = await prisma.project.findFirst({
    where: { scriptId, ownerId },
    select: { id: true },
  });
  if (!project) return null;
  await prisma.project.update({
    where: { id: project.id },
    data: { shareToken: null, sharedAt: null },
  });
  return { shared: false };
};

/** The link a user copies. Relative so it works on any host the app is served from. */
export const shareUrlPath = (token: string): string => `/s/${token}`;
