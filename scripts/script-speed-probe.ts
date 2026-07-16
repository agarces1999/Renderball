/**
 * SCRIPT-SPEED PROBE (2026-07-16) — answers one question with live numbers:
 * does the Agent-1 script stage NEED thinking-high (budget 8192) on GLM-5.2
 * @ Fireworks, or does a cheaper thinking config pass the SAME production
 * validators (schema + richness + grounding + type-only) at a fraction of
 * the wall?
 *
 * Context: acceptance6 measured the script stage at 320.7s of a 676s build —
 * 47% of wall. Per-attempt telemetry showed thinking-high throughput of
 * 26-110 visible tok/s vs the 400+ tok/s the SAME model does thinking-off in
 * the cast. The "script must think high" doctrine came from gpt-oss failing
 * richness 4x — GLM-5.2 with less/no thinking was never measured.
 *
 * Design: identical inputs to acceptance6's script phase (same Klarna brief,
 * same SCRIPT_GENERATOR_SYSTEM_PROMPT, same buildUserMessage, same
 * processScriptAttempt chain), one single-shot attempt per condition, all
 * conditions in PARALLEL: effort none / low(1024) / medium(2048).
 * Outputs: per-condition secs, tokens, validity, first failure line, and the
 * scene headlines (craft sample) → .data/script-probe/report.json.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { castCall, type CastEffort } from "../lib/llm/cast-provider";
import { SCRIPT_GENERATOR_SYSTEM_PROMPT } from "../lib/agents/prompts/script-generator";
import {
  buildUserMessage,
  claimGroundingSources,
  sceneClaimCopy,
  type AgentBrief,
  type AgentBrandExtract,
  type PreallocatedAsset,
} from "../lib/agents/script-generator";
import {
  validateScript,
  normalizeScriptContent,
  backfillSceneRegisters,
  findUngroundedClaims,
  findUngroundedStageLabels,
  findTypeOnlyScenes,
} from "../lib/agents/schema-validator";
import { stripCodeFence } from "../lib/agents/code-extraction";
import { loadBriefByScriptId, DEV_OWNER_ID, type StoredBrief } from "../lib/store";
import { withDbRetry } from "../lib/db";
import { ulid } from "../lib/ulid";

const ROOT = process.cwd();
const REF_BUILD = "01KWTTHKKECT0GGZ6D7HBQP1R5"; // Klarna — same brief as acceptance6
const REF_DIR = path.join(ROOT, "src", "generated", REF_BUILD);
const OUT_DIR = path.join(ROOT, ".data", "script-probe");
const FIREWORKS_GLM = "accounts/fireworks/models/glm-5p2";
const SCRIPT_MAX_TOKENS = 16000;

type LooseScript = { brief?: { about?: string }; config?: { duration_seconds?: number }; scenes: { label?: string; content?: { headline?: string }; visual_concept?: string }[] };

/** Verbatim from acceptance6-spike (which replicates script-generator's private helpers). */
const injectIdentity = (parsed: unknown, brief: AgentBrief, briefId: string): unknown => {
  if (typeof parsed !== "object" || parsed === null) return parsed;
  const p = parsed as Record<string, unknown>;
  const agentBrief = typeof p.brief === "object" && p.brief !== null ? (p.brief as Record<string, unknown>) : {};
  return {
    ...p,
    id: ulid(),
    customer_id: "local-dev",
    brand_kit_id: brief.brand_kit_url ? `bk_${briefId}` : null,
    created_at: new Date().toISOString(),
    schema_version: "1.0",
    brief: {
      purpose: brief.purpose ?? (agentBrief.purpose as string | undefined) ?? "",
      about: brief.freeform_prompt ?? "",
      cta: brief.cta ?? (agentBrief.cta as string | undefined) ?? "",
    },
    status: "draft",
  };
};

const mergePreallocatedAssets = (script: unknown, brief: AgentBrief): unknown => {
  if (typeof script !== "object" || script === null) return script;
  if (!brief.preallocated_assets || brief.preallocated_assets.length === 0) return script;
  const s = script as Record<string, unknown>;
  const assets = (s.assets as Record<string, unknown> | undefined) ?? {};
  const existing = Array.isArray(assets.images) ? (assets.images as Array<Record<string, unknown>>) : [];
  const ids = new Set(existing.map((a) => a.id as string).filter(Boolean));
  const merged = [...existing];
  for (const a of brief.preallocated_assets) {
    if (ids.has(a.id)) continue;
    merged.push({
      id: a.id, src: a.url, width: 0, height: 0,
      format: a.mime.includes("svg") ? "svg" : a.mime.includes("jpeg") || a.mime.includes("jpg") ? "jpg" : a.mime.includes("webp") ? "webp" : "png",
      license_id: "lic_user_provided", alt_text: a.label,
    });
  }
  return { ...s, assets: { ...(typeof assets === "object" && assets !== null ? assets : {}), images: merged } };
};

/** Verbatim from acceptance6-spike: the full production post-parse chain. */
const processScriptAttempt = (
  raw: string,
  brief: AgentBrief,
  briefId: string,
): { ok: true; script: LooseScript } | { ok: false; error: string } => {
  const cleaned = stripCodeFence(raw.trim());
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    return { ok: false, error: `Output was not valid JSON (${err instanceof Error ? err.message : String(err)}). Emit ONLY the Script JSON object. No prose, no markdown fence.` };
  }
  const withIdentity = injectIdentity(parsed, brief, briefId);
  const withAssets = mergePreallocatedAssets(withIdentity, brief);
  const normalized = backfillSceneRegisters(normalizeScriptContent(withAssets));
  const validation = validateScript(normalized);
  if (!validation.ok) return { ok: false, error: validation.error };
  const script = validation.script as unknown as LooseScript;

  const wantSec = brief.duration_seconds;
  const gotSec = script.config?.duration_seconds ?? 0;
  if (typeof wantSec === "number" && wantSec > 0 && Math.abs(gotSec - wantSec) > 0.5) {
    return { ok: false, error: `config.duration_seconds is ${gotSec}s but the brief requires EXACTLY ${wantSec}s.` };
  }
  if (script.scenes.length !== 5) {
    return { ok: false, error: `Script has ${script.scenes.length} scenes but the brief requires EXACTLY 5 sections.` };
  }
  const sourceText = claimGroundingSources(brief);
  const copy = sceneClaimCopy(script.scenes as never);
  const ungrounded = findUngroundedClaims(copy, sourceText);
  const stages = findUngroundedStageLabels(copy, sourceText);
  if (ungrounded.length > 0 || stages.length > 0) {
    return { ok: false, error: `ungrounded claims/stage labels: ${[...ungrounded, ...stages].join(", ")}` };
  }
  const typeOnly = findTypeOnlyScenes(script.scenes as { visual_concept?: string }[]);
  if (typeOnly.length > 0) {
    return { ok: false, error: `Type-only scenes: ${typeOnly.map((i) => `scene ${i}`).join(", ")}` };
  }
  return { ok: true, script };
};

/** Verbatim from acceptance6-spike. */
const buildPreallocatedFromCrawl = (be: AgentBrandExtract): PreallocatedAsset[] => {
  const out: PreallocatedAsset[] = [];
  const logoHd = (be as { logo_hd?: string }).logo_hd;
  if (logoHd) out.push({ id: "site_logo_hd", url: logoHd, mime: "image/png", source: "crawl", label: "brand logo (HD)" });
  else if (be.favicon) out.push({ id: "site_logo", url: be.favicon, mime: "image/x-icon", source: "crawl", label: "site favicon (low-res; only logo available)" });
  if (be.og_image) out.push({ id: "site_og_image", url: be.og_image, mime: "image/png", source: "crawl", label: "site OG image (hero / share image)" });
  (be.page_images ?? []).slice(0, 6).forEach((img, i) => {
    const ext = img.src.match(/\.(svg|png|jpe?g|webp|gif|avif)(\?|$)/i)?.[1]?.toLowerCase() ?? "";
    const mime =
      ext === "svg" ? "image/svg+xml"
      : ext === "jpg" || ext === "jpeg" ? "image/jpeg"
      : ext === "webp" ? "image/webp"
      : ext === "gif" ? "image/gif"
      : ext === "avif" ? "image/avif"
      : "image/png";
    out.push({ id: `site_img_${i}`, url: img.src, mime, source: "crawl", label: img.alt ? `site image: ${img.alt}` : `site image #${i + 1}` });
  });
  return out;
};

const CONDITIONS: { key: string; effort: CastEffort; json?: boolean }[] = process.argv.includes("--json-mode")
  ? [
      // Round 2: response_format json_object — kills the fence + JSON-typo
      // failure classes at the decoder. Two thinking levels to pick from.
      { key: "jsonmode-OFF", effort: "none", json: true },
      { key: "jsonmode-LOW-1024", effort: "low", json: true },
    ]
  : [
      { key: "thinking-OFF", effort: "none" },
      { key: "thinking-LOW-1024", effort: "low" },
      { key: "thinking-MED-2048", effort: "medium" },
    ];

const main = async () => {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const refScript: LooseScript = JSON.parse(await fs.readFile(path.join(REF_DIR, "script.json"), "utf8"));
  const stored = (await withDbRetry(() => loadBriefByScriptId(REF_BUILD, DEV_OWNER_ID))) as StoredBrief | null;
  if (!stored) throw new Error(`no Project row for ${REF_BUILD}`);
  const be = stored.brand_extract as unknown as AgentBrandExtract | undefined;
  if (!be?.ok) throw new Error("no cached brand_extract");

  const agentBrief: AgentBrief = {
    duration_seconds: stored.duration_seconds ?? 30,
    distribution_format: stored.distribution_format ?? "landscape",
    moment_count: 5,
    brand_kit_url: stored.brand_kit_url,
    verified_claims: stored.verified_claims,
    brand_extract: be,
    preallocated_assets: buildPreallocatedFromCrawl(be),
    freeform_prompt: refScript.brief?.about ?? stored.purpose,
  };
  const userMsg = buildUserMessage(agentBrief);

  // --offline: re-run the FULL validator chain on raw.*.txt saved by a prior
  // live probe (no LLM calls) — used to re-adjudicate outputs after fixing
  // the ```json fence-stripping bug in code-extraction.
  if (process.argv.includes("--offline")) {
    for (const c of CONDITIONS) {
      const rawPath = path.join(OUT_DIR, `raw.${c.key}.txt`);
      const raw = await fs.readFile(rawPath, "utf8").catch(() => null);
      if (raw === null) { console.log(`- ${c.key}: no raw file`); continue; }
      const res = processScriptAttempt(raw, agentBrief, stored.id);
      console.log(`${res.ok ? "✓ VALID  " : "✗ INVALID"} ${c.key.padEnd(18)} ${res.ok ? "" : res.error.split("\n")[0].slice(0, 200)}`);
      if (res.ok) {
        await fs.writeFile(path.join(OUT_DIR, `script.${c.key}.json`), JSON.stringify(res.script, null, 2), "utf8");
        console.log(`  headlines:\n    ${res.script.scenes.map((s) => s.content?.headline ?? "").join("\n    ")}`);
      }
    }
    return;
  }

  console.log(`brief ${stored.id} loaded — probing ${CONDITIONS.length} conditions in parallel on ${FIREWORKS_GLM}\n`);

  const rows = await Promise.all(
    CONDITIONS.map(async (c) => {
      try {
        const r = await castCall({
          system: SCRIPT_GENERATOR_SYSTEM_PROMPT,
          user: userMsg,
          maxTokens: SCRIPT_MAX_TOKENS,
          model: FIREWORKS_GLM,
          effort: c.effort,
          json: c.json,
        });
        const res = processScriptAttempt(r.text, agentBrief, stored.id);
        const row = {
          condition: c.key,
          secs: Math.round(r.seconds * 10) / 10,
          in: r.inputTokens,
          out: r.outputTokens,
          visibleChars: r.text.length,
          thinkingChars: r.thinking.length,
          stop: r.stopReason,
          valid: res.ok,
          error: res.ok ? null : res.error.split("\n")[0].slice(0, 220),
          headlines: res.ok ? res.script.scenes.map((s) => s.content?.headline ?? "") : null,
        };
        if (res.ok) await fs.writeFile(path.join(OUT_DIR, `script.${c.key}.json`), JSON.stringify(res.script, null, 2), "utf8");
        await fs.writeFile(path.join(OUT_DIR, `raw.${c.key}.txt`), r.text, "utf8");
        console.log(`${row.valid ? "✓ VALID  " : "✗ INVALID"} ${c.key.padEnd(18)} ${String(row.secs).padStart(6)}s  out=${row.out}  think=${row.thinkingChars}ch  ${row.error ?? ""}`);
        return row;
      } catch (err) {
        const row = { condition: c.key, secs: null, error: String(err).slice(0, 220), valid: false };
        console.log(`✗ ERROR   ${c.key} — ${row.error}`);
        return row;
      }
    }),
  );

  await fs.writeFile(path.join(OUT_DIR, "report.json"), JSON.stringify({ ranAt: new Date().toISOString(), brand: "Klarna", model: FIREWORKS_GLM, baseline: "acceptance6 thinking-high: 220.7s/55.5s/44.4s per attempt, valid on 3rd", rows }, null, 2), "utf8");
  console.log(`\nreport → ${path.join(OUT_DIR, "report.json")}`);
  for (const r of rows) {
    if ((r as { headlines?: string[] | null }).headlines) console.log(`\n${r.condition} headlines:\n  ${(r as { headlines: string[] }).headlines.join("\n  ")}`);
  }
};

main().then(
  () => process.exit(0),
  (err) => { console.error(err); process.exit(1); },
);
