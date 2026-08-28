"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The first thing a user sees in a brand-new document: the BRAND CEREMONY,
 * then the choice.
 *
 * Founder call 2026-08-11: every new document opens on a dedicated brand flow
 * — whose document is this? A saved named brand (one click), a site to read
 * (performed live, then confirmed: logo with the upload always offered,
 * colours with the black-&-white question, a name), or nobody ("start without
 * a brand", which is always one quiet click away). The ceremony exists so the
 * user is RECOGNISED as a brand rather than handed a form — and its colour
 * confirmation is the human answer to the one question the crawler measurably
 * cannot answer from bytes (docs/BRAND_ACCURACY.md: achromatic detection 0/9,
 * three detectors killed by data).
 *
 * After the ceremony (confirmed or skipped) comes the original call: "New
 * document" opens the editor, and the editor offers the choice — generate
 * every page, or build it up one at a time. That choice is the whole product
 * thesis in one card, so it is stated plainly rather than buried in a menu.
 *
 * The two paths are deliberately asymmetric, because their costs are:
 *   - Building it yourself is FREE and instant. It is the default, and it is
 *     what the landing sells ("draw a box, say what belongs inside it").
 *   - Generating every page is the expensive action — a model writes the
 *     outline, then every page is designed. So it asks for a brief, states
 *     that it costs tokens, and is the secondary button, not the loud one.
 *
 * This panel only exists while the document is untouched (isBlankScript).
 * The moment there is real content it disappears for good — it is an empty
 * state, not a mode.
 *
 * TWO choices, never three. A third option briefly lived here: continuing the
 * sketch a visitor drew on the home page. Founder call (2026-08-06) — remove
 * it. The landing's elements are canned demo content (a KPI reading "4.6 min
 * from one URL", a stock bar chart, a quote attributed to "the model"), so
 * carrying them into somebody's real deck imports OUR marketing filler into
 * THEIR document. It also could not do what its label promised, which is how
 * it was noticed. Do not reintroduce it without a real answer to "why would
 * anyone want this in their deck".
 */

/**
 * The steps shown while an outline is being written.
 *
 * PACED, NOT MEASURED — and the design is built around admitting that.
 * lib/llm/cast-provider.ts is deliberately non-streaming, so there is no
 * progress signal to read; inventing a percentage would be a lie told with a
 * progress bar. What IS true:
 *
 *   - every line names something the user actually asked for (their page
 *     count, their site), so each is a true statement about the work;
 *   - the elapsed clock beside them is real, and is the only number claimed;
 *   - the LAST step never completes. It keeps breathing until the response
 *     lands. A ceremony whose steps all tick green while the user waits is
 *     precisely the moment it becomes dishonest — the same discipline
 *     BuildPreviewClient uses when it holds its final step.
 */
export const generatingSteps = (pages: number, url: string): string[] => {
  const site = url.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  return [
    "Reading your brief",
    ...(site ? [`Looking at ${site}`] : []),
    "Finding the story",
    `Naming your ${pages} page${pages === 1 ? "" : "s"}`,
    // One page has no order to put anything in. The generic line read as
    // filler there, which is exactly what erodes trust in a progress display.
    ...(pages === 1 ? ["Shaping the page"] : ["Putting them in order"]),
  ];
};

/**
 * How long "Generate" will wait for a brand read that is already running.
 * The free read measured a 1.4s median and a 4.6s max over ten live sites;
 * this is a generous multiple of that, and far below the ~79s median outline
 * it precedes, so nobody perceives it. Past it
 * we generate without the brand rather than hold the user up — brand never
 * gates generation.
 */
const BRAND_WAIT_MS = 8_000;

/**
 * Does this look enough like a website to try? PRESENTATION ONLY.
 *
 * The authority is `normalizeSiteUrl` on the server — this cannot import it,
 * because lib/documents/site-brand.ts reaches lib/crawl, and that graph pulls
 * `fs` and the vision transport into a browser bundle. So the rule is
 * deliberately dumber than the server's and only decides whether to bother
 * firing a request while somebody is still typing. It may be STRICTER than
 * the server, never looser.
 *
 * The two-character TLD floor is the part that earns its keep: without it
 * "stripe.c" — a hostname three keystrokes from finished — read as a site and
 * fired a real fetch at somebody's origin. Every accepted value here is a
 * request to a stranger's server, so the bar is "plausibly complete", not
 * "contains a dot".
 */
export const looksLikeSite = (raw: string): boolean => {
  const host = raw.trim().replace(/^https?:\/\//i, "").split(/[/?#]/)[0];
  return host.length >= 4 && /^[^\s.]+(\.[^\s.]+)*\.[a-z]{2,}$/i.test(host);
};

/**
 * Turn a route's reply into something a person can act on.
 *
 * Routes answer `{ error: "unauthorized" }` because that is the right thing
 * to say to an API consumer — and this panel used to print it verbatim. A
 * user whose session had lapsed attached a document and was told, in full,
 * "unauthorized". Caught by attaching a file to the signed-out harness. A
 * status the user can DO something about gets a sentence about what to do.
 *
 * Module scope, not the component body: the brand read's callback closes over
 * it, and a `const` declared further down the body is a trap waiting for
 * whoever next reorders these hooks.
 */
const humanError = (status: number, raw: unknown, fallback: string): string => {
  if (status === 401)
    return "You have been signed out. Refresh the page, sign in, and it will still be here.";
  if (status === 413) return typeof raw === "string" ? raw : "That file is too large.";
  const text = typeof raw === "string" ? raw.trim() : "";
  // A bare one-word code is wire vocabulary, not a message.
  if (!text || (!/\s/.test(text) && text.length < 24)) return fallback;
  return text;
};

/** What the brand read is doing, as far as this panel is concerned. */
type BrandRead = {
  phase: "reading" | "done";
  /** The read reached the site at all. Absent while reading. */
  ok?: boolean;
  /** The honest sentence from the server. Never composed here. */
  message?: string;
  /** Set only when a signature colour was actually observed. */
  accent?: string;
  /** The free read came up short and the paid one is worth offering. */
  canGoDeeper?: boolean;
  /** The read failed for a reason no retry changes (the site refused us, or
   *  nothing answered). Changes what the panel LEADS with. */
  refusal?: "refused" | "unreachable" | null;
  /** Which read produced this — so "look deeper" cannot be offered twice. */
  tier?: "free" | "vision";
  /** The confirmation beat's working set, composed server-side. */
  ceremony?: CeremonyInfo;
};

/** Mirror of CeremonyBrand (lib/documents/brand-crawl.ts) — what beat 3 shows. */
type CeremonyInfo = {
  host: string;
  suggested_name: string;
  logo?: string;
  signature?: string;
  palette: string[];
  display_font?: string;
  body_font?: string;
  no_colour: boolean;
};

/** A saved, NAMED brand on the account — one click instead of a crawl. */
type KitSummary = {
  id: string;
  name?: string;
  host: string;
  logo_hd?: string;
  palette: string[];
};

/**
 * Wait for a brand read that is running server-side.
 *
 * Shorter patience than the outline on purpose: the free read measured a 1.4s
 * median (4.6s max) over ten live sites and the paid one 10-25s, and nothing
 * on this screen is waiting for either. Running
 * out of patience is not an error — it just stops the spinner. The document is
 * open and editable the whole time.
 */
const pollBrand = async (
  scriptId: string,
  deadlineMs: number,
): Promise<Record<string, unknown> | null> => {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 1_200));
    let res: Response;
    try {
      res = await fetch(`/api/documents/brand?scriptId=${encodeURIComponent(scriptId)}`);
    } catch {
      continue; // a dropped poll is not news
    }
    if (!res.ok) continue;
    const data = (await res.json().catch(() => null)) as
      | { status?: string; result?: Record<string, unknown> }
      | null;
    if (!data) continue;
    if (data.status === "done") return data.result ?? null;
    if (data.status === "error") return null;
  }
  return null;
};

/**
 * Wait for an outline that is being written server-side.
 *
 * A network blip must NOT be read as failure — the outline is still being
 * written on the server and a single dropped poll is not news. Only a real
 * `error` state or running out of patience ends the wait.
 */
const pollOutline = async (
  scriptId: string,
): Promise<{ ok: true; body: unknown } | { ok: false; status: number; error?: string } | null> => {
  const DEADLINE_MS = 8 * 60_000; // far above the p99 outline; the clock on screen is the real signal
  const INTERVAL_MS = 2_500;
  const until = Date.now() + DEADLINE_MS;

  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
    let res: Response;
    try {
      res = await fetch(`/api/documents/generate?scriptId=${encodeURIComponent(scriptId)}`);
    } catch {
      continue; // transient blip — keep waiting
    }
    if (!res.ok) continue;
    const data = (await res.json().catch(() => null)) as
      | { status?: string; result?: unknown; resultStatus?: number; error?: string }
      | null;
    if (!data) continue;
    if (data.status === "done") {
      const status = data.resultStatus ?? 200;
      if (status >= 200 && status < 300) return { ok: true, body: data.result };
      const body = data.result as { error?: string } | null;
      return { ok: false, status, error: body?.error };
    }
    if (data.status === "error") return { ok: false, status: 500, error: data.error };
    // "running" or "unknown" — an unknown after a container restart is not a
    // failure either; the page decides from whether the outline exists.
  }
  return null;
};

/**
 * "Where does your brand live?" — optional, on both branches, never a gate.
 *
 * Three states, not two. The 41% case — the crawl reached the site and
 * recovered neither a colour nor a font — used to print "brand loaded from
 * {url}" with an accent dot beside it, which is a confident lie. The sentence
 * shown here is composed on the SERVER from `brandExtractYield`, the one
 * predicate the persistence gate uses, so the banner and the database can
 * never disagree about whether a brand was found.
 *
 * The swatch appears only when a signature colour was actually observed, so
 * the dot is evidence rather than decoration.
 */
function BrandAsk({
  url,
  onUrl,
  brand,
  deepBusy,
  onLookDeeper,
}: {
  url: string;
  onUrl: (v: string) => void;
  brand: BrandRead | null;
  deepBusy: boolean;
  onLookDeeper: () => void;
}) {
  return (
    <div className="mt-4">
      <label className="block">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
          Your site — so it looks like you (optional)
        </span>
        <input
          type="text"
          value={url}
          onChange={(e) => onUrl(e.target.value)}
          placeholder="yoursite.com"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="mt-1 w-full rounded-md border border-hairline bg-surface-2 px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-accent-line"
        />
      </label>

      {brand?.phase === "reading" && (
        <p className="mt-1.5 flex items-center gap-2 text-[11.5px] text-muted">
          <span
            aria-hidden
            className="inline-block h-1.5 w-1.5 rounded-full bg-accent"
            style={{ animation: "rb-step-pulse 1.4s ease-in-out infinite" }}
          />
          Reading your site — this is free and nothing is waiting for it.
        </p>
      )}

      {brand?.phase === "done" && brand.message && (
        <div className="mt-1.5">
          <p className="flex items-start gap-2 text-[11.5px] leading-relaxed text-muted">
            {brand.accent && (
              <span
                aria-hidden
                className="mt-1 inline-block h-2.5 w-2.5 shrink-0 rounded-full border border-hairline"
                style={{ background: brand.accent }}
              />
            )}
            <span className="text-ink-soft">{brand.message}</span>
          </p>
          {brand.canGoDeeper && (
            /* THE ONLY PAID BRAND ACTION IN THE PRODUCT, and it is a button.
               The free read is deterministic; this one screenshots the page
               and reads it with a vision model — ~$0.004 and 10-25s. It is
               offered only after the free read came up short, and it says what
               it costs before it is pressed. Nothing spends on its own. */
            <button
              type="button"
              onClick={onLookDeeper}
              disabled={deepBusy}
              className="mt-1.5 rounded-md border border-hairline px-2.5 py-1 text-[11.5px] text-muted transition-colors hover:border-accent-line hover:text-ink disabled:opacity-60"
            >
              {deepBusy ? "Looking…" : "Look harder (uses a few tokens)"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function BlankDocumentPanel({
  scriptId,
  onDismiss,
  onBrandApplied,
  apiBase = "/api/preview",
}: {
  scriptId: string;
  onDismiss: () => void;
  /** Base for the logo-upload route (`${apiBase}/brand/asset`) — the dev
   *  harness runs against /api/dev, production against /api/preview. */
  apiBase?: string;
  /**
   * The brand read re-skinned this (blank) document server-side and the canvas
   * on screen is now stale by one version.
   *
   * OPTIONAL AND CURRENTLY UNWIRED. The host page owns the iframe's cache
   * key — `PreviewClient` already passes `onApplied={() => setReloadKey(k =>
   * k + 1)}` to BrandPanel for exactly this, and the same one line here would
   * make the brand appear the instant it lands. That file is another agent's,
   * so the prop is defined and called and the wiring is reported rather than
   * made. Until it is wired the document IS branded — the sources are
   * rewritten and published — it just shows up on the next render of the
   * canvas rather than immediately. Deliberately NOT a `location.reload()`:
   * that would throw away whatever the user has typed into this panel.
   */
  onBrandApplied?: () => void;
}) {
  // Render NOTHING until hydrated. This panel arrives server-rendered on a
  // heavy editor page, so for the first seconds it was a pixel-perfect card
  // whose buttons did nothing — a first-time user's very first click on the
  // product's headline offer, silently eaten (probed and reproduced). A
  // moment of absence beats a moment of deadness; visible must mean alive.
  const [live, setLive] = useState(false);
  useEffect(() => setLive(true), []);

  // ── reattach to an outline already generating (founder, 2026-08-13:
  // reloaded mid-generation and landed back on the start card with no sign
  // his outline was still cooking — it was, server-side, and finished fine).
  // One status check on mount: a running job resumes the progress view and
  // the poll; a finished one goes straight to its review. "checking" renders
  // nothing for its ~200ms — the same absence-beats-deadness rule as `live`.
  const [resume, setResume] = useState<"checking" | "none" | "running">("checking");
  const [resumeElapsed, setResumeElapsed] = useState(0);
  /** The job's real start (server clock, ms epoch). The resumed view's clock
   *  and step position derive from THIS, not from when this tab mounted. */
  const resumeStartedAt = useRef<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Retried: this one answer decides between "your outline is still
        // cooking" and a fresh start card. A transient failure (dev under
        // load, a Neon blip, a tab waking from sleep) must not be read as
        // "nothing is running" — that is the exact founder complaint this
        // check exists to prevent.
        let res: Response | null = null;
        for (let tryN = 0; tryN < 3 && !cancelled; tryN++) {
          try {
            res = await fetch(`/api/documents/generate?scriptId=${encodeURIComponent(scriptId)}`);
            if (res.ok) break;
          } catch {
            res = null;
          }
          await new Promise((r) => setTimeout(r, 1200 * (tryN + 1)));
        }
        if (res?.ok) {
          const d = (await res.json().catch(() => null)) as
            | { status?: string; startedAt?: number; result?: { reviewUrl?: string }; resultStatus?: number }
            | null;
          if (d?.status === "running") {
            if (cancelled) return;
            if (typeof d.startedAt === "number") resumeStartedAt.current = d.startedAt;
            setResume("running");
            const settled = await pollOutline(scriptId);
            if (cancelled) return;
            if (settled?.ok) {
              const done = settled.body as { reviewUrl?: string } | null;
              if (done?.reviewUrl) {
                // They watched it finish — same in-place approval beat as the
                // uninterrupted path. (The already-done branch below still
                // assigns: nothing was on screen to stay in.)
                setApproval({ reviewUrl: done.reviewUrl, buildHref: `/preview/${scriptId}?build=1` });
                firePrescaffold();
                return;
              }
            }
            // The resumed run failed (or ran out of patience): fall back to
            // the normal panel with the honest sentence — same as if the
            // user had watched it fail without reloading.
            setResume("none");
            if (settled && !settled.ok) {
              setError(humanError(settled.status, settled.error, "The outline didn't come together this time."));
            }
            return;
          }
          if (d?.status === "done" && (d.resultStatus ?? 200) < 300) {
            const body = d.result as { reviewUrl?: string } | null;
            if (body?.reviewUrl) {
              window.location.assign(body.reviewUrl);
              return;
            }
          }
        }
      } catch {
        /* no job to resume — the ordinary blank-document path */
      }
      if (!cancelled) setResume("none");
    })();
    return () => {
      cancelled = true;
    };
  }, [scriptId]);
  useEffect(() => {
    if (resume !== "running") return;
    const started = resumeStartedAt.current ?? Date.now();
    const tick = () => setResumeElapsed(Math.max(0, Math.round((Date.now() - started) / 1000)));
    tick(); // the first paint already shows the true age, not 0:00
    const t = window.setInterval(tick, 1000);
    return () => window.clearInterval(t);
  }, [resume]);
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [url, setUrl] = useState("");
  const [pages, setPages] = useState(6);
  /**
   * NEVER LEAVE THE EDITOR (founder, 2026-08-14). When the outline
   * finishes, the user stays exactly where the words just typed
   * themselves — the aside becomes the approval beat (Build / Refine)
   * instead of location.assign() yanking them to /review. Review still
   * exists for page-by-page CRUD, reached only by explicit choice.
   * Story-before-render is intact: the Build link carries ?build=1,
   * the same spend consent the review button grants.
   */
  const [approval, setApproval] = useState<{ buildHref: string; reviewUrl: string } | null>(null);
  /** The approval beat fires the SPECULATIVE SCAFFOLD exactly once: the
   *  ~49s design foundation runs while the user reads, so Build starts from
   *  a finished scaffold. Fire-and-forget; failures degrade to the build
   *  scaffolding for itself. */
  const prescaffoldFiredRef = useRef(false);
  const firePrescaffold = () => {
    if (prescaffoldFiredRef.current) return;
    prescaffoldFiredRef.current = true;
    void fetch("/api/documents/prescaffold", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scriptId }),
    }).catch(() => {});
  };
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!busy) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const t = window.setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(t);
  }, [busy]);
  const [error, setError] = useState<string | null>(null);

  // ── the brand read ────────────────────────────────────────────────────────
  //
  // The URL now lives on the CHOICE screen, under both choices, because the
  // gap it closes is exactly the "build it yourself" branch: the field used to
  // exist only inside "generate every page", so half the product's users could
  // never tell us what their brand was. It is optional and it gates nothing —
  // someone with no website types nothing and never sees any of this.
  //
  // Typing a URL fires the FREE read (no model call, ~1.4s median). The paid read is
  // a separate button that only appears when the free one came up short.
  const [brand, setBrand] = useState<BrandRead | null>(null);
  /** Mirror of `stage` for effects declared above it. */
  const stageRef = useRef<"brand" | "choice">("brand");
  const [deepBusy, setDeepBusy] = useState(false);
  // The URL the server has already been asked about, so re-blurring an
  // unchanged field does not re-crawl.
  const readUrl = useRef<string>("");
  // Resolves when the in-flight read settles. `generate()` waits on it so the
  // brand actually reaches the outline: the read persists `brand_extract` onto
  // the brief, and the generate route reads that brief when it starts.
  const reading = useRef<Promise<void> | null>(null);

  const startBrandRead = useCallback(
    async (site: string, vision: boolean) => {
      readUrl.current = site;
      setBrand({ phase: "reading" });
      const done = (async () => {
        try {
          const res = await fetch("/api/documents/brand", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ scriptId, url: site, ...(vision ? { vision: true } : {}) }),
          });
          if (!res.ok && res.status !== 202) {
            const data = await res.json().catch(() => null);
            // A refusal here must never look like a failure of the DOCUMENT.
            setBrand({
              phase: "done",
              message: humanError(res.status, data?.error, "We could not read that address."),
            });
            return;
          }
          const result = await pollBrand(scriptId, vision ? 90_000 : 30_000);
          if (!result) {
            // Nothing to say; the document is unaffected. Forget the URL too:
            // it is what lets Enter / the debounce fire again — with it set,
            // the ceremony snapped back to beat 1 with a dead Enter key.
            readUrl.current = "";
            setBrand(null);
            return;
          }
          const palette = (result.brand as { palette?: { accent?: string } } | undefined)?.palette;
          if (result.applied === true) onBrandApplied?.();
          setBrand({
            phase: "done",
            ok: result.ok === true,
            message: typeof result.message === "string" ? result.message : undefined,
            accent: palette?.accent,
            canGoDeeper: result.canGoDeeper === true,
            refusal:
              result.refusal === "refused" || result.refusal === "unreachable"
                ? result.refusal
                : null,
            tier: result.tier === "vision" ? "vision" : "free",
            ceremony: (result.ceremony as CeremonyInfo | undefined) ?? undefined,
          });
        } catch {
          readUrl.current = "";
          setBrand(null);
        }
      })();
      reading.current = done;
      await done;
      reading.current = null;
    },
    [scriptId, onBrandApplied],
  );

  // Debounced on the URL field. 900ms after the last keystroke, not on every
  // one: each fire is a real fetch of somebody's homepage, and half-typed
  // hostnames are somebody else's server.
  //
  // The "already read this" guard is checked AGAIN when the timer fires, not
  // only when it is set: pressing Generate starts the read early (see below),
  // and without the second check this timer would then fetch the same site a
  // second time.
  useEffect(() => {
    // CHOICE-CARD ONLY. In the ceremony a fired read replaces the input with
    // beat 2, so a thinking pause after "fuse.co" (a valid prefix of the host
    // being typed) would yank the field away mid-word and confirm the wrong
    // site. There, reading is explicit: Enter or the button.
    if (stageRef.current !== "choice") return;
    const site = url.trim();
    if (!looksLikeSite(site) || site === readUrl.current) return;
    const t = window.setTimeout(() => {
      if (site === readUrl.current) return;
      void startBrandRead(site, false);
    }, 900);
    return () => window.clearTimeout(t);
  }, [url, startBrandRead]);

  const lookDeeper = async () => {
    const site = url.trim();
    if (!looksLikeSite(site) || deepBusy) return;
    setDeepBusy(true);
    await startBrandRead(site, true);
    setDeepBusy(false);
  };

  /** Enter in the ceremony's site field — read NOW, not in 900ms. */
  const readNow = useCallback(() => {
    const site = url.trim();
    if (looksLikeSite(site) && site !== readUrl.current) void startBrandRead(site, false);
  }, [url, startBrandRead]);

  // ── the brand ceremony (founder call 2026-08-11) ──────────────────────────
  //
  // Every new document opens on the ceremony: whose document is this — a
  // saved named brand, a site to read, or nobody ("start without a brand").
  // The crawl is PERFORMED (beat 2) and then CONFIRMED (beat 3: logo with the
  // upload always offered, colours with the monochrome question, a name), so
  // the user is recognised as a brand rather than handed a form. It is still
  // never a gate — skip works from every beat, a thin read still opens a
  // working editor, and the only paid action remains the labelled button.
  // Once per document, per tab. The chrome's "Generate every page" button
  // remounts this panel after a dismissal, and being asked to re-confirm a
  // brand you confirmed forty seconds ago reads as the product forgetting
  // you — the opposite of recognition. sessionStorage, not localStorage:
  // a genuinely new visit to a still-blank document may fairly offer the
  // ceremony again.
  const ceremonyKey = `rb-ceremony-${scriptId}`;
  const [stage, setStage] = useState<"brand" | "choice">(() => {
    // Reading storage can THROW, not just fail (Safari/webviews with site
    // data blocked raise SecurityError) — and a throw here is a throw inside
    // render, which takes the whole editor overlay down. Blocked storage just
    // means the ceremony shows again; never an error state.
    try {
      return typeof window !== "undefined" && window.sessionStorage.getItem(ceremonyKey)
        ? "choice"
        : "brand";
    } catch {
      return "brand";
    }
  });
  useEffect(() => {
    stageRef.current = stage;
  }, [stage]);
  const ceremonyDone = useCallback(() => {
    try {
      window.sessionStorage.setItem(ceremonyKey, "1");
    } catch {
      /* storage full/blocked — the worst case is seeing the ceremony again */
    }
  }, [ceremonyKey]);
  const [wearing, setWearing] = useState<{ name: string; accent?: string; saved?: boolean } | null>(null);
  const [kits, setKits] = useState<KitSummary[]>([]);
  useEffect(() => {
    // Saved brands are a bonus, not a dependency: a 401 (dev harness, lapsed
    // session) or a failed fetch just means the row of chips never appears.
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/brand-kits");
        if (!res.ok) return;
        const data = (await res.json().catch(() => null)) as { kits?: KitSummary[] } | null;
        if (!cancelled && Array.isArray(data?.kits)) setKits(data.kits);
      } catch {
        /* the picker degrades to absent */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const [kitBusy, setKitBusy] = useState<string | null>(null);
  // Ceremony failures render in the ceremony and die with it — they used to
  // share `error` with generate(), so a failed kit click followed by a skip
  // showed "Try again · nothing was charged" over a brief that never ran.
  const [ceremonyError, setCeremonyError] = useState<string | null>(null);
  const pickKit = async (kit: KitSummary) => {
    if (kitBusy) return;
    setKitBusy(kit.id);
    setCeremonyError(null);
    try {
      const res = await fetch("/api/brand-kits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scriptId, kitId: kit.id }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        setCeremonyError(humanError(res.status, data?.error, "Could not apply that brand."));
        return;
      }
      if (data.applied === true) onBrandApplied?.();
      // Seed the read state so Generate does not re-crawl what the kit already
      // carries — the extract is on the brief now, which is all the outline reads.
      setUrl(kit.host);
      readUrl.current = kit.host;
      setBrand({ phase: "done", ok: true, accent: data.accent, tier: "free" });
      setWearing({ name: data.name ?? kit.name ?? kit.host, accent: data.accent });
      ceremonyDone();
      setStage("choice");
    } catch {
      setCeremonyError("Network error — check your connection and click the brand again.");
    } finally {
      setKitBusy(null);
    }
  };

  const [confirmBusy, setConfirmBusy] = useState(false);
  const confirmCeremony = async (payload: {
    name: string;
    accent?: string;
    monochrome?: boolean;
    logoSource?: "upload";
  }) => {
    if (confirmBusy) return;
    setConfirmBusy(true);
    setCeremonyError(null);
    try {
      const res = await fetch("/api/brand-kits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scriptId, ...payload }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        setCeremonyError(humanError(res.status, data?.error, "Could not save your brand."));
        return;
      }
      if (data.applied === true) onBrandApplied?.();
      // `saved:false` = the document is dressed but the account-level kit
      // write failed (best-effort by design). The name field promised "saved
      // to your account", so the wearing line owns the correction.
      setWearing({
        name: data.name ?? payload.name,
        accent: data.accent,
        saved: data.saved !== false,
      });
      ceremonyDone();
      setStage("choice");
    } catch {
      setCeremonyError("Network error — your brand was not saved. Try the button again.");
    } finally {
      setConfirmBusy(false);
    }
  };

  // ── attaching a document ──────────────────────────────────────────────────
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [attaching, setAttaching] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [attached, setAttached] = useState<{ name: string; truncated: boolean } | null>(null);

  /**
   * Read a file into the brief box. APPENDS rather than replaces: someone who
   * has already typed two sentences and then attaches the long version should
   * not watch their own words disappear.
   */
  const attach = async (file: File) => {
    setAttaching(true);
    setError(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/documents/attach", { method: "POST", body });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        setError(humanError(res.status, data?.error, "That file could not be read."));
        return;
      }
      setPrompt((prev) => (prev.trim() ? `${prev.trim()}\n\n${data.text}` : data.text));
      setAttached({ name: data.name ?? file.name, truncated: !!data.truncated });
    } catch {
      setError("Could not read that file — check your connection and try again.");
    } finally {
      setAttaching(false);
    }
  };

  const generate = async () => {
    if (!prompt.trim()) {
      setError("Say what the document is about.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Let the brand read land first. The read writes the extract onto the
      // BRIEF, and the generate route loads that brief when it starts — so a
      // user who types a URL and hits generate two seconds later would
      // otherwise pay for an outline that never saw their brand, and the
      // route's own write-back would then drop the extract that arrived a
      // moment too late.
      //
      // Typing a URL and pressing Generate immediately is the ordinary case,
      // so the 900ms debounce has usually not even fired yet — start it here
      // rather than only waiting on something that was never begun.
      const site = url.trim();
      if (looksLikeSite(site) && site !== readUrl.current) {
        void startBrandRead(site, false);
      }
      // Bounded and non-fatal: past the wait we generate anyway, because brand
      // is never allowed to become a gate.
      if (reading.current) {
        await Promise.race([
          reading.current,
          new Promise((r) => setTimeout(r, BRAND_WAIT_MS)),
        ]);
      }
      const res = await fetch("/api/documents/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scriptId, prompt, url: url.trim() || undefined, pages }),
      });
      let data = await res.json().catch(() => null);

      // 202 = the outline is being written server-side and this request is
      // NOT going to be held open for it. Measured: the median outline takes
      // 79s and 28% take longer than 100s — and Cloudflare cuts an origin
      // response at 100s, so a synchronous wait returned a 524 for better than
      // one twelve-page generation in three, for work that had completed fine.
      // Poll instead, exactly as the build does.
      if (res.status === 202) {
        const settled = await pollOutline(scriptId);
        if (!settled) {
          setError("The outline is taking longer than expected. Refresh in a moment — it may already be done.");
          setBusy(false);
          return;
        }
        if (!settled.ok) {
          setError(humanError(settled.status, settled.error, "The outline didn't come together this time."));
          setBusy(false);
          return;
        }
        data = settled.body;
      } else if (!res.ok) {
        setError(humanError(res.status, data?.error, "Could not start generating."));
        setBusy(false);
        return;
      }
      // On to the outline review — the approval step this form just promised.
      // Reloading in place was a dead end: the blank composition still exists,
      // so /preview/[id] re-renders the same blank editor and the outline the
      // user just paid for is never shown.
      const done = data as { reviewUrl?: string } | null;
      if (done?.reviewUrl) {
        // Stay. The manuscript the user just watched being written is the
        // review surface; the aside flips to Build / Refine.
        setApproval({ reviewUrl: done.reviewUrl, buildHref: `/preview/${scriptId}?build=1` });
        firePrescaffold();
      } else {
        window.location.reload();
      }
    } catch {
      setError("Network error.");
      setBusy(false);
    }
  };

  if (!live || resume === "checking") return null;

  if (resume === "running") {
    return (
      <OutlineLive
        scriptId={scriptId}
        steps={["Reading your brief", "Finding the story", "Naming your pages", "Putting them in order"]}
        elapsed={resumeElapsed}
        pages={6}
        approval={approval}
        leftExtras={
          approval ? (
            <div>
              <p className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted">
                Outline ready
              </p>
              <h2 className="mt-1.5 font-display text-[20px] font-bold tracking-tight text-ink">
                Read it, then build
              </h2>
            </div>
          ) : (
            <div>
              <p className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted">
                Still working
              </p>
              <h2 className="mt-1.5 font-display text-[20px] font-bold tracking-tight text-ink">
                Your outline kept generating
              </h2>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-soft">
                The reload didn&apos;t interrupt it — it runs on our side. The moment
                it&apos;s ready you approve it right here.
              </p>
            </div>
          )
        }
      />
    );
  }

  if (stage === "brand") {
    return (
      <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center p-6">
        <div className="pointer-events-auto w-full max-w-[520px] rounded-xl border border-hairline bg-surface p-6 shadow-[0_30px_80px_-40px_rgba(18,26,43,0.45)]">
          <BrandCeremony
            scriptId={scriptId}
            apiBase={apiBase}
            url={url}
            onUrl={setUrl}
            brand={brand}
            kits={kits}
            kitBusy={kitBusy}
            onReadNow={readNow}
            onPickKit={(k) => void pickKit(k)}
            deepBusy={deepBusy}
            onLookDeeper={() => void lookDeeper()}
            confirmBusy={confirmBusy}
            onConfirm={(payload) => void confirmCeremony(payload)}
            onRetry={() => {
              readUrl.current = "";
              setBrand(null);
            }}
            onSkip={() => {
              ceremonyDone();
              setStage("choice");
            }}
            error={ceremonyError}
          />
        </div>
      </div>
    );
  }

  // While the outline WRITES, the form yields the floor entirely: rail on the
  // left, the manuscript full-scale on the stage (founder, 2026-08-14). A
  // failure returns here with the form and the honest error intact.
  if (busy) {
    return (
      <OutlineLive
        scriptId={scriptId}
        steps={generatingSteps(pages, url)}
        elapsed={elapsed}
        pages={pages}
        approval={approval}
        leftExtras={
          <div>
            <p className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted">
              {approval ? "Outline ready" : "Writing your document"}
            </p>
            <h2 className="mt-1.5 font-display text-[20px] font-bold tracking-tight text-ink">
              {approval ? "Read it, then build" : `${pages} pages, from your brief`}
            </h2>
            <p className="mt-2 line-clamp-3 text-[12.5px] leading-relaxed text-muted">
              {prompt.trim() || "Your brief"}
            </p>
          </div>
        }
      />
    );
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center p-6">
      <div className="pointer-events-auto w-full max-w-[520px] rounded-xl border border-hairline bg-surface p-6 shadow-[0_30px_80px_-40px_rgba(18,26,43,0.45)]">
        {!open ? (
          <>
            <p className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted">
              New document
            </p>
            <h2 className="mt-1.5 font-display text-[22px] font-bold tracking-tight text-ink">
              How do you want to start?
            </h2>

            {/* What you sketched on the home page.
                This used to sit ABOVE both real choices, headed "from the
                landing canvas", promising to "continue what you started" —
                and the founder could not tell what it did. Fairly: it does
                not restore anything. It describes your sketch in words and
                pre-types that into the GENERATE form, which spends tokens.
                So it now says where the sketch came from in ordinary words,
                says exactly what the button will do, and sits with the
                generate option it actually leads to rather than above
                everything as a third headline choice. */}

            {/* Generation leads (founder, 2026-08-29): making the whole deck
                is the product's core move and the default path — the blank
                canvas stays one quiet card away, allowed but never
                incentivized. This inverts the metering-era hierarchy that
                made generate "the secondary button, not the loud one". */}
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="mt-5 w-full rounded-lg border border-accent-line bg-accent-soft p-4 text-left transition-colors hover:bg-surface-2"
            >
              <span className="block text-[14px] font-semibold text-ink">
                Generate every page for me
              </span>
              <span className="mt-0.5 block text-[12.5px] leading-relaxed text-ink-soft">
                Describe the document and Renderball writes and designs the whole
                thing — on your brand, ready to edit. Takes a few minutes.
              </span>
            </button>

            {/* Same quiet treatment as "Start without a brand →" one step
                earlier (founder, 2026-08-29): scratch is allowed, never
                incentivized — a mono whisper, not a card. */}
            <button
              type="button"
              onClick={onDismiss}
              className="mt-4 font-mono text-[10.5px] uppercase tracking-[0.14em] text-faint transition-colors hover:text-ink"
            >
              Start from a blank canvas →
            </button>

            {/* BOTH branches, deliberately. This ask used to live inside
                "generate every page" only, so a user who chose to build it
                themselves had no way to tell us their brand at all — which is
                the actual gap behind the founder's "brand should always run".
                It sits BELOW the two choices, not above them, because
                DESIGN.md is explicit that config is refinement and never an
                upfront wizard step: nothing here is required and neither
                button waits for it. */}
            {wearing ? (
              <WearingLine wearing={wearing} />
            ) : (
              <BrandAsk
                url={url}
                onUrl={setUrl}
                brand={brand}
                deepBusy={deepBusy}
                onLookDeeper={() => void lookDeeper()}
              />
            )}

            <p className="mt-4 font-mono text-[10.5px] text-faint">
              You can do both — generate a deck, then edit every element by hand.
            </p>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted transition-colors hover:text-ink"
            >
              ← back
            </button>
            <h2 className="mt-2 font-display text-[20px] font-bold tracking-tight text-ink">
              What is this document about?
            </h2>

            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              autoFocus
              placeholder="A pitch deck for Northwind Coffee — office coffee subscriptions. Who it's for, the problem, the offer, and the ask."
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                const f = e.dataTransfer.files?.[0];
                if (f) void attach(f);
              }}
              className={`mt-3 w-full resize-y rounded-md border bg-surface-2 px-3 py-2.5 text-[13px] leading-relaxed text-ink outline-none focus:border-accent-line ${
                dragging ? "border-accent-line" : "border-hairline"
              }`}
            />

            {/* Attaching is a SHORTCUT INTO the brief, not a second input.
                The text lands in the box above where it can be read, trimmed
                and corrected before a page is generated from it — and nothing
                is stored server-side, so there is no copy of someone's
                company document sitting in our object storage. */}
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                disabled={attaching}
                className="inline-flex items-center gap-1.5 rounded-md border border-hairline px-2.5 py-1 text-[11.5px] text-muted transition-colors hover:border-accent-line hover:text-ink disabled:opacity-60"
              >
                <svg viewBox="0 0 14 14" className="h-3 w-3" fill="none" aria-hidden>
                  <path
                    d="M9.5 4L5 8.5a1.6 1.6 0 002.3 2.3l4.2-4.2a3 3 0 10-4.3-4.3L3 6.6a4.4 4.4 0 006.2 6.2l3.3-3.3"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                  />
                </svg>
                {attaching ? "Reading…" : "Attach a document"}
              </button>
              {attached && (
                <span className="text-[11.5px] text-muted">
                  Added <span className="text-ink">{attached.name}</span>
                  {attached.truncated ? " (first part — it was long)" : ""}
                </span>
              )}
              <input
                ref={fileInput}
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.txt,.md,.markdown,.mdx,.csv,.tsv,.json,.yaml,.yml,.log,.docx,.xlsx,.xlsm,.svg,application/pdf,image/png,image/jpeg,image/webp,image/gif,text/plain,text/markdown,text/csv,image/svg+xml,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  // Reset first, so attaching the SAME file twice still fires.
                  e.target.value = "";
                  if (f) void attach(f);
                }}
              />
            </div>

            {/* The same field as the choice screen, same state, same job.
                Kept here too so somebody who came straight to the brief does
                not have to go back a screen to say where their brand lives. */}
            {wearing ? (
              <WearingLine wearing={wearing} />
            ) : (
              <BrandAsk
                url={url}
                onUrl={setUrl}
                brand={brand}
                deepBusy={deepBusy}
                onLookDeeper={() => void lookDeeper()}
              />
            )}

            <label className="mt-2.5 flex items-center gap-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
                Pages
              </span>
              <input
                type="number"
                min={1}
                max={12}
                value={pages}
                onChange={(e) => setPages(Math.max(1, Math.min(12, Number(e.target.value) || 1)))}
                className="w-16 rounded-md border border-hairline bg-surface-2 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-accent-line"
              />
            </label>

            {/* Deliberately CONSERVATIVE. At 40 chars/page this fired on a
                brief that named the audience, the problem and the ask in 165
                characters — good input, scolded. And the outline matrix shows
                a 91-character fragment producing 12 pages fine, so brevity is
                not a known cause of failure. It now speaks only for briefs
                that are tiny even by a generous reading. */}
            {prompt.trim().length > 0 && prompt.trim().length < pages * 15 && (
              <p className="mt-2.5 text-[12px] leading-relaxed text-muted">
                That is short for {pages} page{pages === 1 ? "" : "s"} — a few
                sentences on who it is for, the problem, and what you are asking
                for gives it more to work with. You can generate anyway.
              </p>
            )}

            <button
              type="button"
              onClick={() => void generate()}
              className="mt-4 w-full rounded-full bg-accent px-4 py-2.5 text-[13.5px] font-semibold text-accent-ink transition-all hover:brightness-110"
            >
              Generate the document
            </button>
            <p className="mt-2 text-center font-mono text-[10.5px] text-faint">
              You approve the outline before anything is designed.
            </p>
            {error && (
              <div className="mt-3 rounded-md border border-red-500/25 bg-red-500/[0.06] px-3 py-2.5">
                <p className="text-[12.5px] leading-relaxed text-ink">{error}</p>
                <div className="mt-2 flex items-center gap-3">
                  {/* One click, brief intact. This failure looks intermittent —
                      it did not reproduce on a like-for-like retry — so the
                      cheapest useful thing is to make trying again cost
                      nothing but a click, rather than making someone wonder
                      whether their text survived. */}
                  <button
                    type="button"
                    onClick={() => void generate()}
                    disabled={busy}
                    className="rounded-md border border-hairline-strong bg-surface px-3 py-1.5 text-[12px] font-medium text-ink transition-colors hover:bg-surface-2 disabled:opacity-50"
                  >
                    {busy ? "Trying…" : "Try again"}
                  </button>
                  <span className="font-mono text-[10.5px] text-faint">
                    your brief is still here · nothing was charged
                  </span>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * "You are wearing Fuse." One quiet line on the choice card after the
 * ceremony — evidence (the swatch) plus the name the user themselves chose.
 */
function WearingLine({ wearing }: { wearing: { name: string; accent?: string; saved?: boolean } }) {
  return (
    <p className="mt-4 flex items-center gap-2 text-[11.5px] text-muted">
      {wearing.accent && (
        <span
          aria-hidden
          className="inline-block h-2.5 w-2.5 shrink-0 rounded-full border border-hairline"
          style={{ background: wearing.accent }}
        />
      )}
      <span className="text-ink-soft">
        Wearing <span className="font-semibold text-ink">{wearing.name}</span> — everything
        you make here will look like you. Change it any time in the Brand panel.
        {wearing.saved === false && (
          <>
            {" "}
            <span className="text-muted">
              (We could not save it to your account just now, so it will not be offered on
              your next document — this one keeps it either way.)
            </span>
          </>
        )}
      </span>
    </p>
  );
}

/**
 * The brand ceremony (founder call 2026-08-11) — the recognition moment.
 *
 * Beat 1  whose document is this: saved named brands, a site to read, or skip.
 * Beat 2  the crawl, performed: a narrated line while the FREE read runs.
 *         Honest by construction — the read is one deterministic pass
 *         (median 1.4s), so nothing here is a fake progress bar; the beat is
 *         short because the work is genuinely short.
 * Beat 3  confirmation, not homework: the logo (upload ALWAYS offered —
 *         founder call), the colours (with the black-&-white question when no
 *         colour was observed — the one judgement bytes measurably cannot
 *         make, docs/BRAND_ACCURACY.md), the type, and a NAME. Confirming
 *         saves the kit to the account and dresses the document.
 *
 * Still never a gate: skip works from every beat, and a failed read offers a
 * retry, an upload, and the same skip — never a dead end.
 */
function BrandCeremony({
  scriptId,
  apiBase,
  url,
  onUrl,
  brand,
  kits,
  kitBusy,
  onReadNow,
  onPickKit,
  deepBusy,
  onLookDeeper,
  confirmBusy,
  onConfirm,
  onRetry,
  onSkip,
  error,
}: {
  scriptId: string;
  apiBase: string;
  url: string;
  onUrl: (v: string) => void;
  brand: BrandRead | null;
  kits: KitSummary[];
  kitBusy: string | null;
  onReadNow: () => void;
  onPickKit: (kit: KitSummary) => void;
  deepBusy: boolean;
  onLookDeeper: () => void;
  confirmBusy: boolean;
  onConfirm: (p: { name: string; accent?: string; monochrome?: boolean; logoSource?: "upload" }) => void;
  onRetry: () => void;
  onSkip: () => void;
  error: string | null;
}) {
  const ceremony = brand?.phase === "done" ? brand.ceremony : undefined;
  const host = url.trim().replace(/^https?:\/\//, "").split(/[/?#]/)[0];

  // ── beat-3 working state ────────────────────────────────────────────────
  const [name, setName] = useState("");
  const [accent, setAccent] = useState<string | undefined>(undefined);
  const [monochrome, setMonochrome] = useState(false);
  const [uploaded, setUploaded] = useState<string | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // Seed per CEREMONY OBJECT, not per host: "look harder" re-reads the same
  // host and returns new evidence, and the colour answers must re-derive from
  // it — a monochrome answer given before the vision read found the real
  // signature would otherwise ride invisibly into the confirm. What survives
  // a same-host re-read: the name the user typed and their uploaded logo
  // (which lives on the document, not in this state).
  const seeded = useRef<CeremonyInfo | null>(null);
  useEffect(() => {
    if (!ceremony || seeded.current === ceremony) return;
    const sameHost = seeded.current?.host === ceremony.host;
    seeded.current = ceremony;
    if (!sameHost) {
      setName(ceremony.suggested_name);
      setUploaded(null);
      setUploadError(null);
    }
    setAccent(ceremony.signature);
    setMonochrome(false);
  }, [ceremony]);

  const fileInput = useRef<HTMLInputElement | null>(null);
  const uploadLogo = async (file: File) => {
    setUploadBusy(true);
    setUploadError(null);
    try {
      const fd = new FormData();
      fd.set("file", file);
      fd.set("scriptId", scriptId);
      // Without these the asset lands in the library as a plain image and
      // brand.logo is never set — the user watches themselves "upload a logo"
      // that no slide will ever carry. kindForMime calls a PNG "image".
      fd.set("kind", "logo");
      fd.set("setAsLogo", "true");
      const res = await fetch(`${apiBase}/brand/asset`, { method: "POST", body: fd });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setUploadError(humanError(res.status, data?.error, "That file could not be used."));
        return;
      }
      setUploaded(data?.asset?.name ?? file.name);
    } catch {
      setUploadError("Could not upload — check your connection and try again.");
    } finally {
      setUploadBusy(false);
    }
  };

  // ── beat 1: whose document is this ──────────────────────────────────────
  if (!brand) {
    return (
      <>
        <p className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted">
          New document
        </p>
        <h2 className="mt-1.5 font-display text-[22px] font-bold tracking-tight text-ink">
          Whose document is this?
        </h2>
        <p className="mt-1 text-[12.5px] leading-relaxed text-ink-soft">
          Renderball designs in your brand — your colours, your type, your logo.
        </p>

        {kits.length > 0 && (
          <div className="mt-4">
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
              Your saved brands
            </p>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {kits.map((k) => (
                <button
                  key={k.id}
                  type="button"
                  disabled={kitBusy !== null}
                  onClick={() => onPickKit(k)}
                  className="inline-flex items-center gap-2 rounded-lg border border-hairline bg-surface px-3 py-2 text-[12.5px] font-medium text-ink transition-colors hover:border-accent-line hover:bg-surface-2 disabled:opacity-60"
                >
                  {k.logo_hd && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={k.logo_hd} alt="" className="h-4 w-4 object-contain" />
                  )}
                  {k.name ?? k.host}
                  <span className="flex gap-0.5" aria-hidden>
                    {k.palette.slice(0, 3).map((hex) => (
                      <span
                        key={hex}
                        className="inline-block h-2 w-2 rounded-full border border-hairline"
                        style={{ background: hex }}
                      />
                    ))}
                  </span>
                  {kitBusy === k.id ? "…" : ""}
                </button>
              ))}
            </div>
          </div>
        )}

        <label className="mt-4 block">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
            {kits.length > 0 ? "Or read a site" : "Your site"}
          </span>
          <input
            type="text"
            value={url}
            onChange={(e) => onUrl(e.target.value)}
            placeholder="yoursite.com"
            autoFocus
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onKeyDown={(e) => {
              if (e.key === "Enter") onReadNow();
            }}
            className="mt-1 w-full rounded-md border border-hairline bg-surface-2 px-3 py-2.5 font-mono text-[13px] text-ink outline-none focus:border-accent-line"
          />
        </label>
        <button
          type="button"
          disabled={!looksLikeSite(url.trim())}
          onClick={onReadNow}
          className="mt-2.5 w-full rounded-full bg-accent px-4 py-2.5 text-[13.5px] font-semibold text-accent-ink transition-all hover:brightness-110 disabled:opacity-40"
        >
          Read my site — free, about two seconds
        </button>

        {error && <p className="mt-3 text-[12px] leading-relaxed text-ink">{error}</p>}

        <button
          type="button"
          onClick={onSkip}
          className="mt-4 font-mono text-[10.5px] uppercase tracking-[0.14em] text-faint transition-colors hover:text-ink"
        >
          Start without a brand →
        </button>
      </>
    );
  }

  // ── beat 2: the crawl, performed ────────────────────────────────────────
  if (brand.phase === "reading") {
    return (
      <>
        <p className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted">
          New document
        </p>
        <h2 className="mt-1.5 font-display text-[22px] font-bold tracking-tight text-ink">
          Reading {host || "your site"}
        </h2>
        <div className="mt-4 space-y-2">
          {["Fetching the page", "Looking for your logo", "Reading your stylesheet", "Reading your type"].map(
            (line, i) => (
              <p
                key={line}
                className="flex items-center gap-2 text-[12.5px] text-muted"
                style={{ animation: "rb-fade-up 0.4s ease both", animationDelay: `${i * 0.35}s` }}
              >
                <span
                  aria-hidden
                  className="inline-block h-1.5 w-1.5 rounded-full bg-accent"
                  style={{ animation: "rb-step-pulse 1.4s ease-in-out infinite" }}
                />
                {line}
              </p>
            ),
          )}
        </div>
        <button
          type="button"
          onClick={onSkip}
          className="mt-5 font-mono text-[10.5px] uppercase tracking-[0.14em] text-faint transition-colors hover:text-ink"
        >
          Skip — start without a brand →
        </button>
      </>
    );
  }

  // ── beat 3, failed read: honest, with every way forward ─────────────────
  if (brand.ok !== true) {
    return (
      <>
        <p className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted">
          New document
        </p>
        <h2 className="mt-1.5 font-display text-[20px] font-bold tracking-tight text-ink">
          {brand.refusal === "refused"
            ? `${ceremony?.host ?? host ?? "That site"} does not let us read it`
            : `We could not read ${ceremony?.host ?? host ?? "that address"}`}
        </h2>
        {brand.message && (
          <p className="mt-2 text-[12.5px] leading-relaxed text-ink-soft">{brand.message}</p>
        )}
        {/* WHAT TO DO NEXT depends on whether trying again could ever help.
            When the site refused us, "try a different address" is the wrong
            headline act — the address was right — so the brand-building path
            becomes the primary button and retry steps back. */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {brand.refusal ? (
            <>
              <button
                type="button"
                onClick={onSkip}
                className="rounded-full bg-accent px-3.5 py-1.5 text-[12px] font-semibold text-accent-ink transition-all hover:brightness-110"
              >
                Set your brand yourself →
              </button>
              <button
                type="button"
                onClick={onRetry}
                className="rounded-md border border-hairline px-3 py-1.5 text-[12px] text-muted transition-colors hover:border-accent-line hover:text-ink"
              >
                Try a different address
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={onRetry}
              className="rounded-md border border-hairline-strong bg-surface px-3 py-1.5 text-[12px] font-medium text-ink transition-colors hover:bg-surface-2"
            >
              Try a different address
            </button>
          )}
          {brand.canGoDeeper && (
            <button
              type="button"
              onClick={onLookDeeper}
              disabled={deepBusy}
              className="rounded-md border border-hairline px-3 py-1.5 text-[12px] text-muted transition-colors hover:border-accent-line hover:text-ink disabled:opacity-60"
            >
              {deepBusy ? "Looking…" : "Look harder (uses a few tokens)"}
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={onSkip}
          className="mt-4 font-mono text-[10.5px] uppercase tracking-[0.14em] text-faint transition-colors hover:text-ink"
        >
          Start without a brand →
        </button>
      </>
    );
  }

  // ── beat 3: confirmation, not homework ──────────────────────────────────
  const c = ceremony;
  const rowAnim = (i: number) => ({
    animation: "rb-fade-up 0.45s ease both",
    animationDelay: `${0.1 + i * 0.18}s`,
  });
  const canConfirm = name.trim().length > 0 && !confirmBusy && !uploadBusy;
  return (
    <>
      <p className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted">
        {c?.host ?? host}
      </p>
      <h2 className="mt-1.5 font-display text-[22px] font-bold tracking-tight text-ink">
        Here is what your site says about you
      </h2>

      {/* logo — the upload is ALWAYS offered (founder call 2026-08-11) */}
      <div className="mt-4" style={rowAnim(0)}>
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">Logo</p>
        <div className="mt-1.5 flex items-center gap-3">
          {uploaded ? (
            <span className="text-[12.5px] text-ink">
              Using your upload — <span className="font-medium">{uploaded}</span>
            </span>
          ) : c?.logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={c.logo}
              alt="Your logo, as found on your site"
              className="h-9 max-w-[140px] rounded border border-hairline bg-surface-2 object-contain px-2 py-1"
            />
          ) : (
            <span className="text-[12.5px] text-muted">We did not find one.</span>
          )}
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={uploadBusy}
            className="rounded-md border border-hairline px-2.5 py-1 text-[11.5px] text-muted transition-colors hover:border-accent-line hover:text-ink disabled:opacity-60"
          >
            {uploadBusy ? "Uploading…" : uploaded || !c?.logo ? "Upload a logo" : "Upload a different one"}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".svg,.png,.jpg,.jpeg,.webp,image/svg+xml,image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void uploadLogo(f);
            }}
          />
        </div>
        {uploadError && <p className="mt-1 text-[11.5px] text-muted">{uploadError}</p>}
      </div>

      {/* colours — with the black-&-white question when nothing chromatic was seen */}
      <div className="mt-4" style={rowAnim(1)}>
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">Colours</p>
        {c?.no_colour ? (
          <div className="mt-1.5">
            <p className="text-[12.5px] leading-relaxed text-ink-soft">
              We read your brand as black &amp; white. Is that right?
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setMonochrome(true);
                  setAccent(undefined);
                }}
                className={`rounded-md border px-3 py-1.5 text-[12px] font-medium transition-colors ${
                  monochrome
                    ? "border-accent-line bg-accent-soft text-ink"
                    : "border-hairline bg-surface text-ink hover:bg-surface-2"
                }`}
              >
                Yes — keep it black &amp; white
              </button>
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-hairline px-3 py-1.5 text-[12px] text-muted transition-colors hover:border-accent-line hover:text-ink">
                No — pick our colour
                <input
                  type="color"
                  value={accent ?? "#0f62fe"}
                  onChange={(e) => {
                    setMonochrome(false);
                    setAccent(e.target.value);
                  }}
                  className="h-4 w-6 cursor-pointer border-0 bg-transparent p-0"
                />
              </label>
              {!monochrome && accent && (
                <span
                  aria-hidden
                  className="inline-block h-4 w-4 rounded-full border border-hairline"
                  style={{ background: accent }}
                />
              )}
            </div>
          </div>
        ) : (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {(c?.palette ?? []).map((hex) => (
              <button
                key={hex}
                type="button"
                title={hex}
                onClick={() => {
                  setMonochrome(false);
                  setAccent(hex);
                }}
                className={`h-6 w-6 rounded-full border transition-transform hover:scale-110 ${
                  !monochrome && accent === hex ? "border-ink ring-2 ring-accent-line" : "border-hairline"
                }`}
                style={{ background: hex }}
                aria-label={`Use ${hex} as the accent`}
              />
            ))}
            <span className="ml-1 text-[11.5px] text-muted">
              {monochrome ? (
                "Black & white"
              ) : accent ? (
                <>
                  Lead colour <span className="font-mono text-ink">{accent}</span>
                </>
              ) : (
                "Pick your lead colour"
              )}
            </span>
            {/* The escape for the brands the crawler measurably gets wrong:
                every truly black-&-white brand arrives on THIS branch wearing
                an invented colour (docs/BRAND_ACCURACY.md, 0/9 with three
                detectors killed by data). Only a human can say so — give them
                the words. */}
            <button
              type="button"
              onClick={() => {
                if (monochrome) {
                  setMonochrome(false);
                  setAccent(c?.signature);
                } else {
                  setMonochrome(true);
                  setAccent(undefined);
                }
              }}
              className={`rounded-md border px-2.5 py-1 text-[11.5px] transition-colors ${
                monochrome
                  ? "border-accent-line bg-accent-soft text-ink"
                  : "border-hairline text-muted hover:border-accent-line hover:text-ink"
              }`}
            >
              {monochrome ? "No — we have a colour" : "We're actually black & white"}
            </button>
          </div>
        )}
      </div>

      {/* type */}
      {(c?.display_font || c?.body_font) && (
        <div className="mt-4" style={rowAnim(2)}>
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">Type</p>
          <p className="mt-1.5 text-[12.5px] text-ink-soft">
            {c?.display_font && (
              <>
                Headlines in <span className="font-medium text-ink">{c.display_font}</span>
              </>
            )}
            {c?.display_font && c?.body_font && " · "}
            {c?.body_font && (
              <>
                body in <span className="font-medium text-ink">{c.body_font}</span>
              </>
            )}
          </p>
        </div>
      )}

      {/* name — what makes it a saved brand, not a crawl cache */}
      <label className="mt-4 block" style={rowAnim(3)}>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
          Name this brand
        </span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={60}
          className="mt-1 w-full rounded-md border border-hairline bg-surface-2 px-3 py-2 text-[13px] text-ink outline-none focus:border-accent-line"
        />
        <span className="mt-1 block text-[11px] text-faint">
          Saved to your account — next document, one click.
        </span>
      </label>

      {brand.canGoDeeper && (
        <button
          type="button"
          onClick={onLookDeeper}
          disabled={deepBusy}
          className="mt-3 rounded-md border border-hairline px-2.5 py-1 text-[11.5px] text-muted transition-colors hover:border-accent-line hover:text-ink disabled:opacity-60"
        >
          {deepBusy ? "Looking…" : "Look harder (uses a few tokens)"}
        </button>
      )}

      {error && <p className="mt-3 text-[12px] leading-relaxed text-ink">{error}</p>}

      <button
        type="button"
        disabled={!canConfirm}
        onClick={() =>
          onConfirm({
            name: name.trim(),
            ...(monochrome ? { monochrome: true } : accent ? { accent } : {}),
            ...(uploaded ? { logoSource: "upload" as const } : {}),
          })
        }
        className="mt-4 w-full rounded-full bg-accent px-4 py-2.5 text-[13.5px] font-semibold text-accent-ink transition-all hover:brightness-110 disabled:opacity-50"
      >
        {confirmBusy ? "Saving…" : "This is my brand"}
      </button>
      <div className="mt-2 flex items-center justify-between">
        <button
          type="button"
          onClick={onRetry}
          className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-faint transition-colors hover:text-ink"
        >
          ← different site
        </button>
        <button
          type="button"
          onClick={onSkip}
          className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-faint transition-colors hover:text-ink"
        >
          Skip for now →
        </button>
      </div>
    </>
  );
}

/**
 * Pull every complete-or-growing JSON string value for `key` out of a raw,
 * possibly TRUNCATED JSON stream. Escapes are decoded; a string cut off
 * mid-token returns what has arrived so far — that partial tail is exactly
 * what the caret types. The [{,] prefix (and the fact that escaped quotes
 * arrive as \" on the wire) keeps prose that merely mentions "label" from
 * matching.
 */
export const extractStreamStrings = (buf: string, key: string): string[] => {
  const res: string[] = [];
  const re = new RegExp(`[{,]\\s*"${key}"\\s*:\\s*"`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(buf))) {
    let i = m.index + m[0].length;
    let out = "";
    while (i < buf.length) {
      const c = buf[i];
      if (c === "\\") {
        const nx = buf[i + 1];
        if (nx === undefined) break; // escape cut at the stream edge
        if (nx === "n" || nx === "t") out += " ";
        else if (nx === "u") {
          const hex = buf.slice(i + 2, i + 6);
          if (hex.length === 4) {
            out += String.fromCharCode(Number.parseInt(hex, 16) || 63);
            i += 4;
          }
        } else out += nx;
        i += 2;
        continue;
      }
      if (c === '"') break;
      out += c;
      i++;
    }
    res.push(out);
  }
  return res;
};

/**
 * Page cards from the raw stream: ONE label + ONE lede per scene segment.
 * Segmented on the scene id markers rather than matching every "label" in
 * the buffer — content objects carry their own nested "label" keys (KPI
 * tiles, chart annotations), and a flat scan typed those as phantom pages:
 * a five-card manuscript for a four-page ask, watched live on 2026-08-14
 * ("02 Pilot / 03 Quarter / 04 Stage" — tile labels, not pages).
 */
export const parseOutlineCards = (buf: string): { label: string; lede: string }[] => {
  const segments = buf.split(/"id"\s*:\s*"scene_\d+"/).slice(1);
  const out: { label: string; lede: string }[] = [];
  for (const seg of segments) {
    const label = extractStreamStrings(seg, "label")[0] ?? "";
    const lede = extractStreamStrings(seg, "lede")[0] ?? "";
    if (label || lede) out.push({ label, lede });
  }
  return out;
};

/** The blinking caret that marks where the model is, right now. */
function Caret() {
  return (
    <span
      aria-hidden
      className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[2px] bg-accent"
      style={{ animation: "rb-step-pulse 1s ease-in-out infinite" }}
    />
  );
}

/**
 * The outline, typed live (founder, 2026-08-14, from the Gamma comparison:
 * "lets show how we write the steps in the outline — actually typing").
 *
 * This is the model's REAL text arriving over SSE — page titles and ledes
 * pulled from the stream as they are written, not a paced imitation. The
 * thinking silence before the first word is shown as its own phase, and the
 * repair loop is shown as "polishing" rather than re-typing an outline the
 * user already read (re-typing would look like the product un-writing their
 * document).
 *
 * Everything here is ceremony: completion and navigation stay with the poll
 * (pollOutline). If the stream is unavailable — process restart, older job,
 * proxy that buffers SSE — this renders the paced GeneratingSteps instead,
 * which remains the honest floor.
 */
export function OutlineLive({
  scriptId,
  steps,
  elapsed,
  pages,
  leftExtras,
  approval,
}: {
  scriptId: string;
  steps: string[];
  elapsed: number;
  pages: number;
  /** Branch-specific header content for the rail (resume explainer / brief echo). */
  leftExtras?: React.ReactNode;
  /** Set when the outline has settled: the aside becomes the approval beat. */
  approval?: { buildHref: string; reviewUrl: string } | null;
}) {
  const [cards, setCards] = useState<{ label: string; lede: string }[]>([]);
  const [phase, setPhase] = useState<
    "connecting" | "thinking" | "writing" | "polish" | "done" | "unavailable"
  >("connecting");
  /**
   * REVEAL PACING (founder, 2026-08-14: "it stayed loading for quite some
   * time and then rendered all the typing in one pass").
   *
   * Measured on a real 4-page outline: 45.7s of complete silence while GLM
   * thinks, then 10,596 characters in 11.5 seconds — 925 chars/sec, 37x
   * faster than a person reads, with 100% of the text landing in the last
   * 20% of the wait. Piping that straight to the DOM is technically live
   * and experientially a dump after a blank stare.
   *
   * So the raw stream accumulates in bufRef and the DOM reveals a growing
   * PREFIX of it. The words are the model's, in the order it wrote them —
   * only the cadence is ours. The pacer targets a readable rate, catches up
   * when it falls far behind, and finishes immediately once the job is done
   * so ceremony never delays the review.
   */
  const bufRef = useRef("");
  /** The model's live reasoning, last fragment only — the 46s "silent head"
   *  narrated with the model's own words (labor illusion: the wait shows
   *  NAMED REAL work; a static plan or fake ticker measurably does nothing). */
  const [thought, setThought] = useState("");
  const thoughtRef = useRef("");
  /** The scroll well the reasoning streams into; pinned to the bottom below. */
  const thoughtBoxRef = useRef<HTMLDivElement | null>(null);
  const [revealed, setRevealed] = useState(0);
  const revealedRef = useRef(0);
  const doneRef = useRef(false);
  const lastIRef = useRef(-1);
  const errsRef = useRef(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Keep the reasoning well pinned to its newest line as text streams in.
  // Without this the box fills once and then silently stops moving, which is
  // the same "cannot read it" complaint wearing a taller box.
  useEffect(() => {
    const el = thoughtBoxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thought]);

  // The POST settling is the authority that the outline is DONE — the SSE's
  // own done event may still be in flight. Whatever is buffered drains
  // instantly; approval must never wait on ceremony.
  useEffect(() => {
    if (approval) doneRef.current = true;
  }, [approval]);

  useEffect(() => {
    let es: EventSource | null = null;
    let cancelled = false;
    try {
      es = new EventSource(`/api/documents/generate/stream?scriptId=${encodeURIComponent(scriptId)}`);
    } catch {
      setPhase("unavailable");
      return;
    }
    es.onmessage = (m) => {
      if (cancelled) return;
      errsRef.current = 0;
      let ev: { i?: number; kind?: string; data?: string } | null = null;
      try {
        ev = JSON.parse(m.data as string) as { i?: number; kind?: string; data?: string };
      } catch {
        return;
      }
      if (!ev || typeof ev.i !== "number") return;
      if (ev.kind === "note" && ev.data === "unavailable") {
        // Before anything arrived: no stream exists, fall back to paced steps.
        // After text arrived (a reconnect that found the process restarted):
        // keep what was typed and let "polishing" carry the rest of the wait.
        setPhase((p) => (lastIRef.current < 0 ? "unavailable" : p === "done" ? p : "polish"));
        es?.close();
        return;
      }
      // The browser replays from 0 on auto-reconnect (the URL carries no
      // cursor); everything already applied is skipped by index.
      if (ev.i <= lastIRef.current) return;
      lastIRef.current = ev.i;
      if (ev.kind === "think" && typeof ev.data === "string") {
        // Keep a PARAGRAPH, not a line.
        //
        // This kept the last 280 characters and displayed the last 140 of
        // those, clamped to two lines — so the panel showed a sentence
        // fragment that scrolled past faster than it could be read, twice
        // reported as "I can't even read the thinking here". The point of
        // showing the model's reasoning is that someone can follow it.
        //
        // Bounded at 4000 characters because this is a live stream into a
        // React state value: it is enough to read several paragraphs back,
        // and small enough that neither the re-render nor the DOM node grows
        // without limit over a long outline.
        thoughtRef.current = (thoughtRef.current + ev.data).slice(-4000);
        setThought(thoughtRef.current.replace(/[ \t]+/g, " ").trimStart());
        setPhase((p) => (p === "connecting" ? "thinking" : p));
        return;
      }
      if (ev.kind === "delta" && typeof ev.data === "string") {
        bufRef.current += ev.data;
        setPhase((p) => (p === "polish" || p === "done" ? p : "writing"));
      } else if (ev.kind === "note") {
        if (ev.data === "thinking") setPhase((p) => (p === "connecting" ? "thinking" : p));
        else if (ev.data === "polish" || ev.data === "restart") setPhase("polish");
        else if (ev.data === "done") {
          doneRef.current = true;
          setPhase("done");
          es?.close();
        }
      }
    };
    es.onerror = () => {
      if (cancelled) return;
      errsRef.current += 1;
      // Three consecutive failures with nothing ever received = the relay is
      // not reachable (buffering proxy, dead route). With text already shown,
      // stay: the poll still finishes the job.
      if (errsRef.current >= 3 && lastIRef.current < 0) {
        setPhase("unavailable");
        es?.close();
      }
    };
    return () => {
      cancelled = true;
      es?.close();
    };
  }, [scriptId]);

  // The pacer. 24 fps is plenty for text and cheap; the per-tick budget
  // adapts so a big backlog still lands in a bounded time instead of
  // trickling for minutes.
  useEffect(() => {
    const TICK_MS = 42;
    const BASE_CPS = 260; // readable-fast: a fluent reader's skim rate
    const id = setInterval(() => {
      const have = bufRef.current.length;
      const shown = revealedRef.current;
      if (shown >= have) return;
      const behind = have - shown;
      // Catch-up: the further behind, the faster — and once the job is done
      // the remaining text lands in about a second rather than holding the
      // user hostage to a cadence that no longer buys anything.
      const cps = doneRef.current
        ? Math.max(BASE_CPS * 6, behind)
        : BASE_CPS * (behind > 4000 ? 4 : behind > 1500 ? 2 : 1);
      const next = Math.min(have, shown + Math.ceil((cps * TICK_MS) / 1000));
      revealedRef.current = next;
      setRevealed(next);
    }, TICK_MS);
    return () => clearInterval(id);
  }, []);

  // Cards derive from the REVEALED prefix, so a half-typed lede renders as
  // a half-typed lede — the parser already handles truncation mid-token.
  useEffect(() => {
    setCards(parseOutlineCards(bufRef.current.slice(0, revealed)));
  }, [revealed]);

  // Keep the newest typing on screen.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [cards, phase]);

  const mmss = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;
  const headline = approval
    ? "Outline ready — read it, then build"
    : phase === "connecting" || phase === "thinking"
      ? "Reading your brief — deciding what each page must earn"
      : phase === "writing"
        ? "Writing your pages"
        : phase === "polish"
          ? "Polishing — checking every page against your brief"
          : "Outline ready";
  const lastIdx = cards.length - 1;

  // STAGE LAYOUT (founder, 2026-08-14): the waiting panel sits LEFT, and the
  // outline is written FULL SCALE on the stage where the editor canvas
  // normally lives — the blank slide behind may be covered; the writing IS
  // the work. When no stream exists, the rail carries the honest paced steps
  // and the stage waits quietly.
  return (
    <div className="pointer-events-none absolute inset-0 z-30 flex flex-col gap-5 overflow-y-auto bg-[rgba(238,240,243,0.78)] p-5 backdrop-blur-[2px] lg:flex-row lg:overflow-hidden">
      <aside className="pointer-events-auto flex w-full shrink-0 flex-col rounded-xl border border-hairline bg-surface p-6 shadow-[0_30px_80px_-40px_rgba(18,26,43,0.45)] lg:max-h-full lg:w-[400px] lg:overflow-y-auto">
        {leftExtras}
        {phase === "unavailable" && !approval ? (
          // Stream never connected — honest paced steps. But if the outline
          // SETTLED anyway (the POST is the authority), the approval beat
          // below must win: a broken ceremony must never hide the Build CTA.
          <GeneratingSteps steps={steps} elapsed={elapsed} pages={pages} />
        ) : (
          <div className="mt-4 rounded-lg border border-hairline bg-surface-2 p-4">
            <div className="flex items-center gap-2.5">
              {phase === "done" ? (
                <span aria-hidden className="text-accent">
                  <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none">
                    <path d="M2.5 6.2l2.3 2.3 4.7-4.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
              ) : (
                <span
                  aria-hidden
                  className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                  style={{ animation: "rb-step-pulse 1.4s ease-in-out infinite" }}
                />
              )}
              <span className="text-[12.5px] leading-relaxed text-ink">{headline}</span>
            </div>
            {!approval && (phase === "thinking" || phase === "connecting") && thought && (
              // The model's own words, live. A fixed-height well that sticks to
              // the newest line: tall enough to actually read a paragraph, and
              // fixed so the panel does not grow and shove the controls around
              // while text streams in. Quiet mono, per DESIGN.md — the user's
              // work is the loudest thing, and this is the machine muttering.
              <div
                ref={thoughtBoxRef}
                className="mt-2 max-h-[190px] overflow-y-auto border-t border-hairline pt-2"
              >
                <p className="whitespace-pre-wrap font-mono text-[10.5px] leading-relaxed text-muted">
                  {thought}
                </p>
              </div>
            )}
            {approval ? (
              <div className="mt-3 border-t border-hairline pt-3">
                <a
                  href={approval.buildHref}
                  data-rb-outline-build
                  className="block w-full rounded-full bg-accent px-4 py-2.5 text-center text-[13.5px] font-semibold text-accent-ink transition-all hover:brightness-110"
                >
                  Build the deck →
                </a>
                <a
                  href={approval.reviewUrl}
                  data-rb-outline-refine
                  className="mt-2 block w-full rounded-md border border-hairline px-4 py-2 text-center text-[12px] text-muted transition-colors hover:text-ink"
                >
                  Refine page by page
                </a>
              </div>
            ) : (
              <div className="mt-3 flex items-baseline justify-between gap-3 border-t border-hairline pt-2.5">
                <span className="font-mono text-[11px] tabular-nums text-muted">{mmss}</span>
                <span className="text-[11px] leading-relaxed text-faint">
                  {pages > 0 && cards.length >= pages && phase === "polish"
                    ? "All pages drafted — tightening them now."
                    : "You can close this tab; it finishes on its own."}
                </span>
              </div>
            )}
          </div>
        )}
        <p className="mt-auto pt-5 text-center font-mono text-[10.5px] text-faint">
          {approval
            ? "The build follows this outline, page for page."
            : "You approve the outline before anything is designed."}
        </p>
      </aside>

      <section
        ref={listRef}
        data-rb-outline-stage
        className="pointer-events-auto min-w-0 flex-1 rounded-xl border border-hairline bg-surface p-6 shadow-[0_30px_80px_-40px_rgba(18,26,43,0.45)] lg:max-h-full lg:overflow-y-auto"
      >
        {cards.length > 0 ? (
          <div className="flex flex-col gap-3">
            {cards.map((c, i) => {
              const isLast = i === lastIdx;
              const typingLede = isLast && phase === "writing" && c.lede.length > 0;
              const typingLabel = isLast && phase === "writing" && c.lede.length === 0;
              return (
                <div
                  key={i}
                  data-rb-outline-card={i}
                  className="rounded-lg border border-hairline bg-surface-2 px-5 py-4"
                  style={{ animation: "rb-fade-up 280ms ease-out backwards" }}
                >
                  <div className="flex items-baseline gap-3">
                    <span className="font-mono text-[11px] tabular-nums text-faint">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <span className="font-display text-[clamp(17px,1.8vw,24px)] font-bold tracking-tight text-ink">
                      {c.label}
                      {typingLabel && <Caret />}
                    </span>
                  </div>
                  {c.lede.length > 0 && (
                    <p className="mt-1.5 pl-8 text-[14px] leading-relaxed text-muted">
                      {c.lede}
                      {typingLede && <Caret />}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          // THE SILENT HEAD. Measured: 45.7 seconds pass before the model
          // emits its first character (it is thinking, and thinking is
          // silent). An empty stage for 46s reads as broken, so the pages
          // the user ASKED for stand up immediately as waiting slots —
          // honest (we know the count; we do not know the words yet) and it
          // makes the first real label land INTO a place rather than onto a
          // void.
          <div className="flex flex-col gap-3">
            {Array.from({ length: Math.max(1, Math.min(pages, 12)) }, (_, i) => (
              <div
                key={i}
                className="rounded-lg border border-dashed border-hairline bg-surface-2/40 px-5 py-4"
                style={{ animation: "rb-fade-up 280ms ease-out backwards", animationDelay: `${i * 70}ms` }}
              >
                <div className="flex items-baseline gap-3">
                  <span className="font-mono text-[11px] tabular-nums text-faint">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span
                    className="h-[15px] rounded bg-hairline"
                    style={{
                      width: `${38 + ((i * 17) % 34)}%`,
                      animation: "rb-step-pulse 1.8s ease-in-out infinite",
                      animationDelay: `${i * 140}ms`,
                    }}
                  />
                </div>
                <div className="mt-2.5 flex flex-col gap-1.5 pl-8">
                  <span className="h-[9px] w-[92%] rounded bg-hairline/70" />
                  <span className="h-[9px] w-[64%] rounded bg-hairline/70" />
                </div>
              </div>
            ))}
            <p className="mt-1 text-center text-[12px] leading-relaxed text-faint">
              {phase === "unavailable"
                ? "The outline is being written on our side — the steps on the left track it."
                : "Reading your brief and deciding what each page must earn. The words appear here as they are written."}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * The steps, rendered. See generatingSteps above for why they are paced and
 * what is actually true on this screen.
 *
 * Pacing: a 3-page outline has measured ~29s and a 12-page one ~114s, so the
 * estimate scales with the page count. Steps advance through the estimate and
 * then STOP — the final one keeps breathing for as long as it takes, and past
 * a generous multiple of the estimate the copy says so out loud rather than
 * pretending the pace was right.
 */
export function GeneratingSteps({
  steps,
  elapsed,
  pages,
}: {
  steps: string[];
  elapsed: number;
  pages: number;
}) {
  const estimate = 25 + pages * 6;
  const perStep = estimate / steps.length;
  // Never past the last index: the final step is where the wait lives.
  const active = Math.min(Math.floor(elapsed / perStep), steps.length - 1);
  const slow = elapsed > estimate * 2;
  const mmss = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;

  return (
    <div className="mt-4 rounded-lg border border-hairline bg-surface-2 p-4">
      <ul className="flex flex-col gap-2">
        {steps.map((label, i) => {
          const done = i < active;
          const now = i === active;
          return (
            <li
              key={label}
              className="flex items-center gap-2.5"
              // `backwards`, NOT `both` — and this is a correctness fix, not a
              // preference. A CSS animation whose document timeline is paused
              // sits inside its active phase indefinitely, applying the `from`
              // keyframe (opacity: 0) forever: playState reads "running" while
              // currentTime never leaves 0. A backgrounded tab is enough to do
              // it, and this panel's own copy invites exactly that ("You can
              // close this tab"). `backwards` still holds the pre-delay state
              // for the stagger, but once the run finishes the element returns
              // to its own opacity: 1 rather than whatever the keyframe said.
              // Measured on a replica of this component: four rows, "running",
              // currentTime 0, computed opacity 0 — an empty panel with a
              // ticking clock under it. Nothing a person must read may depend
              // on motion having run.
              style={{ animation: `rb-fade-up 320ms ease-out backwards`, animationDelay: `${i * 60}ms` }}
            >
              {/* Three states must be readable at a glance, and colour alone
                  cannot carry it: done and active were both solid accent, so
                  the list showed no progress at all. Done is a check, active
                  is the pulsing dot, pending is a hollow ring. */}
              <span
                aria-hidden
                className={`rb-step-dot inline-flex h-3 w-3 shrink-0 items-center justify-center rounded-full ${
                  done
                    ? "text-accent"
                    : now
                      ? "bg-accent"
                      : "border border-hairline-strong"
                }`}
                style={
                  now
                    ? { animation: "rb-step-pulse 1.4s ease-in-out infinite", height: 6, width: 6 }
                    : !done
                      ? { height: 6, width: 6 }
                      : undefined
                }
              >
                {done && (
                  <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" aria-hidden>
                    <path
                      d="M2.5 6.2l2.3 2.3 4.7-4.7"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </span>
              <span
                className={`text-[12.5px] leading-relaxed ${
                  done ? "text-muted" : now ? "text-ink" : "text-faint"
                }`}
              >
                {label}
              </span>
              {now && (
                <span className="relative ml-1 h-px flex-1 overflow-hidden bg-hairline" aria-hidden>
                  <span
                    className="rb-step-sweep absolute inset-y-0 left-0 w-1/3 bg-accent/60"
                    style={{ animation: "rb-step-sweep 1.6s ease-in-out infinite" }}
                  />
                </span>
              )}
            </li>
          );
        })}
      </ul>

      <div className="mt-3 flex items-baseline justify-between gap-3 border-t border-hairline pt-2.5">
        {/* The one number on this screen that is measured rather than paced. */}
        <span className="font-mono text-[11px] tabular-nums text-muted">{mmss}</span>
        <span className="text-[11px] leading-relaxed text-faint">
          {slow
            ? "Taking longer than usual — still working."
            : "You can close this tab; it finishes on its own."}
        </span>
      </div>
    </div>
  );
}
