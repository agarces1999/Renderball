import type { ReactNode } from "react";
import { getCurrentUser } from "../lib/auth";
import { listBrandKitSummaries } from "../lib/brand-kits";
import { AppShell } from "./AppShell";

const RAIL_LIMIT = 20;

/**
 * Server wrapper that loads the signed-in user's documents and hands them to
 * the (client) AppShell rail. Use this around any management/per-document
 * surface so the document list is always present. Newest first; overflow links
 * to /documents.
 */
export async function AppShellServer({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();
  const kits = user ? await listBrandKitSummaries(user.id) : [];

  const brands = kits.slice(0, RAIL_LIMIT).map((k) => ({
    id: k.id,
    label: k.name?.trim() || k.host,
    host: k.host,
    dots: (k.palette ?? []).slice(0, 3),
  }));

  return <AppShell brands={brands}>{children}</AppShell>;
}
