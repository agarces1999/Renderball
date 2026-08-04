/**
 * Instant paint for /documents. The gallery is force-dynamic and its server
 * render does real per-card work (fs checks, storage HEADs, two database
 * queries) — on a cold container that is seconds of silence after the click.
 * This skeleton is static on purpose: no auth, no data, just the shell's
 * geometry so the navigation acknowledges itself immediately. It mirrors
 * AppShell's layout by hand rather than importing AppShellServer, whose
 * awaited auth + brief list would defeat the point.
 */
export default function DocumentsLoading() {
  return (
    <div className="flex min-h-screen bg-canvas">
      {/* Left rail placeholder (desktop) — same geometry as AppShell's rail. */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 border-r border-hairline bg-surface md:block">
        <div className="px-3 pt-4">
          <div className="mb-4 flex items-center gap-2.5 px-2">
            <span className="orb h-6 w-6 shrink-0" aria-hidden />
            <span className="font-display text-[16px] font-semibold tracking-tight text-ink">
              Renderball
            </span>
          </div>
          <div className="h-9 animate-pulse rounded-md bg-surface-2" />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar placeholder. */}
        <header className="sticky top-0 z-20 flex items-center border-b border-hairline chrome-veil px-4 py-3 backdrop-blur-md md:hidden">
          <div className="flex items-center gap-2">
            <span className="orb h-5 w-5 shrink-0" aria-hidden />
            <span className="font-display text-[15px] font-semibold tracking-tight text-ink">
              Renderball
            </span>
          </div>
        </header>

        <main className="min-w-0 flex-1">
          <div className="mx-auto max-w-5xl px-6 py-10">
            <div className="mb-8 flex items-end justify-between gap-4">
              <div>
                <h1 className="font-display text-[clamp(26px,3.4vw,34px)] font-semibold tracking-tight text-ink">
                  Your documents
                </h1>
                <div className="mt-2.5 h-3.5 w-28 animate-pulse rounded bg-surface-2" />
              </div>
              <div className="h-10 w-36 shrink-0 animate-pulse rounded-md bg-surface-2" />
            </div>

            <div className="columns-1 gap-3 sm:columns-2 lg:columns-3">
              {Array.from({ length: 6 }, (_, i) => (
                <div
                  key={i}
                  className="mb-3 animate-pulse break-inside-avoid overflow-hidden rounded-md border border-hairline bg-surface"
                >
                  <div className="aspect-video w-full bg-surface-2" />
                  <div className="p-4">
                    <div className="h-3 w-24 rounded bg-surface-2" />
                    <div className="mt-3 h-4 w-4/5 rounded bg-surface-2" />
                    <div className="mt-3 h-5 w-24 rounded-full bg-surface-2" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
