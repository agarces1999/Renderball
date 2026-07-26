/**
 * Render a document's brand context as prompt text.
 *
 * The generation agents already receive the frozen design system (the module
 * preamble) and are told to reuse its consts rather than invent colours. What
 * they never had is the part a designer would actually tell them: the brand's
 * RULES and MATERIALS in the user's own words — "sentence case for headlines",
 * "never put the logo on the accent colour", "here is our product photo, use
 * it for the hero".
 *
 * This is what makes brand editing more than a colour swap. A re-skin
 * (lib/brand/reskin.ts) restyles what already exists for free; this makes the
 * next thing the model creates come out on-brand in the first place.
 *
 * Kept compact on purpose — it is prepended to every regeneration, so it is
 * paid for on every call. Guidelines are already bounded to 4000 chars at
 * validation; the material list is capped here.
 */
import type { DocumentBrand } from "./document-brand";

/** Materials worth naming to the model. Fonts are applied via CSS, not by the
 *  model, and would only be noise in a prompt. */
const USABLE_KINDS = new Set(["logo", "logomark", "icon", "image", "illustration", "data"]);
const MAX_LISTED = 20;

/**
 * Returns a prompt block, or null when the document has no brand context (so
 * callers can skip the block entirely rather than send an empty heading).
 */
export const brandPromptBlock = (brand: DocumentBrand | null | undefined): string | null => {
  if (!brand) return null;

  const lines: string[] = [];

  const guidelines = brand.guidelines?.trim();
  if (guidelines) {
    lines.push(
      "BRAND GUIDELINES — the user's own rules for this brand. Follow them over your own taste:",
      guidelines,
      "",
    );
  }

  const materials = brand.assets.filter((a) => USABLE_KINDS.has(a.kind)).slice(0, MAX_LISTED);
  if (materials.length > 0) {
    lines.push(
      "BRAND MATERIALS available to this document. Reference one with",
      '`<Img src="assets/…" />` using the EXACT ref below. Never invent a ref,',
      "and never hotlink an external image.",
    );
    for (const m of materials) {
      const note = m.note ? ` — ${m.note}` : "";
      lines.push(`- ${m.ref}  (${m.kind}: ${m.name})${note}`);
    }
    if (brand.logo) lines.push(`- the brand's LOGO is: ${brand.logo}`);
    lines.push("");
  }

  // The palette/fonts are already in the preamble consts; naming the ROLES
  // here tells the model which const means what, which the preamble alone
  // does not always make obvious.
  const roles = Object.entries(brand.palette ?? {});
  if (roles.length > 0) {
    lines.push(
      `BRAND COLOUR ROLES (already applied to the design system): ${roles
        .map(([role, hex]) => `${role} ${hex}`)
        .join(", ")}.`,
      "Use the shared consts, not these literals.",
      "",
    );
  }

  const fonts = brand.fonts ?? {};
  if (fonts.display || fonts.body || fonts.mono) {
    lines.push(
      `BRAND TYPE: ${[
        fonts.display && `display ${fonts.display}`,
        fonts.body && `body ${fonts.body}`,
        fonts.mono && `mono ${fonts.mono}`,
      ]
        .filter(Boolean)
        .join(" · ")}. Reference FONT_DISPLAY / FONT_BODY / FONT_MONO.`,
      "",
    );
  }

  const text = lines.join("\n").trim();
  return text.length > 0 ? text : null;
};
