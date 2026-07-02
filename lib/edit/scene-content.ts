/**
 * The canonical model of which text in a scene is USER-EDITABLE, and how to
 * get / set / delete it by a stable string path.
 *
 * WHY a content model and not JSX mutation: text in generated compositions is
 * bound to `script.scenes[K].content` — e.g. `<h1>{c.headline}</h1>`,
 * `<Eyebrow text={c.eyebrow}/>`, `<BulletList items={c.bullets}/>`,
 * `{c.caption}`, `<MetaFooter meta={c.meta}/>` (see any Composition.design.tsx).
 * So editing copy = updating these fields + re-saving the script; the preview
 * iframe and the MP4 render both read the script, so one edit shows everywhere,
 * with no fragile JSX-source surgery. The generated helpers render `null` for an
 * empty/absent field (Eyebrow/BulletList/MetaFooter all early-return), so
 * deleting a field degrades gracefully.
 *
 * Paths: "headline" | "lede" | "eyebrow" | "caption" | "bullets.0" |
 *        "cta.primary" | "cta.secondary" | "meta.1.label" | "meta.1.value".
 *
 * This module is PURE (no IO) so it unit-tests without a render. The M1 editor
 * uses it three ways: (1) `editableFields` enumerates a scene's copy for the UI
 * and the render-time tagger, (2) `getField` resolves a clicked element's text,
 * (3) `setField`/`deleteField` apply an edit immutably before the script is saved.
 */

export interface MetaItem {
  label: string;
  value: string;
}
export interface SceneContent {
  eyebrow?: string;
  headline?: string;
  lede?: string;
  bullets?: string[];
  caption?: string;
  meta?: MetaItem[];
  illustration?: string;
  cta?: { primary?: string; secondary?: string };
  asset_ids?: string[];
}

export type EditKind = "single" | "bullet" | "cta" | "meta-label" | "meta-value";

export interface EditableField {
  /** Stable path into SceneContent, e.g. "headline" or "bullets.2". */
  path: string;
  /** Current text value. */
  value: string;
  /** Human label for the edit UI, e.g. "Headline", "Bullet 3", "CTA". */
  label: string;
  kind: EditKind;
  /** Removable as a distinct element (array items). Single fields clear instead. */
  deletable: boolean;
}

const SINGLES: { key: keyof SceneContent; label: string }[] = [
  { key: "eyebrow", label: "Eyebrow" },
  { key: "headline", label: "Headline" },
  { key: "lede", label: "Subhead" },
  { key: "caption", label: "Caption" },
];

/**
 * Enumerate the populated, editable text fields of a scene's content, in a
 * stable top-to-bottom reading order: eyebrow → headline → subhead → bullets →
 * caption → meta → CTA. Empty/absent fields are skipped (nothing to click).
 */
export const editableFields = (content: SceneContent): EditableField[] => {
  const out: EditableField[] = [];
  const push = (path: string, value: string | undefined, label: string, kind: EditKind, deletable: boolean) => {
    if (typeof value === "string" && value.trim().length > 0) {
      out.push({ path, value, label, kind, deletable });
    }
  };

  // eyebrow, headline, subhead (caption pushed after bullets for reading order)
  push("eyebrow", content.eyebrow, "Eyebrow", "single", true);
  push("headline", content.headline, "Headline", "single", true);
  push("lede", content.lede, "Subhead", "single", true);

  (content.bullets ?? []).forEach((b, i) =>
    push(`bullets.${i}`, b, `Bullet ${i + 1}`, "bullet", true),
  );

  push("caption", content.caption, "Caption", "single", true);

  (content.meta ?? []).forEach((m, i) => {
    push(`meta.${i}.label`, m?.label, `Meta ${i + 1} label`, "meta-label", true);
    push(`meta.${i}.value`, m?.value, `Meta ${i + 1} value`, "meta-value", true);
  });

  push("cta.primary", content.cta?.primary, "CTA", "cta", true);
  push("cta.secondary", content.cta?.secondary, "CTA (secondary)", "cta", true);

  return out;
};

/**
 * Resolve a piece of rendered text back to the content path that produced it, by
 * matching the field VALUE. Lets the visual editor turn "the words you clicked" into
 * an editable field without the composition carrying an explicit tag — the fallback
 * when data-content-path is absent (existing videos). Exact-trim match first, then a
 * whitespace-normalized match; returns null if nothing matches (not editable copy).
 */
export const findPathByValue = (content: SceneContent, text: string): string | null =>
  matchFieldPath(editableFields(content), text);

/**
 * Match a clicked string against an already-enumerated field list (path + value).
 * Same two-pass logic as findPathByValue — exact-trim first, then whitespace-normalized —
 * but over a plain `{ path, value }[]`, so the browser editor can reuse it on fields it
 * fetched over the wire (no SceneContent object client-side). Returns null on no match.
 */
export const matchFieldPath = (
  fields: { path: string; value: string }[],
  text: string,
): string | null => {
  const t = text.trim();
  const exact = fields.find((f) => f.value.trim() === t);
  if (exact) return exact.path;
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const nt = norm(text);
  const fuzzy = fields.find((f) => norm(f.value) === nt);
  return fuzzy ? fuzzy.path : null;
};

/** Resolve a path to its current string value (undefined if absent). */
export const getField = (content: SceneContent, path: string): string | undefined => {
  const seg = path.split(".");
  if (seg.length === 1) {
    const v = content[seg[0] as keyof SceneContent];
    return typeof v === "string" ? v : undefined;
  }
  if (seg[0] === "bullets") {
    return content.bullets?.[Number(seg[1])];
  }
  if (seg[0] === "cta") {
    return content.cta?.[seg[1] as "primary" | "secondary"];
  }
  if (seg[0] === "meta") {
    const m = content.meta?.[Number(seg[1])];
    return m ? m[seg[2] as "label" | "value"] : undefined;
  }
  return undefined;
};

const cloneContent = (c: SceneContent): SceneContent => ({
  ...c,
  bullets: c.bullets ? [...c.bullets] : undefined,
  meta: c.meta ? c.meta.map((m) => ({ ...m })) : undefined,
  cta: c.cta ? { ...c.cta } : undefined,
});

/** Immutably set the text at `path`. Unknown/ill-formed paths are a no-op clone. */
export const setField = (
  content: SceneContent,
  path: string,
  value: string,
): SceneContent => {
  const next = cloneContent(content);
  const seg = path.split(".");
  if (seg.length === 1 && (["eyebrow", "headline", "lede", "caption"] as const).includes(seg[0] as never)) {
    (next as Record<string, unknown>)[seg[0]] = value;
  } else if (seg[0] === "bullets" && next.bullets && Number(seg[1]) < next.bullets.length) {
    next.bullets[Number(seg[1])] = value;
  } else if (seg[0] === "cta") {
    next.cta = { ...(next.cta ?? {}), [seg[1]]: value };
  } else if (seg[0] === "meta" && next.meta && next.meta[Number(seg[1])] && (seg[2] === "label" || seg[2] === "value")) {
    next.meta[Number(seg[1])][seg[2]] = value;
  }
  return next;
};

/**
 * Immutably delete the element at `path`. Array items (a bullet, a meta pair) are
 * removed from their array; a single text field is cleared (set undefined) so its
 * bound element renders nothing. Note: `meta.N.label`/`meta.N.value` remove the
 * whole meta pair (a half-empty KPI tile reads as broken, so the tile goes).
 */
export const deleteField = (content: SceneContent, path: string): SceneContent => {
  const next = cloneContent(content);
  const seg = path.split(".");
  if (seg.length === 1) {
    delete (next as Record<string, unknown>)[seg[0]];
  } else if (seg[0] === "bullets" && next.bullets) {
    next.bullets.splice(Number(seg[1]), 1);
    if (next.bullets.length === 0) delete next.bullets;
  } else if (seg[0] === "cta" && next.cta) {
    delete next.cta[seg[1] as "primary" | "secondary"];
    if (!next.cta.primary && !next.cta.secondary) delete next.cta;
  } else if (seg[0] === "meta" && next.meta) {
    next.meta.splice(Number(seg[1]), 1);
    if (next.meta.length === 0) delete next.meta;
  }
  return next;
};
