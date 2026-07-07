/**
 * Brand-kit gate (approved DESIGN.md deviation, Alfonso 2026-07-07).
 *
 * Before any paid build, the brand identity must be USER-LOCKED:
 *   - LOGO — required. Either an uploaded file (brand_files[i].is_logo) or an
 *     explicit one-click confirmation of the crawled mark
 *     (logo_source === "crawl_confirmed"). Never silently trusted from crawl —
 *     dead/blank logo assets were the #1 shipped-defect class in the
 *     2026-07-06 QA.
 *   - COLORS — the scanned palette must be confirmed (editable first). Only
 *     required when a crawl actually produced a palette; with no scan there is
 *     nothing to confirm and the palette_roles overrides remain optional.
 *   - FONT — optional upload (is_font). When present it must carry a license
 *     attestation (the uploader owns the webfont license; we stop copying
 *     licensed faces off crawled sites on the user's behalf).
 *
 * Pure + shared: the /new form disables submit on it, submitBrief() rejects
 * on it (server truth), and /api/preview/build re-checks it (defense in
 * depth). Dev/harness routes are exempt — they run sessionless validation
 * builds against synthetic briefs.
 */

export interface BrandKitBrief {
  brand_files?: { is_logo?: boolean; is_font?: boolean; font_licensed?: boolean }[];
  logo_source?: "upload" | "crawl_confirmed";
  colors_confirmed?: boolean;
  brand_extract?: {
    ok?: boolean;
    logo_hd?: string;
    palette?: string[];
  };
}

export interface BrandKitStatus {
  ready: boolean;
  /** Human-readable blockers, empty when ready. */
  missing: string[];
}

export const brandKitStatus = (brief: BrandKitBrief | null | undefined): BrandKitStatus => {
  const missing: string[] = [];
  const b = brief ?? {};

  const uploadedLogo = (b.brand_files ?? []).some((f) => f.is_logo);
  const crawledLogoConfirmed =
    b.logo_source === "crawl_confirmed" && !!b.brand_extract?.ok && !!b.brand_extract.logo_hd;
  if (!uploadedLogo && !crawledLogoConfirmed) {
    missing.push("logo (upload one, or confirm the logo found on your site)");
  }

  const hasScannedPalette = !!b.brand_extract?.ok && (b.brand_extract.palette?.length ?? 0) > 0;
  if (hasScannedPalette && b.colors_confirmed !== true) {
    missing.push("brand colors (confirm or edit the scanned palette)");
  }

  const font = (b.brand_files ?? []).find((f) => f.is_font);
  if (font && font.font_licensed !== true) {
    missing.push("font license attestation (confirm you hold the webfont license)");
  }

  return { ready: missing.length === 0, missing };
};
