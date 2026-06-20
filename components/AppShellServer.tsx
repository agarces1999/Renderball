import type { ReactNode } from "react";
import { getCurrentUser } from "../lib/auth";
import { listBriefsByOwner } from "../lib/store";
import { AppShell } from "./AppShell";

const RAIL_LIMIT = 20;

/**
 * Server wrapper that loads the signed-in user's videos and hands them to the
 * (client) AppShell rail. Use this around any management/per-video surface so
 * the video list is always present. Newest first; overflow links to /videos.
 */
export async function AppShellServer({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();
  const briefs = user ? await listBriefsByOwner(user.id) : [];

  const videos = briefs.slice(0, RAIL_LIMIT).map((b) => ({
    id: b.id,
    title: b.purpose?.trim() || "Untitled video",
    status: b.status,
  }));

  return (
    <AppShell videos={videos} hasMore={briefs.length > RAIL_LIMIT}>
      {children}
    </AppShell>
  );
}
