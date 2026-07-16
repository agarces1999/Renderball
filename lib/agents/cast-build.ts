/**
 * CAST ORCHESTRATOR — the element-cast build path on the Cerebras provider
 * (speed-quality pivot, 2026-07-14).
 *
 * Doctrine: elements generate INDEPENDENTLY and in parallel against
 * PRE-SETTLED contracts — correctness comes from construction, not
 * detect-and-retry. This module owns no cleverness of its own; it sequences
 * the modules that each make one defect class unrepresentable:
 *
 *   - layout-composer  settles every element's territory (bounds, content
 *     ownership, palette roles, declared overlaps) BEFORE any code exists,
 *     so two blind generators can never claim the same pixels.
 *   - cast-provider    is the transport (OpenAI-wire, tight token caps,
 *     effort dial — "think at the head, emit at the leaves").
 *   - normalize-element hue-locks every emitted color into the brand's
 *     vocabulary, so off-brand hues cannot ship.
 *   - assemble         re-inlines the bodies into the exact Composition.tsx
 *     contract the whole validated render stack consumes.
 *   - choreograph      compiles motion deterministically (zero tokens),
 *     pacing correct by construction.
 *
 * Failure posture: an element that stays broken after ONE surgical repair is
 * substituted with a minimal safe placeholder and COUNTED — the build
 * completes degraded rather than dying, and telemetry reports it honestly.
 * A final composition that does not compile, by contrast, THROWS: that is an
 * orchestrator bug, never a runtime condition.
 */
import type { Script } from "../../src/schema";
import type { Theme, SceneManifest, Piece } from "../edit/piece-model";
import { castCall } from "../llm/cast-provider";
import { composeSceneLayout, type Aspect, type ElementSlot } from "./layout-composer";
import { normalizeElementColors, assessAccentPresence } from "./normalize-element";
import { assembleComposition } from "./assemble";
import { applyChoreography } from "./choreograph";
import { stripCodeFence, verifyCompilable } from "./code-extraction";
import { AccountLimiter } from "./account-limiter";

// ─── Public contract ────────────────────────────────────────────────────────

export interface CastBuildInput {
  /** From the existing script agent — unchanged by the cast path. */
  script: Script;
  /** The frozen design system. The caller supplies it (head workload / stored
   *  theme); the orchestrator never derives one. */
  theme: Theme;
  /** Brand hex palette — the hue vocabulary normalize-element locks to. */
  palette: string[];
  /** Brand signature hex; drives the accent-presence check (detection only). */
  signatureAccent?: string;
  aspect: Aspect;
}

export interface CastBuildResult {
  /** Final Composition.tsx — assembled, choreographed, compile-verified. */
  code: string;
  /** The manifests the assembler consumed (piece ids, bounds, slugs). */
  scenes: SceneManifest[];
  telemetry: {
    /** Non-chrome slots that earned a generation call. */
    elements: number;
    /** Elements that ended as placeholders (broken through the one repair). */
    failures: number;
    /** Elements the ONE repair retry actually recovered. */
    repairs: number;
    /** Output tokens across every call, including failed + repair calls. */
    tokensOut: number;
    wallSeconds: number;
    /** Total off-brand color rewrites in shipped bodies ("what would have
     *  shipped off-brand"). */
    normalizedColors: number;
  };
}

// ─── Per-slot output ceilings ───────────────────────────────────────────────

/**
 * Honest per-slot output caps. Cerebras PRE-DEBITS max_completion_tokens
 * against the TPM bucket BEFORE generating (see cast-provider.ts) — a lazy
 * 40k cap on a 3k element starves the rest of the burst — so each slot gets
 * the measured shape of its workload and nothing more.
 */
const MAX_TOKENS_BY_SLOT: Record<string, number> = {
  atmosphere: 2000, // gradient washes / glow / grain — compact
  copy: 2500, // the editorial text stack
  hero: 4000, // the diegetic visual — the dense one
  throughline: 1500, // one small motif
};
const maxTokensFor = (slotId: string): number => MAX_TOKENS_BY_SLOT[slotId] ?? 4000;

// ─── Shared conventions ─────────────────────────────────────────────────────

/**
 * Mirrors pipeline.ts `slugify` — the slug the throughline presence/drift
 * gates count off `data-throughline`. Mirrored, not imported: pipeline.ts
 * pulls the SDK/store world and this module must stay a testable leaf (the
 * same reasoning layout-composer applies to CANVAS_DIMS).
 */
const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

/** Palette-role → theme-const aliases. The composer speaks ROLES (canvas/ink/
 *  accent); the theme's palette keys are whatever const names the head emitted
 *  (BG, ACCENT, INK, …) — grammar carries the surface tokens explicitly. */
const ROLE_ALIASES: Record<string, string[]> = {
  canvas: ["bg", "canvas", "background"],
  ink: ["ink", "fg", "text"],
  accent: ["accent", "primary", "brand"],
};

/** Resolve a composer palette ROLE to the actual theme const NAME an element
 *  must paint with. grammar owns the surface tokens; the rest resolve by
 *  alias against the palette keys (exact match first, then substring),
 *  falling back to the first key so a sparse theme degrades, not dies. */
const tokenForRole = (theme: Theme, role: string): string => {
  if (role === "panelBg") return theme.grammar.panelBg;
  if (role === "hairline") return theme.grammar.hairline;
  const keys = Object.keys(theme.palette);
  for (const alias of ROLE_ALIASES[role] ?? [role.toLowerCase()]) {
    const hit =
      keys.find((k) => k.toLowerCase() === alias) ??
      keys.find((k) => k.toLowerCase().includes(alias));
    if (hit) return hit;
  }
  return keys[0];
};

// ─── The element system prompt ──────────────────────────────────────────────

/**
 * One shared system prompt for every element call — adapted from the bake-off
 * harness (scripts/model-bakeoff.mjs ELEMENT_SYSTEM) and tightened for
 * production:
 *   - the WRAPPER owns placement (the bake-off asked elements to self-position;
 *     under assemble.ts each body is inlined into a positioned wrapper div),
 *   - data-content-path values match choreograph.ts `fieldsOf` exactly
 *     (bullets.0, meta.0.value, cta.primary) — those are the selectors the
 *     deterministic motion rules target,
 *   - copy binds through `c` so text edits stay LLM-free (piece-model doctrine).
 */
const buildElementSystem = (theme: Theme): string => {
  const paletteLines = Object.entries(theme.palette)
    .map(([name, value]) => `  ${name} = ${JSON.stringify(value)}`)
    .join("\n");
  const keyframeNames = [...theme.keyframes.matchAll(/@keyframes\s+([A-Za-z_][A-Za-z0-9_-]*)/g)].map(
    (m) => m[1],
  );
  const g = theme.grammar;
  return [
    `You CREATE one element ("piece") of an animated brand-video scene from a brief.`,
    `The scene's shared design system is already in scope as module consts. Emit ONLY the JSX for this ONE element.`,
    `HARD RULES:`,
    `- Output ONLY JSX — no imports, no exports, no prose, no markdown fence, nothing at module scope.`,
    `- Your JSX is inlined into a positioned wrapper div at the exact BOUNDS in the brief. FILL the wrapper (width/height 100%; text flows inside its max width). NEVER position yourself with canvas coordinates — the wrapper owns placement.`,
    `- Paint ONLY with the palette roles the brief grants, via the const names below. Never invent colors — off-vocabulary hues are rewritten.`,
    `- Copy renders VERBATIM from the \`c\` binding (this scene's content object): {c.headline}, {c.bullets[0]}, … Tag every copy node with the exact data-content-path the brief gives it. Never invent numbers or claims.`,
    `- CSS animation only, using ONLY the shared @keyframes names listed below${keyframeNames.length ? "" : " (none exist — emit static; the choreographer adds motion)"}. No Remotion hooks, no Math.random, no undefined components.`,
    `- Follow the design grammar: radii ${JSON.stringify(g.radiusScale)}, ${g.strokeWeight}px hairlines via ${g.hairline}, surfaces via ${g.panelBg}, shadow "${g.shadowRecipe}", ${g.dataFont === "mono" ? "FONT_MONO" : "FONT_BODY"} for data.`,
    `- Rich, production-grade, dense — an element of a premium brand video.`,
    `- Valid TSX that compiles when inlined as a JSX child.`,
    `IN SCOPE: the palette consts below; FONT_DISPLAY / FONT_BODY / FONT_MONO; GRAMMAR (frozen); lastWordAccent(text, color); <Img>; \`c\` (scene content).`,
    `PALETTE CONSTS:`,
    paletteLines,
    keyframeNames.length ? `SHARED @keyframes: ${keyframeNames.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
};

// ─── Element briefs ─────────────────────────────────────────────────────────

type SceneContent = Script["scenes"][number]["content"];

/** The copy fields an element owns, as brief lines carrying the VERBATIM
 *  values + the choreograph-consistent data-content-path for each. */
const copyLines = (content: SceneContent | undefined, owned: string[]): string[] => {
  const c = (content ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  const scalar = (field: string) => {
    const v = c[field];
    if (owned.includes(field) && typeof v === "string" && v.trim()) {
      out.push(`${field}: ${JSON.stringify(v)} (data-content-path="${field}")`);
    }
  };
  scalar("eyebrow");
  scalar("headline");
  scalar("lede");
  if (owned.includes("bullets") && Array.isArray(c.bullets)) {
    c.bullets.forEach((b, i) => out.push(`bullets.${i}: ${JSON.stringify(b)} (data-content-path="bullets.${i}")`));
  }
  scalar("caption");
  if (owned.includes("meta") && Array.isArray(c.meta)) {
    (c.meta as Array<{ label?: string; value?: string }>).forEach((m, i) =>
      out.push(`meta.${i}: label ${JSON.stringify(m?.label ?? "")}, value ${JSON.stringify(m?.value ?? "")} (tag the value data-content-path="meta.${i}.value")`),
    );
  }
  if (owned.includes("cta") && c.cta && typeof c.cta === "object") {
    const cta = c.cta as { primary?: string; secondary?: string };
    if (cta.primary) out.push(`cta.primary: ${JSON.stringify(cta.primary)} (data-content-path="cta.primary")`);
    if (cta.secondary) out.push(`cta.secondary: ${JSON.stringify(cta.secondary)} (data-content-path="cta.secondary")`);
  }
  if (owned.includes("texts") && Array.isArray(c.texts)) {
    // Deprecated legacy field — still rendered so nothing is orphaned.
    c.texts.forEach((t, i) => out.push(`texts.${i}: ${JSON.stringify(t)} (data-content-path="texts.${i}")`));
  }
  return out;
};

/**
 * One element's brief: ONLY what that element owns — its role, its wrapper
 * geometry, the content-field values it renders, the palette roles it may
 * paint with (mapped to real const names), and the motif description when it
 * IS the throughline. Scene intent + register ride along for flavor; nothing
 * about any OTHER element leaks in (independence is the contract).
 */
const elementBrief = (args: {
  theme: Theme;
  script: Script;
  sceneIndex: number;
  register: string;
  slot: ElementSlot;
  pieceId: string;
  throughline: string;
}): string => {
  const { theme, script, sceneIndex, register, slot, pieceId, throughline } = args;
  const scene = script.scenes[sceneIndex];
  const b = slot.bounds;
  const lines: string[] = [
    `CREATE this element — scene ${sceneIndex} ("${scene.label}", register ${register}), piece id "${pieceId}", kind "${slot.kind}".`,
    `Scene intent: ${scene.description ?? scene.label}`,
    `Visual concept (this element's role within it): ${String(scene.visual_concept ?? "").slice(0, 600)}`,
    `BOUNDS: your wrapper is ${b.w}×${b.h}px at canvas (${b.x},${b.y})${slot.kind === "text" ? " — width is a MAX, height flows" : ""}. Fill it.`,
    `PALETTE ROLES you may paint with: ${slot.paletteRoles.map((r) => `${r} → ${tokenForRole(theme, r)}`).join(", ")}.`,
  ];

  if (slot.id === "atmosphere") {
    lines.push(
      `Full-bleed decorative BASE layer (z0) under all content: gradient washes, glow, grain. The accent role may appear at LOW ALPHA only (a glow, never a fill). No text, no UI.`,
    );
  } else if (slot.id === "copy") {
    lines.push(`The scene's editorial text stack — ONE flow column, top to bottom, each field tagged:`, ...copyLines(scene.content, slot.contentFields));
  } else if (slot.id === "throughline") {
    lines.push(
      `This element IS the story's throughline motif: ${JSON.stringify(throughline)}. It recurs at this exact anchor in EVERY scene and must read as ONE continuous object that evolves along the arc — never a fresh object per cut. The wrapper already carries the data-throughline tag and the pinned anchor; render only the motif itself.`,
    );
  } else {
    // hero — the diegetic visual. It renders its owned visual fields when the
    // scene brings them; otherwise it INVENTS the visual from the concept
    // (the composer keeps the slot either way — see layout-composer).
    const c = scene.content ?? ({} as SceneContent);
    if (slot.contentFields.includes("illustration") && c.illustration) {
      lines.push(`Illustration intent: ${JSON.stringify(c.illustration)} — draw it as inline SVG.`);
    }
    if (slot.contentFields.includes("asset_ids") && Array.isArray(c.asset_ids) && c.asset_ids.length > 0) {
      const imagesById = new Map((script.assets?.images ?? []).map((img) => [img.id, img]));
      for (const id of c.asset_ids) {
        const img = imagesById.get(id);
        if (img) lines.push(`Image ${id}: mount with <Img src=${JSON.stringify(img.src)} /> (${img.width}×${img.height}${img.alt_text ? `, ${img.alt_text}` : ""}).`);
      }
    }
    if (slot.contentFields.length === 0) {
      lines.push(`No visual fields given — invent the diegetic visual (a browser mock, chart, panel, KPI cluster…) from the visual concept above.`);
    }
  }

  lines.push("", "Emit ONLY the JSX for THIS element.");
  return lines.join("\n");
};

// ─── Fragment verification + placeholder ────────────────────────────────────

/**
 * FRAGMENT-VERIFICATION CHOICE: wrap the body the same way assemble.ts will —
 * a JSX child inside a wrapper div, inside a component arrow body — and run
 * `verifyCompilable` on THAT harness, per element. Chosen over compile-checking
 * the assembled scene per result because it is cheaper (one ~1ms esbuild
 * transform per element instead of re-assembling N times) and equally sound
 * for the defect class a syntax gate can catch (truncation, unbalanced tags,
 * leaked prose): esbuild's transform binds no identifiers either way, and any
 * fragment that parses in this child position parses identically inside
 * assemble's wrapper. It also localizes the compiler error to the one element,
 * which is exactly what the repair prompt needs to quote. The assembled whole
 * still gets a final `verifyCompilable` before return as the backstop.
 */
const verifyFragment = (body: string): Promise<string | null> =>
  verifyCompilable(`const __CastPiece = () => (\n<div>\n${body}\n</div>\n);`);

/**
 * Degraded-but-shippable substitute for an element that stayed broken through
 * its repair: a neutral surface in the theme's own grammar — or, when the
 * element owns the headline, the headline itself (the one piece of content a
 * scene cannot silently lose). Referenced consts (FONT_DISPLAY + the theme
 * tokens) are always emitted by the assembler, so the placeholder compiles by
 * construction.
 */
const placeholderBody = (theme: Theme, slot: ElementSlot): string =>
  slot.contentFields.includes("headline")
    ? `<div data-content-path="headline" style={{ fontFamily: FONT_DISPLAY, fontSize: 56, fontWeight: 600, lineHeight: 1.1, color: ${tokenForRole(theme, "ink")} }}>{c.headline}</div>`
    : `<div style={{ width: "100%", height: "100%", borderRadius: 12, background: ${theme.grammar.panelBg}, border: "1px solid", borderColor: ${theme.grammar.hairline} }} />`;

// ─── The orchestrator ───────────────────────────────────────────────────────

interface ElementJob {
  sceneIndex: number;
  slot: ElementSlot;
  pieceId: string;
  brief: string;
}

interface ElementOutcome {
  pieceId: string;
  body: string;
  outputTokens: number;
  repaired: boolean;
  failed: boolean;
  colorRewrites: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Drive one full element-cast build: settle contracts, fire every element
 * call in parallel through a semaphore, hue-lock + verify each body (one
 * surgical repair, then placeholder), assemble, choreograph, compile-verify.
 *
 * `opts.caller` is dependency injection for tests (canned bodies, no network);
 * production uses the real `castCall`. `opts.concurrency` is the burst width —
 * a per-build FIFO semaphore (AccountLimiter, the tested pattern) sized for
 * Cerebras. Deliberately NOT `fillLimiter`: that singleton is sized for the
 * z.ai account ceiling and would strangle a Cerebras burst.
 */
export const castBuild = async (
  input: CastBuildInput,
  opts?: { caller?: typeof castCall; concurrency?: number },
): Promise<CastBuildResult> => {
  const t0 = Date.now();
  const { script, theme, palette, aspect } = input;
  if (Object.keys(theme.palette).length === 0) {
    throw new Error("cast-build: theme.palette is empty — nothing for elements to paint with");
  }
  const caller = opts?.caller ?? castCall;
  const width = Math.max(1, Math.floor(opts?.concurrency ?? (Number(process.env.RB_CAST_CONCURRENCY) || 14)));
  const limiter = new AccountLimiter(width);

  // ── 1. Settle the contracts: one deterministic plan per scene ────────────
  // Every scene carries the motif when the script has one: the choreographer's
  // match cut needs it visible at t=0 in EVERY scene, and the presence gate
  // needs a ≥60% majority — all-scenes satisfies both by construction, and the
  // composer keeps the slot clear of copy/chrome at every register × aspect.
  const throughline = script.narrative?.throughline?.trim() ?? "";
  const hasThroughline = throughline.length > 0;
  const slug = slugify(throughline);

  const plans = script.scenes.map((scene) =>
    composeSceneLayout({ register: scene.register, content: scene.content }, aspect, { hasThroughline }),
  );

  const scenes: SceneManifest[] = plans.map((plan, i) => ({
    scene: i,
    background: tokenForRole(theme, "canvas"),
    pieces: plan.elements.map(
      (slot): Piece => ({
        id: `s${i}.${slot.id}`, // the Piece id convention (see ElementSlot.id)
        kind: slot.kind,
        // Virtual path — cast bodies stay in-memory (the resolver below); this
        // is the manifest slot a future decompose-to-disk step will fill.
        file: `scene${i}/${slot.id}.tsx`,
        bounds: slot.bounds,
        ...(slot.kind === "text" ? { contentRef: `scenes[${i}].content` } : {}),
        ...(slot.id === "throughline" ? { throughlineSlug: slug } : {}),
      }),
    ),
  }));

  // ── 2. Element briefs — chrome earns NO call (Section emits Chrome itself,
  //       see assemble.ts) ──────────────────────────────────────────────────
  const system = buildElementSystem(theme);
  const jobs: ElementJob[] = plans.flatMap((plan, i) =>
    plan.elements
      .filter((slot) => slot.kind !== "chrome")
      .map((slot) => ({
        sceneIndex: i,
        slot,
        pieceId: `s${i}.${slot.id}`,
        brief: elementBrief({ theme, script, sceneIndex: i, register: plan.register, slot, pieceId: `s${i}.${slot.id}`, throughline }),
      })),
  );

  // ── 3+4. Fire ALL calls through the semaphore; per result: extract →
  //         hue-lock → fragment-verify → one repair → placeholder ──────────
  const runElement = async (job: ElementJob): Promise<ElementOutcome> => {
    let tokens = 0;

    // One attempt: call, extract, hue-lock, syntax-verify. A transport throw
    // (castCall retries internally first) is treated like a broken result —
    // the build completes degraded rather than dying on one element.
    const attempt = async (
      user: string,
    ): Promise<{ ok: true; body: string; rewrites: number } | { ok: false; raw: string; error: string }> => {
      let text: string;
      try {
        const res = await caller({ system, user, maxTokens: maxTokensFor(job.slot.id), effort: "low" });
        tokens += res.outputTokens;
        text = res.text;
      } catch (err) {
        return { ok: false, raw: "", error: err instanceof Error ? err.message : String(err) };
      }
      const raw = stripCodeFence(text);
      if (raw.length < 8 || !raw.includes("<") || /^\s*(?:import|export)\b/.test(raw)) {
        return { ok: false, raw, error: "output is not a JSX fragment (empty, no markup, or a module)" };
      }
      const { code: locked, changes } = normalizeElementColors(raw, palette);
      const compileErr = await verifyFragment(locked);
      if (compileErr) return { ok: false, raw, error: compileErr };
      return { ok: true, body: locked, rewrites: changes.reduce((n, ch) => n + ch.count, 0) };
    };

    const first = await attempt(job.brief);
    if (first.ok) {
      return { pieceId: job.pieceId, body: first.body, outputTokens: tokens, repaired: false, failed: false, colorRewrites: first.rewrites };
    }

    // ONE surgical repair: the same brief + the broken output + the exact
    // error. A syntax failure is mechanical, not creative — one pointed retry
    // recovers most of them (repairCompile doctrine, code-extraction.ts).
    const second = await attempt(
      [
        job.brief,
        "",
        "Your previous attempt failed:",
        first.raw ? `--- previous attempt ---\n${first.raw}` : "(the call itself failed)",
        `--- error ---\n${first.error}`,
        "Emit corrected JSX only.",
      ].join("\n"),
    );
    if (second.ok) {
      return { pieceId: job.pieceId, body: second.body, outputTokens: tokens, repaired: true, failed: false, colorRewrites: second.rewrites };
    }

    console.warn(`[cast-build] ${job.pieceId}: broken through repair — shipping placeholder (${second.error.slice(0, 120)})`);
    return { pieceId: job.pieceId, body: placeholderBody(theme, job.slot), outputTokens: tokens, repaired: false, failed: true, colorRewrites: 0 };
  };

  const outcomes = await Promise.all(jobs.map((job) => limiter.with(() => runElement(job))));
  const bodies = new Map(outcomes.map((o) => [o.pieceId, o.body]));

  // ── 5. Assemble → choreograph (motion is a compile step, invoked exactly
  //       like pipeline.ts's parallel branch) → final compile gate ─────────
  const assembled = assembleComposition({ theme, scenes, pieceBody: (p) => bodies.get(p.id) ?? "<div />" });
  // CastBuildInput carries no brand_extract, so the motion signal is the
  // pipeline's own fallback: "medium".
  const code = applyChoreography(assembled, script, "medium");

  const finalErr = await verifyCompilable(code);
  if (finalErr) {
    // Every body was fragment-verified and the assembler is deterministic —
    // reaching here is an orchestrator bug, never a runtime condition.
    throw new Error(`cast-build: assembled composition does not compile: ${finalErr}`);
  }

  // Accent PRESENCE is the complement of hue-locking (normalize-element.ts):
  // all-neutral output sails through the lock. Detection only — log loudly,
  // let the vision gate / caller decide what absence costs.
  const accent = assessAccentPresence(code, palette, input.signatureAccent);
  if (!accent.present) {
    console.warn(`[cast-build] brand accent hue ${accent.accentHue?.toFixed(0)}° absent from the final composition`);
  }

  return {
    code,
    scenes,
    telemetry: {
      elements: jobs.length,
      failures: outcomes.filter((o) => o.failed).length,
      repairs: outcomes.filter((o) => o.repaired).length,
      tokensOut: outcomes.reduce((n, o) => n + o.outputTokens, 0),
      wallSeconds: round2((Date.now() - t0) / 1000),
      normalizedColors: outcomes.reduce((n, o) => n + o.colorRewrites, 0),
    },
  };
};
