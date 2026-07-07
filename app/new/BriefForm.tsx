"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { cn } from "../../lib/cn";
import { submitBrief, crawlWebsite } from "./actions";
import type {
  BrandExtract,
  DistributionFormat,
  MomentInput,
} from "./schema";
import {
  DISTRIBUTION_FORMATS,
  maxMomentsForDuration,
  SECONDS_PER_MOMENT_FLOOR,
} from "./schema";
import { AnalyzePanel, computeAnalyzeSteps, type AnalyzeStep } from "./AnalyzePanel";

/**
 * Brief front door (fluid v1).
 *
 * One screen: a freeform prompt, your site URL, and smart-defaulted
 * format + duration, with optional brand colors and verified claims
 * behind an "advanced" disclosure. Submitting runs a single Agent 1
 * call that produces the full Script JSON, then redirects to
 * /review/[id] — the single review surface.
 *
 * Per DESIGN.md: story-first, config is refinement not a gate.
 */

// 60s cap for now — longer renders blow up Opus-per-Pass cost AND the
// dead-air rules get harder to satisfy at >1min lengths. Revisit once
// quality is locked.
const DURATION_CHIPS = [15, 30, 45, 60];
const PURPOSE_EXAMPLES = [
  "Launch video for our new analytics product",
  "TikTok story for our Black Friday sale",
  "Investor update for our Series B announcement",
  "Cold sales outreach to a marketing VP",
];

const newMoment = (): MomentInput => ({
  title: "",
  description: "",
  creativity: "balanced",
});

export function BriefForm({
  initialPrompt = "",
  initialUrl = "",
}: {
  initialPrompt?: string;
  initialUrl?: string;
} = {}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  // ─── Inputs ──────────────────────────────────────────────────────
  // initialPrompt / initialUrl carry a prompt typed on the landing hero
  // through sign-in into the front door.
  const [introPrompt, setIntroPrompt] = useState(initialPrompt);
  const [brandFiles] = useState<File[]>([]);
  const [brandKitUrl, setBrandKitUrl] = useState(initialUrl);
  /**
   * Brand kit (approved gate, 2026-07-07): the logo is REQUIRED — either an
   * upload here or a one-click confirmation of the crawled mark. The scanned
   * palette must be confirmed (editable first). Font upload is optional and
   * carries a license attestation. Identity is locked by the user, never
   * silently guessed from the crawl.
   */
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [crawledLogoAccepted, setCrawledLogoAccepted] = useState(false);
  const [fontFile, setFontFile] = useState<File | null>(null);
  const [fontLicensed, setFontLicensed] = useState(false);
  const [colorsConfirmed, setColorsConfirmed] = useState(false);
  const [verifiedClaims, setVerifiedClaims] = useState("");
  const [paletteRoles, setPaletteRoles] = useState<{
    primary?: string;
    accent?: string;
    light?: string;
    dark?: string;
  }>({});
  const [distributionFormat, setDistributionFormat] =
    useState<DistributionFormat>("landscape");
  const [duration, setDuration] = useState(30);
  const [momentCount, setMomentCount] = useState(4);
  const [moments, setMoments] = useState<MomentInput[]>([]);
  const [cta] = useState("");

  // ─── Background crawl ────────────────────────────────────────────
  const [brandExtract, setBrandExtract] = useState<BrandExtract | null>(null);
  const crawledUrlRef = useRef<string | null>(null);
  const crawlInflightRef = useRef<Promise<BrandExtract> | null>(null);

  // ─── Generation phase ────────────────────────────────────────────
  const [generating, setGenerating] = useState(false);
  const [analyzeSteps, setAnalyzeSteps] = useState<AnalyzeStep[]>([]);
  const [agentDone, setAgentDone] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);
  const generatedBriefIdRef = useRef<string | null>(null);

  useEffect(() => {
    setMoments((cur) => {
      const next = cur.slice(0, momentCount);
      while (next.length < momentCount) next.push(newMoment());
      return next;
    });
  }, [momentCount]);

  useEffect(() => {
    const cap = maxMomentsForDuration(duration);
    if (momentCount > cap) setMomentCount(cap);
  }, [duration, momentCount]);

  // ─── Crawl trigger ───────────────────────────────────────────────
  const ensureCrawl = (): Promise<BrandExtract> | null => {
    const url = brandKitUrl.trim();
    if (!url) return null;
    if (crawledUrlRef.current === url && brandExtract) {
      return Promise.resolve(brandExtract);
    }
    if (crawlInflightRef.current && crawledUrlRef.current === url) {
      return crawlInflightRef.current;
    }
    crawledUrlRef.current = url;
    const p = crawlWebsite(url).then((extract) => {
      setBrandExtract(extract);
      return extract;
    });
    crawlInflightRef.current = p;
    return p;
  };

  // ─── Generation ──────────────────────────────────────────────────
  const startGeneration = async (modeChoice: "auto" | "manual") => {
    const steps = computeAnalyzeSteps({
      hasWebsite: brandKitUrl.trim().length > 0,
      fileCount: brandFiles.length,
    });
    setAnalyzeSteps(steps);
    setAgentDone(false);
    setAgentError(null);
    setGenerating(true);

    const crawlPromise = ensureCrawl();
    const extract = crawlPromise ? await crawlPromise : null;

    const fd = new FormData();
    if (modeChoice === "auto") {
      fd.append(
        "brief",
        JSON.stringify({
          duration_seconds: duration,
          distribution_format: distributionFormat,
          moment_count: momentCount,
          freeform_prompt: introPrompt,
          brand_kit_url: brandKitUrl.trim() || undefined,
          verified_claims: verifiedClaims.trim() || undefined,
          palette_roles:
            Object.keys(paletteRoles).length > 0 ? paletteRoles : undefined,
        }),
      );
    } else {
      fd.append(
        "brief",
        JSON.stringify({
          duration_seconds: duration,
          distribution_format: distributionFormat,
          purpose: introPrompt.trim() || undefined,
          moments: moments.map((m) => ({
            title: m.title.trim(),
            description: m.description.trim(),
            creativity: m.creativity,
          })),
          cta: cta.trim(),
          brand_kit_url: brandKitUrl.trim() || undefined,
          verified_claims: verifiedClaims.trim() || undefined,
          palette_roles:
            Object.keys(paletteRoles).length > 0 ? paletteRoles : undefined,
        }),
      );
    }
    if (extract) fd.append("brand_extract", JSON.stringify(extract));
    brandFiles.forEach((f, i) => fd.append(`file_${i}`, f));
    if (logoFile) fd.append("file_logo", logoFile);
    // Brand-kit gate fields — mirrored server-side in submitBrief.
    if (logoFile) fd.append("logo_source", "upload");
    else if (crawledLogoAccepted) fd.append("logo_source", "crawl_confirmed");
    if (colorsConfirmed) fd.append("colors_confirmed", "1");
    if (fontFile) {
      fd.append("file_font", fontFile);
      if (fontLicensed) fd.append("font_licensed", "1");
    }

    const result = await submitBrief(fd);
    if (!result.ok) {
      setAgentError(result.error);
      setAgentDone(true);
      return;
    }
    generatedBriefIdRef.current = result.brief_id;
    setAgentDone(true);
  };

  // ─── Brand-kit gate state (mirrors lib/brand-kit.ts server predicate) ────
  const crawledLogo = brandExtract?.ok ? brandExtract.logo_hd : undefined;
  const logoLocked = !!logoFile || (crawledLogoAccepted && !!crawledLogo);
  const hasScannedPalette = !!brandExtract?.ok && (brandExtract.palette?.length ?? 0) > 0;
  const colorsSatisfied = !hasScannedPalette || colorsConfirmed;

  const handleAutoGenerate = () => {
    if (!introPrompt.trim()) {
      setError("Write what video you want before generating.");
      return;
    }
    if (!logoLocked) {
      setError(
        crawledLogo
          ? "Lock in your logo — upload one, or confirm the logo we found on your site."
          : "Upload your logo (SVG or PNG) — it's required so the video is unmistakably yours.",
      );
      return;
    }
    if (!colorsSatisfied) {
      setError("Confirm your brand colors — check the scanned palette below (edit if needed), then confirm.");
      return;
    }
    if (fontFile && !fontLicensed) {
      setError("Confirm you hold the license for the uploaded font (or remove it to use the scanned fonts).");
      return;
    }
    const cap = maxMomentsForDuration(duration);
    if (momentCount > cap) {
      setError(
        `At ${duration}s, the most you can have is ${cap} moments (${SECONDS_PER_MOMENT_FLOOR}s/moment floor).`,
      );
      return;
    }
    setError(null);
    void startGeneration("auto");
  };

  const handleGenerationComplete = () => {
    setGenerating(false);
    if (agentError) {
      setError(agentError);
      return;
    }
    const id = generatedBriefIdRef.current;
    if (id) router.push(`/review/${id}`);
  };

  // ─── Render ──────────────────────────────────────────────────────

  if (generating) {
    return (
      <div className="flex min-h-[80vh] flex-col items-center justify-center px-6 py-16">
        <div className="glass w-full max-w-[640px] rounded-lg p-8">
          <AnalyzePanel
            steps={analyzeSteps}
            isAgentDone={agentDone}
            agentError={agentError}
            onDone={handleGenerationComplete}
          />
        </div>
      </div>
    );
  }

  // ─── Front door (fluid v1) ───────────────────────────────────────
  // One screen: a prompt, your site, smart-defaulted format/length.
  // Everything else (colors, claims) is optional and crawl-defaulted.
  // Per DESIGN.md: story-first, config is refinement not a gate.
  return (
    <div className="flex min-h-[80vh] flex-col items-center justify-center px-6 py-16">
      <div className="w-full max-w-[640px]">
        <div className="orb orb-spin mx-auto mb-7 h-16 w-16" aria-hidden />
        <h1 className="mb-9 text-center font-display text-[clamp(32px,6vw,46px)] font-semibold leading-[1.04] tracking-tight text-ink">
          Render your business{" "}
          <span className="text-accent-text">story</span>.
        </h1>

        {/* Prompt card — frosted glass floating on the emerald field */}
        <div className="glass rounded-md p-4 transition-colors focus-within:border-accent-line">
          <textarea
            autoFocus
            value={introPrompt}
            onChange={(e) => setIntroPrompt(e.target.value)}
            rows={5}
            placeholder="A 30-second launch video for [brand] — what it does, who it's for, and the one thing someone should remember. Tone, too."
            className="w-full resize-none bg-transparent text-[16.5px] leading-relaxed text-ink placeholder:text-muted focus:outline-none"
          />
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-hairline pt-3">
            <div className="flex min-w-[180px] flex-1 items-center gap-2">
              <span className="text-muted">◴</span>
              <input
                type="url"
                value={brandKitUrl}
                onChange={(e) => {
                  setBrandKitUrl(e.target.value);
                  if (crawledUrlRef.current !== e.target.value.trim()) {
                    setBrandExtract(null);
                    // New site = new identity: prior confirmations don't carry.
                    setCrawledLogoAccepted(false);
                    setColorsConfirmed(false);
                  }
                }}
                onBlur={() => {
                  if (brandKitUrl.trim()) ensureCrawl();
                }}
                placeholder="yoursite.com — so it looks like you"
                className="w-full bg-transparent font-mono text-[13px] text-ink-soft placeholder:text-muted focus:outline-none"
              />
            </div>
            <div className="flex items-center gap-1">
              {DURATION_CHIPS.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDuration(d)}
                  className={cn(
                    "rounded-full px-2.5 py-1 font-mono text-[11px] transition-colors",
                    duration === d
                      ? "border border-accent-line bg-accent-soft text-ink"
                      : "border border-hairline-strong text-muted hover:text-ink",
                  )}
                >
                  {d}s
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Crawl status */}
        <div className="mt-3 min-h-[20px] font-mono text-[12.5px]">
          {brandExtract?.ok && (
            <span className="inline-flex items-center gap-2 text-accent-text">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />
              brand loaded from {brandExtract.url}
            </span>
          )}
          {brandExtract && !brandExtract.ok && (
            <span className="text-muted">
              couldn&apos;t read that site — the agent will work from your prompt
            </span>
          )}
        </div>

        {/* Brand kit — identity is LOCKED BY THE USER before anything renders.
            Approved deviation from "config is never a gate" (2026-07-07):
            logo required, colors confirm-from-scan, font optional. */}
        <div className="glass mt-4 rounded-md p-4">
          <div className="mb-4 flex items-baseline justify-between">
            <span className="text-[13.5px] font-medium text-ink">Brand kit</span>
            <span className="font-mono text-[11px] text-muted">
              locked by you — never guessed
            </span>
          </div>

          {/* Logo — required */}
          <div className="mb-5">
            <div className="mb-2 flex items-center gap-2 text-[13px] text-ink-soft">
              Logo
              <span
                className={cn(
                  "rounded-full border px-1.5 py-0.5 font-mono text-[10px]",
                  logoLocked
                    ? "border-accent-line bg-accent-soft text-accent-text"
                    : "border-hairline-strong text-muted",
                )}
              >
                {logoLocked ? "✓ locked" : "required"}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {(logoPreview || crawledLogo) && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={logoPreview ?? crawledLogo}
                  alt="brand logo"
                  className={cn(
                    "h-10 max-w-[140px] rounded-md border bg-surface-2 object-contain px-2 py-1",
                    logoLocked ? "border-accent-line" : "border-hairline opacity-75",
                  )}
                />
              )}
              <label className="cursor-pointer rounded-md border border-hairline-strong px-3 py-1.5 text-[12.5px] text-ink-soft transition-colors hover:border-accent-line hover:text-ink">
                {logoFile ? logoFile.name : "Upload logo (SVG / PNG)"}
                <input
                  type="file"
                  accept=".svg,.png,image/svg+xml,image/png"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0] ?? null;
                    setLogoFile(f);
                    setCrawledLogoAccepted(false);
                    setLogoPreview((prev) => {
                      if (prev) URL.revokeObjectURL(prev);
                      return f ? URL.createObjectURL(f) : null;
                    });
                  }}
                />
              </label>
              {!logoFile && crawledLogo && (
                <button
                  type="button"
                  onClick={() => setCrawledLogoAccepted((v) => !v)}
                  className={cn(
                    "rounded-md border px-3 py-1.5 text-[12.5px] transition-colors",
                    crawledLogoAccepted
                      ? "border-accent-line bg-accent-soft text-ink"
                      : "border-hairline-strong text-ink-soft hover:border-accent-line hover:text-ink",
                  )}
                >
                  {crawledLogoAccepted ? "✓ Using the logo from your site" : "Use the logo from your site"}
                </button>
              )}
            </div>
            {!crawledLogo && !logoFile && (
              <p className="mt-2 font-mono text-[11.5px] text-muted">
                {brandKitUrl.trim()
                  ? "no usable logo found on your site — upload yours"
                  : "add your site above to scan for a logo, or upload one"}
              </p>
            )}
          </div>

          {/* Colors — scanned palette, confirm or edit */}
          <div className="mb-5">
            <div className="mb-2 flex items-center gap-2 text-[13px] text-ink-soft">
              Colors
              <span
                className={cn(
                  "rounded-full border px-1.5 py-0.5 font-mono text-[10px]",
                  colorsSatisfied
                    ? "border-accent-line bg-accent-soft text-accent-text"
                    : "border-hairline-strong text-muted",
                )}
              >
                {hasScannedPalette ? (colorsConfirmed ? "✓ confirmed" : "confirm the scan") : "from your site"}
              </span>
            </div>
            {hasScannedPalette ? (
              <>
                <StepColors
                  palette={brandExtract?.palette ?? []}
                  themeColor={brandExtract?.theme_color}
                  value={paletteRoles}
                  onChange={(v) => {
                    setPaletteRoles(v);
                    // Any edit re-opens the confirmation — the user signs off
                    // on exactly what will render.
                    setColorsConfirmed(false);
                  }}
                />
                <button
                  type="button"
                  onClick={() => setColorsConfirmed((v) => !v)}
                  className={cn(
                    "mt-3 rounded-md border px-3 py-1.5 text-[12.5px] transition-colors",
                    colorsConfirmed
                      ? "border-accent-line bg-accent-soft text-ink"
                      : "border-hairline-strong text-ink-soft hover:border-accent-line hover:text-ink",
                  )}
                >
                  {colorsConfirmed ? "✓ Colors confirmed" : "These are my brand colors →"}
                </button>
              </>
            ) : (
              <p className="font-mono text-[11.5px] text-muted">
                {brandKitUrl.trim()
                  ? "scanning your site for colors…"
                  : "add your site above and we'll scan your palette for you to confirm"}
              </p>
            )}
          </div>

          {/* Font — optional upload with license attestation */}
          <div>
            <div className="mb-2 flex items-center gap-2 text-[13px] text-ink-soft">
              Font
              <span className="rounded-full border border-hairline-strong px-1.5 py-0.5 font-mono text-[10px] text-muted">
                optional
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <label className="cursor-pointer rounded-md border border-hairline-strong px-3 py-1.5 text-[12.5px] text-ink-soft transition-colors hover:border-accent-line hover:text-ink">
                {fontFile ? fontFile.name : "Upload font (woff2 / ttf / otf)"}
                <input
                  type="file"
                  accept=".woff2,.woff,.ttf,.otf"
                  className="hidden"
                  onChange={(e) => {
                    setFontFile(e.target.files?.[0] ?? null);
                    setFontLicensed(false);
                  }}
                />
              </label>
              {fontFile && (
                <>
                  <label className="flex cursor-pointer items-center gap-2 text-[12px] text-ink-soft">
                    <input
                      type="checkbox"
                      checked={fontLicensed}
                      onChange={(e) => setFontLicensed(e.target.checked)}
                      className="accent-[var(--accent,#00c28a)]"
                    />
                    I hold the license for this font
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      setFontFile(null);
                      setFontLicensed(false);
                    }}
                    className="font-mono text-[11.5px] text-muted hover:text-ink"
                  >
                    remove
                  </button>
                </>
              )}
              {!fontFile && (
                <span className="font-mono text-[11.5px] text-muted">
                  otherwise we use the fonts found on your site
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Format — visual screen-ratio picker */}
        <FormatPicker
          value={distributionFormat}
          onChange={setDistributionFormat}
        />

        {/* Example prompts */}
        <div className="mt-2 flex flex-wrap gap-2">
          {PURPOSE_EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => setIntroPrompt(ex)}
              className="rounded-md border border-hairline-strong bg-accent-soft px-2.5 py-1 text-[12px] text-ink-soft backdrop-blur-md transition-colors hover:border-accent-line hover:text-ink"
            >
              {ex}
            </button>
          ))}
        </div>

        {/* Advanced: verified claims (optional). Colors moved up into the
            Brand kit — they're confirm-gated now, not buried refinement. */}
        <details className="group mt-6 glass rounded-md">
          <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-[13px] text-ink-soft hover:text-ink">
            <span>
              Verified claims{" "}
              <span className="text-muted">(optional — real stats the agent may quote)</span>
            </span>
            <span className="text-faint transition-transform group-open:rotate-180">⌄</span>
          </summary>
          <div className="border-t border-hairline px-4 py-5">
            <textarea
              id="vc"
              value={verifiedClaims}
              onChange={(e) => setVerifiedClaims(e.target.value)}
              rows={3}
              placeholder={"$25M Series B\n100+ financial institutions\nLive in 90 days"}
              className="w-full resize-y rounded-md border border-hairline bg-surface-2 px-3 py-2 font-mono text-[13px] text-ink placeholder:text-muted focus:border-accent-line focus:outline-none"
            />
          </div>
        </details>

        {error && <p className="mt-4 font-mono text-[13px] text-red-500">{error}</p>}

        <button
          type="button"
          onClick={handleAutoGenerate}
          className="mt-7 w-full rounded-md bg-accent px-6 py-3.5 text-[15px] font-semibold text-accent-ink shadow-[0_14px_32px_-12px_rgba(0,194,138,0.55)] transition-all hover:brightness-110"
        >
          See the story →
        </button>
        <p className="mt-3 text-center text-[12px] text-muted">
          We&apos;ll draft a story you can shape before anything renders.
        </p>
      </div>
    </div>
  );
}

// ─── Format picker (visual screen-ratio shapes) ──────────────────────

// Each format's little "screen" drawn at its true aspect ratio, fit into
// a ~44px box so the proportions read at a glance (tall / square / wide).
const FORMAT_SHAPE: Record<"9:16" | "1:1" | "16:9", { w: number; h: number }> =
  {
    "9:16": { w: 25, h: 44 },
    "1:1": { w: 40, h: 40 },
    "16:9": { w: 44, h: 25 },
  };

function FormatPicker({
  value,
  onChange,
}: {
  value: DistributionFormat;
  onChange: (f: DistributionFormat) => void;
}) {
  return (
    <div className="mt-4">
      <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
        Format
      </div>
      <div className="flex gap-2">
        {DISTRIBUTION_FORMATS.map((f) => {
          const active = value === f.value;
          const dims = FORMAT_SHAPE[f.aspect];
          return (
            <button
              key={f.value}
              type="button"
              onClick={() => onChange(f.value)}
              title={`${f.label} — ${f.examples}`}
              aria-pressed={active}
              className={cn(
                "group flex flex-1 flex-col items-center gap-2 rounded-md border px-3 py-3 transition-all",
                active
                  ? "border-accent-line bg-accent-soft"
                  : "border-hairline-strong bg-white/40 hover:bg-white/60",
              )}
            >
              <div className="flex h-12 items-center justify-center">
                <div
                  style={{ width: dims.w, height: dims.h }}
                  className={cn(
                    "rounded-[4px] border-2 transition-colors",
                    active
                      ? "border-accent bg-accent"
                      : "border-faint bg-white/70 group-hover:border-muted",
                  )}
                />
              </div>
              <div className="text-center leading-tight">
                <div
                  className={cn(
                    "font-mono text-[12px]",
                    active ? "text-accent-text" : "text-ink-soft",
                  )}
                >
                  {f.aspect}
                </div>
                <div
                  className={cn(
                    "mt-0.5 text-[11px]",
                    active ? "text-ink" : "text-muted",
                  )}
                >
                  {f.label}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Shared ──────────────────────────────────────────────────────────

function QuestionHeader({
  question,
  hint,
}: {
  question: string;
  hint?: string;
}) {
  return (
    <div className="mb-6">
      <h2 className="text-3xl font-semibold tracking-tight text-ink mb-2">
        {question}
      </h2>
      {hint && <p className="text-sm text-ink-soft leading-relaxed">{hint}</p>}
    </div>
  );
}

// ─── Step: Colors (palette role picker) ──────────────────────────────

/**
 * Optional wizard step. Shows the 8 swatches from the crawled palette
 * and lets the user assign roles: primary (section background), accent
 * (highlight color used for italic emphasis + accent bars), light
 * (text on dark backgrounds), dark (text on light backgrounds).
 *
 * Why this exists: extractPalette() returns colors frequency-ranked
 * from CSS — link/button colors dominate, and the actual section
 * background (often a near-black navy) ranks low or comes from gradient
 * stops the regex doesn't capture. The agent's auto-pick of "primary"
 * picked Fuse's link-blue #0050bd as the section bg, which produced
 * a saturated blue background that didn't match the brand.
 */
function StepColors({
  palette,
  themeColor,
  value,
  onChange,
}: {
  palette: string[];
  themeColor?: string;
  value: { primary?: string; accent?: string; light?: string; dark?: string };
  onChange: (
    next: { primary?: string; accent?: string; light?: string; dark?: string },
  ) => void;
}) {
  // Tracks which slot is "active" — clicking a swatch fills the active
  // slot. The interaction model is: pick a slot, then pick a color.
  // If no slot is active yet, the first click on a swatch activates the
  // first unfilled slot. This means a user who just rapidly clicks
  // through colors still makes forward progress.
  const [activeSlot, setActiveSlot] = useState<
    "primary" | "accent" | "light" | "dark" | null
  >(null);

  const swatches = useMemo(() => {
    const seen = new Set(palette.map((c) => c.toLowerCase()));
    const out: string[] = [];
    if (themeColor && !seen.has(themeColor.toLowerCase())) out.push(themeColor);
    out.push(...palette);
    return out.slice(0, 12);
  }, [palette, themeColor]);

  // Each slot uses plain-English labels — never P/A/L/D jargon, never
  // "primary/accent" designer terms. The schema keys stay internal.
  const slots: Array<{
    key: keyof typeof value;
    label: string;
    hint: string;
  }> = [
    {
      key: "primary",
      label: "Background",
      hint: "The main color behind sections",
    },
    {
      key: "accent",
      label: "Highlights",
      hint: "For accent bars, badges, italic emphasis",
    },
    {
      key: "light",
      label: "Text on the background",
      hint: "Headlines + body when the background is showing",
    },
    {
      key: "dark",
      label: "Text on white cards",
      hint: "When a card or KPI tile has a light background",
    },
  ];

  const assignToSlot = (slot: keyof typeof value, hex: string) => {
    const next = { ...value };
    // Clear this hex from any other slot so a color holds at most one
    // role. Otherwise the preview would show the same color in 2 places
    // and confuse the user.
    for (const k of Object.keys(next) as Array<keyof typeof value>) {
      if (next[k] === hex) delete next[k];
    }
    next[slot] = hex;
    onChange(next);
  };

  const clearSlot = (slot: keyof typeof value) => {
    const next = { ...value };
    delete next[slot];
    onChange(next);
  };

  const handleSwatchClick = (hex: string) => {
    // If the active slot already has this exact color, treat as toggle-off.
    if (activeSlot && value[activeSlot] === hex) {
      clearSlot(activeSlot);
      return;
    }
    // Default to the first unfilled slot if nothing is active.
    const target =
      activeSlot ??
      slots.find((s) => !value[s.key])?.key ??
      slots[0].key;
    assignToSlot(target, hex);
    // Advance to the next unfilled slot to keep the click rhythm going.
    const nextUnfilled = slots
      .map((s) => s.key)
      .find((k) => k !== target && !value[k]);
    setActiveSlot(nextUnfilled ?? null);
  };

  if (swatches.length === 0) {
    return (
      <div>
        <QuestionHeader
          question="Pick your brand colors"
          hint="We couldn't crawl a palette from your site — skip this and the agent will choose sensible defaults."
        />
        <div className="text-sm text-ink-soft">
          No palette available. Continue to use Renderball defaults (deep
          gray + cyan accent).
        </div>
      </div>
    );
  }

  const anyAssigned = Object.keys(value).length > 0;
  const resetAll = () => {
    onChange({});
    setActiveSlot(null);
  };

  return (
    <div>
      <QuestionHeader
        question="Pick your brand colors"
        hint="Optional — pick a role on the left, then click a color from your brand palette below. Skip to let the agent choose for you."
      />

      {/* ── Live preview ────────────────────────────────────────── */}
      <div className="mb-6">
        <div className="text-xs uppercase tracking-widest text-muted mb-2">
          Preview
        </div>
        <ColorPreview value={value} />
      </div>

      {/* ── Two-column: slots on the left, palette on the right ── */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_1fr] gap-6">
        {/* Slot column */}
        <div>
          <div className="text-xs uppercase tracking-widest text-muted mb-3">
            1. Pick a role
          </div>
          <div className="flex flex-col gap-2">
            {slots.map(({ key, label, hint }) => {
              const assignedHex = value[key];
              const isActive = activeSlot === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() =>
                    setActiveSlot(isActive ? null : key)
                  }
                  className={cn(
                    "flex items-center gap-3 p-3 rounded-lg ring-1 text-left transition-all",
                    isActive
                      ? "ring-2 ring-ink bg-surface"
                      : assignedHex
                        ? "ring-[var(--hairline-strong)] bg-surface hover:ring-faint"
                        : "ring-[var(--hairline)] bg-surface hover:ring-[var(--hairline-strong)]",
                  )}
                >
                  {/* Color chip — actual swatch or "auto" placeholder */}
                  <div
                    className={cn(
                      "h-10 w-10 rounded-md ring-1 flex-shrink-0",
                      assignedHex
                        ? "ring-[var(--hairline-strong)]"
                        : "ring-dashed ring-[var(--hairline-strong)] bg-[repeating-linear-gradient(45deg,var(--surface-2),var(--surface-2)_4px,var(--surface)_4px,var(--surface)_8px)]",
                    )}
                    style={
                      assignedHex
                        ? { background: assignedHex }
                        : undefined
                    }
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-ink">
                      {label}
                    </div>
                    <div className="text-xs text-muted truncate">
                      {assignedHex
                        ? `${assignedHex}`
                        : `${hint} (auto)`}
                    </div>
                  </div>
                  {assignedHex && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        clearSlot(key);
                        if (activeSlot === key) setActiveSlot(null);
                      }}
                      className="text-xs text-faint hover:text-red-500 px-2 py-1 rounded transition-colors"
                      aria-label={`Clear ${label}`}
                    >
                      ×
                    </button>
                  )}
                </button>
              );
            })}
          </div>
          {anyAssigned && (
            <button
              type="button"
              onClick={resetAll}
              className="mt-3 text-xs text-muted hover:text-red-500 transition-colors"
            >
              Clear all
            </button>
          )}
        </div>

        {/* Palette column */}
        <div>
          <div className="text-xs uppercase tracking-widest text-muted mb-3">
            2. Click a color
            {activeSlot && (
              <span className="ml-2 font-normal normal-case tracking-normal text-[11px] text-ink-soft">
                → fills{" "}
                <span className="font-semibold">
                  {slots.find((s) => s.key === activeSlot)?.label}
                </span>
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {swatches.map((hex) => {
              const usedFor = slots.find((s) => value[s.key] === hex);
              return (
                <button
                  key={hex}
                  type="button"
                  onClick={() => handleSwatchClick(hex)}
                  title={
                    usedFor
                      ? `${hex} — currently ${usedFor.label}`
                      : hex
                  }
                  className={cn(
                    "h-12 w-12 rounded-md ring-1 transition-all relative",
                    usedFor
                      ? "ring-2 ring-ink"
                      : "ring-[var(--hairline-strong)] hover:ring-muted",
                  )}
                  style={{ background: hex }}
                >
                  {usedFor && (
                    <span className="absolute -top-1.5 -right-1.5 text-[9px] font-semibold uppercase tracking-wide bg-ink text-surface px-1.5 py-0.5 rounded-full whitespace-nowrap">
                      {usedFor.label.split(" ")[0]}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <div className="mt-3 text-[11px] text-muted font-mono leading-relaxed">
            Click a swatch to fill the active role. Tap an assigned
            swatch again to clear it. Hover a swatch to see its hex.
          </div>
        </div>
      </div>

      {!anyAssigned && (
        <div className="mt-6 text-xs text-muted italic">
          Don&apos;t feel like picking? Hit Continue → and the agent will
          choose for you. You can always change them later.
        </div>
      )}
    </div>
  );
}

/**
 * Sample-slide preview used inside StepColors. Mirrors the layout the
 * Design Agent emits — eyebrow + headline + italic accent + lede + a
 * KPI-style card with light-bg text — so the user sees how all four
 * colors interact, not just the background.
 *
 * Falls back to sensible defaults (deep gray + cyan) when a role is
 * unset, so the preview is always populated.
 */
function ColorPreview({
  value,
}: {
  value: { primary?: string; accent?: string; light?: string; dark?: string };
}) {
  const bg = value.primary ?? "#0a0a0a";
  const text = value.light ?? "#ffffff";
  const accent = value.accent ?? "#0891B2";
  const cardText = value.dark ?? "#0a0a0a";
  return (
    <div
      className="rounded-xl overflow-hidden ring-1 ring-[var(--hairline)]"
      style={{ background: bg, color: text }}
    >
      <div className="p-6 grid grid-cols-1 md:grid-cols-[1.4fr_1fr] gap-6 items-center">
        <div>
          <div
            className="text-[11px] uppercase tracking-widest mb-2 flex items-center gap-2"
            style={{ color: accent, opacity: 0.95 }}
          >
            <span
              className="inline-block h-0.5 w-5"
              style={{ background: accent }}
            />
            EYEBROW
          </div>
          <div
            className="text-2xl md:text-3xl font-semibold tracking-tight leading-tight"
            style={{ color: text }}
          >
            Sample headline with{" "}
            <em
              style={{
                fontStyle: "italic",
                color: accent,
              }}
            >
              italic accent
            </em>
            .
          </div>
          <div
            className="text-sm mt-2.5 opacity-85"
            style={{ color: text }}
          >
            Body copy with the background-aware text color you chose.
          </div>
        </div>
        {/* Light-card sample so the "Text on white cards" role visibly
            matters in the preview. */}
        <div
          className="rounded-lg bg-white p-4 shadow-sm"
          style={{ color: cardText }}
        >
          <div
            className="text-[10px] uppercase tracking-widest mb-1.5"
            style={{ color: accent }}
          >
            METRIC
          </div>
          <div
            className="text-3xl font-semibold tracking-tight"
            style={{ color: cardText }}
          >
            128%
          </div>
          <div className="text-xs mt-1 opacity-60" style={{ color: cardText }}>
            year-over-year
          </div>
        </div>
      </div>
    </div>
  );
}
