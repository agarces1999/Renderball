"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserButton, useUser } from "@clerk/nextjs";
import type { ReactNode } from "react";
import { cn } from "../lib/cn";

/**
 * Authenticated app shell — a quiet left rail (DESIGN.md: "predictable rail +
 * canvas"). The rail IS the document list, like sessions in a chat app: New
 * document up top, the user's documents as a scrollable list (click to open
 * its outline), account controls at the bottom. The immersive editor surface
 * (/preview) deliberately stays full-bleed so the user's work is the loudest
 * thing.
 */
type SidebarDocument = {
  id: string;
  title: string;
  status: string;
};

export function AppShell({
  documents = [],
  hasMore = false,
  children,
}: {
  documents?: SidebarDocument[];
  hasMore?: boolean;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const { user } = useUser();

  return (
    <div className="flex min-h-screen bg-canvas">
      {/* Left rail (desktop) */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-hairline bg-surface md:flex">
        <div className="px-3 pt-4">
          <Link href="/" className="mb-4 flex items-center gap-2.5 px-2">
            <span className="orb h-6 w-6 shrink-0" aria-hidden />
            <span className="font-display text-[16px] font-semibold tracking-tight text-ink">
              Renderball
            </span>
          </Link>
          <Link
            href="/new"
            className="block rounded-md bg-accent px-3.5 py-2 text-center text-[13.5px] font-semibold text-accent-ink transition-all hover:brightness-110"
          >
            New document
          </Link>
        </div>

        {/* Documents — the rail's "recents". Scrolls; New document + account stay put. */}
        <div className="mt-5 flex min-h-0 flex-1 flex-col px-3">
          <div className="mb-1.5 px-2 font-mono text-[10.5px] uppercase tracking-[0.14em] text-faint">
            Documents
          </div>
          <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pb-2">
            {documents.length === 0 ? (
              <p className="px-2 py-2 text-[13px] leading-relaxed text-faint">
                No documents yet. Make your first one.
              </p>
            ) : (
              documents.map((v) => {
                const active = pathname === `/review/${v.id}`;
                return (
                  <Link
                    key={v.id}
                    href={`/review/${v.id}`}
                    title={v.title}
                    className={cn(
                      "flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors",
                      active
                        ? "bg-accent-soft font-medium text-ink"
                        : "text-muted hover:bg-surface-2 hover:text-ink",
                    )}
                  >
                    <StatusDot status={v.status} />
                    <span className="truncate">{v.title}</span>
                  </Link>
                );
              })
            )}
            {hasMore && (
              <Link
                href="/documents"
                className="block rounded-md px-2 py-1.5 text-[12.5px] text-accent-text transition-colors hover:bg-surface-2"
              >
                Show all documents
              </Link>
            )}
          </nav>
        </div>

        {/* Account + user, pinned to the bottom. */}
        <div className="border-t border-hairline px-3 py-3">
          <div className="mb-2 space-y-0.5">
            <BottomLink href="/account" label="Account" pathname={pathname} />
            <BottomLink href="/billing" label="Billing" pathname={pathname} />
          </div>
          <div className="flex items-center gap-2.5 px-1 pt-1">
            <UserButton afterSignOutUrl="/" />
            <div className="min-w-0">
              <div className="truncate text-[13px] font-medium text-ink">
                {user?.fullName || user?.username || "Account"}
              </div>
              <div className="truncate font-mono text-[11px] text-faint">
                {user?.primaryEmailAddress?.emailAddress ?? ""}
              </div>
            </div>
          </div>
        </div>
      </aside>

      {/* Mobile top bar */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex items-center justify-between border-b border-hairline chrome-veil px-4 py-3 backdrop-blur-md md:hidden">
          <Link href="/" className="flex items-center gap-2">
            <span className="orb h-5 w-5 shrink-0" aria-hidden />
            <span className="font-display text-[15px] font-semibold tracking-tight text-ink">
              Renderball
            </span>
          </Link>
          <div className="flex items-center gap-3">
            <Link
              href="/documents"
              className="text-[12.5px] text-muted transition-colors hover:text-ink"
            >
              Documents
            </Link>
            <Link
              href="/new"
              className="rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-accent-ink"
            >
              New document
            </Link>
            <UserButton afterSignOutUrl="/" />
          </div>
        </header>

        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}

function BottomLink({
  href,
  label,
  pathname,
}: {
  href: string;
  label: string;
  pathname: string;
}) {
  const active = pathname === href || pathname.startsWith(href + "/");
  return (
    <Link
      href={href}
      className={cn(
        "block rounded-md px-2 py-1.5 text-[13px] transition-colors",
        active
          ? "bg-accent-soft font-medium text-ink"
          : "text-muted hover:bg-surface-2 hover:text-ink",
      )}
    >
      {label}
    </Link>
  );
}

function StatusDot({ status }: { status: string }) {
  const cls =
    status === "rendered"
      ? "bg-accent"
      : status === "failed"
        ? "bg-red-500"
        : status === "rendering" || status === "awaiting_agent_1"
          ? "bg-faint"
          : "bg-hairline-strong";
  return (
    <span
      className={cn("inline-block h-1.5 w-1.5 shrink-0 rounded-full", cls)}
      aria-hidden
    />
  );
}
