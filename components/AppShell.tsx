"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserButton, useUser } from "@clerk/nextjs";
import type { ReactNode } from "react";
import { cn } from "../lib/cn";

/**
 * Authenticated app shell — a quiet left rail (DESIGN.md: "predictable rail +
 * canvas") for the management surfaces (videos, account, billing). The
 * immersive creation flow (/new, /review, /preview) deliberately does NOT use
 * this — its chrome recedes so the user's video is the loudest thing.
 */
const NAV = [
  { href: "/videos", label: "Your videos" },
  { href: "/account", label: "Account" },
  { href: "/billing", label: "Billing" },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { user } = useUser();

  return (
    <div className="flex min-h-screen bg-canvas">
      {/* Left rail (desktop) */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-hairline bg-surface px-3 py-4 md:flex">
        <Link href="/" className="mb-5 flex items-center gap-2.5 px-2">
          <span className="orb h-6 w-6 shrink-0" aria-hidden />
          <span className="font-display text-[16px] font-semibold tracking-tight text-ink">
            Renderball
          </span>
        </Link>

        <Link
          href="/new"
          className="mb-5 rounded-md bg-accent px-3.5 py-2 text-center text-[13.5px] font-semibold text-accent-ink transition-all hover:brightness-110"
        >
          New video
        </Link>

        <nav className="flex flex-col gap-0.5">
          {NAV.map((item) => {
            const active =
              pathname === item.href || pathname.startsWith(item.href + "/");
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "rounded-md px-3 py-2 text-[13.5px] transition-colors",
                  active
                    ? "bg-accent-soft font-medium text-ink"
                    : "text-muted hover:bg-surface-2 hover:text-ink",
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="mt-auto flex items-center gap-2.5 border-t border-hairline px-1 pt-4">
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
      </aside>

      {/* Mobile top bar */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex items-center justify-between border-b border-hairline bg-canvas/80 px-4 py-3 backdrop-blur-md md:hidden">
          <Link href="/" className="flex items-center gap-2">
            <span className="orb h-5 w-5 shrink-0" aria-hidden />
            <span className="font-display text-[15px] font-semibold tracking-tight text-ink">
              Renderball
            </span>
          </Link>
          <div className="flex items-center gap-3">
            <Link
              href="/new"
              className="rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-accent-ink"
            >
              New video
            </Link>
            <UserButton afterSignOutUrl="/" />
          </div>
        </header>

        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
