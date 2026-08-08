/**
 * Vision call — Fireworks (Qwen2.5-VL) on the OpenAI wire.
 *
 * 2026-07-23: z.ai is out of the stack (founder call, Fireworks only). This
 * module keeps its historical name and export signatures (callZaiVision /
 * callZaiText) because six call sites route through it — the QA vision gate,
 * the crawl's color/design-language/logo reads — and the wire format is
 * unchanged (OpenAI `image_url` chat completions, which the z.ai native
 * endpoint also spoke). Only the host, key, and model moved.
 *
 * History worth keeping: vision must NEVER go through an Anthropic-compat
 * proxy endpoint that drops image blocks (the original z.ai lesson — the
 * model hallucinated entire frames). This module is the single vision
 * transport; keep it on a wire where images verifiably arrive.
 */
import { readFileSync } from "fs";
import path from "path";
import { VISION_MODEL } from "../anthropic";
import { EMPTY_USAGE, type Usage } from "../usage";
import { recordSpend } from "../spend/record";

const readEnvLocal = (key: string): string | undefined => {
  try {
    const content = readFileSync(path.join(process.cwd(), ".env.local"), "utf-8");
    const m = content.match(new RegExp(`^${key}=(.+)$`, "m"));
    let v = m?.[1]?.trim();
    if (v && /^["'].*["']$/.test(v)) v = v.slice(1, -1);
    return v || undefined;
  } catch {
    return undefined;
  }
};

const fireworksKey = (): string => {
  const k = process.env.RB_FIREWORKS_KEY?.trim() || readEnvLocal("RB_FIREWORKS_KEY");
  if (!k) throw new Error("RB_FIREWORKS_KEY not set (Fireworks vision)");
  return k;
};

const visionUrl = (): string => "https://api.fireworks.ai/inference/v1/chat/completions";

export interface ZaiVisionResult {
  text: string;
  usage: Usage;
}

/**
 * Fallback extraction for the EMPTY-content class (retry root-cause audit
 * class 3, 2026-07-16): on long multi-image judgments GLM burns the token
 * budget thinking and returns `content: ""` while the drafted verdict sits
 * complete inside `reasoning_content`. 3/5 acceptance builds shipped with
 * sequence-QA blind on exactly this. Scans the reasoning for top-level
 * `{…}` spans (string-aware, brace-balanced) and returns the LAST one that
 * parses as JSON — the model's final draft. Null when none parses.
 */
export const extractJsonFromReasoning = (reasoning: string): string | null => {
  let best: string | null = null;
  let i = 0;
  while (i < reasoning.length) {
    const start = reasoning.indexOf("{", i);
    if (start === -1) break;
    let depth = 0;
    let inStr = false;
    let end = -1;
    for (let j = start; j < reasoning.length; j++) {
      const ch = reasoning[j];
      if (inStr) {
        if (ch === "\\") j++;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end === -1) break; // unbalanced tail — nothing more to find
    const span = reasoning.slice(start, end + 1);
    try {
      JSON.parse(span);
      best = span; // keep scanning — the LAST parseable object wins
    } catch {
      /* not JSON — keep scanning */
    }
    i = end + 1;
  }
  return best;
};

/**
 * Send ONE screenshot + prompt to GLM-5V-Turbo on the native endpoint. Returns
 * the model text + token usage. Throws on HTTP/timeout error so the advisory
 * vision gate can skip the scene. A 60s AbortController guard guarantees a hung
 * vision call can never wedge a build (these are thinking models — adequate
 * max_tokens, else the budget is spent on reasoning and content comes back empty).
 */
export const callZaiVision = async (
  // ONE image or SEVERAL. Each entry is raw base64 (wrapped into a data URL) OR a
  // full data:/http(s) URL — the QA gate passes screenshot base64, the crawl
  // passes a remote hero/og URL, and the logo agent passes an ARRAY of candidate
  // PNGs for a single multi-image pick.
  image: string | string[],
  prompt: string,
  // disableThinking: GLM-5V-Turbo is a thinking model that, on a terse extraction
  // task, can burn the ENTIRE token budget on reasoning and return empty content.
  // For deterministic extraction (color roles) pass disableThinking:true so it
  // answers directly. Judgment tasks (the QA gate) keep thinking on.
  // timeoutMs: default 60s. The 5-image sequence judgment measurably needs
  // more (retry audit class 3: the 60s guard killed it mid-generation) —
  // that call site passes 120_000.
  // stage: spend-ledger label. Optional — the row is written either way and
  // falls back to the ambient withSpend() context, then "unattributed". Every
  // image attachment used to spend Kimi tokens completely invisibly (the
  // onUsage hook in read-image.ts was never wired through extract-text.ts),
  // which is a verbatim repeat of the bug app/new/actions.ts documents.
  opts: { disableThinking?: boolean; maxTokens?: number; timeoutMs?: number; stage?: string } = {},
): Promise<ZaiVisionResult> => {
  // Sniff the real type from the decoded magic bytes. This wrapped EVERY bare
  // base64 image as image/png unconditionally, so a JPEG went to the provider
  // announcing itself as a PNG — a mislabel that costs nothing until the day a
  // provider believes the label, and then the whole vision layer is blind for
  // reasons no log explains. Given the history here (an Anthropic-compat proxy
  // silently dropping image blocks), the image wire says what it is.
  const sniffMime = (b64: string): string => {
    const head = Buffer.from(b64.slice(0, 24), "base64");
    if (head.length >= 8 && head.readUInt32BE(0) === 0x89504e47) return "image/png";
    if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
    if (head.length >= 6 && head.subarray(0, 3).toString("latin1") === "GIF") return "image/gif";
    if (head.length >= 12 && head.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
    return "image/png"; // the historical default, and what every caller here sends
  };
  const toUrl = (img: string) =>
    /^(data:|https?:)/i.test(img) ? img : `data:${sniffMime(img)};base64,${img}`;
  const urls = (Array.isArray(image) ? image : [image]).map(toUrl);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60_000);
  const t0 = Date.now();
  try {
    const resp = await fetch(visionUrl(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fireworksKey()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        max_tokens: opts.maxTokens ?? 1200,
        // GLM and Kimi VLMs are thinking models: on terse extraction tasks
        // they burn the budget reasoning (Kimi probe: 294 tokens thinking vs
        // 46 with it off) and can return empty content unless thinking is
        // explicitly disabled. Sent only for GLM/Kimi-family ids — other
        // overrides must never receive the (unknown-to-them) param.
        ...(opts.disableThinking && /glm|kimi/i.test(VISION_MODEL)
          ? { thinking: { type: "disabled" } }
          : {}),
        messages: [
          {
            role: "user",
            content: [
              ...urls.map((url) => ({ type: "image_url", image_url: { url } })),
              { type: "text", text: prompt },
            ],
          },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`fireworks vision ${resp.status}: ${body.slice(0, 200)}`);
    }
    const json = (await resp.json()) as {
      choices?: { message?: { content?: string; reasoning_content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const u = json.usage ?? {};
    const msg = json.choices?.[0]?.message ?? {};
    let text = msg.content ?? "";
    // Empty-content fallback (retry audit class 3): the drafted verdict often
    // sits complete inside reasoning_content when thinking ate the budget.
    if (!text.trim() && typeof msg.reasoning_content === "string" && msg.reasoning_content.trim()) {
      text = extractJsonFromReasoning(msg.reasoning_content) ?? "";
    }
    // Ledger write at the transport, not the six call sites (QA gate ×2,
    // design-language, brand colors, logo agent, document image OCR). Two of
    // those six recorded nothing at all before this line existed.
    void recordSpend({
      model: VISION_MODEL,
      stage: opts.stage,
      defaultStage: "vision",
      inputTokens: u.prompt_tokens ?? 0,
      outputTokens: u.completion_tokens ?? 0,
      latencyMs: Date.now() - t0,
    });
    return {
      text,
      usage: {
        ...EMPTY_USAGE,
        input_tokens: u.prompt_tokens ?? 0,
        output_tokens: u.completion_tokens ?? 0,
      },
    };
  } catch (err) {
    // The 60s guard aborting a thinking model mid-generation is billed and
    // unmeasurable, exactly like the cast transport's timeout. Zero tokens,
    // never an estimate — the marker exists so the count is honest. A 4xx/5xx
    // from the provider is rethrown without a row for the same reason castCall
    // does not record one: rejected, not served.
    if (!(err instanceof Error) || !/^fireworks vision \d/.test(err.message)) {
      void recordSpend({
        model: VISION_MODEL,
        stage: opts.stage,
        defaultStage: "vision",
        ok: false,
        tokensUnknown: true,
        latencyMs: Date.now() - t0,
      });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Text-only native GLM-5V-Turbo call (no image). Used by the brand-color
 * fidelity backstop: the model's brand-color knowledge is reliable ONLY when
 * there's no image to anchor to (with a frame present it parrots the frame's
 * color). thinking-disabled by default (terse knowledge task burns the budget
 * reasoning otherwise). Same 60s guard + usage mapping as callZaiVision.
 */
export const callZaiText = async (
  prompt: string,
  opts: { disableThinking?: boolean; maxTokens?: number; stage?: string } = {},
): Promise<ZaiVisionResult> => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  const t0 = Date.now();
  try {
    const resp = await fetch(visionUrl(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fireworksKey()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        max_tokens: opts.maxTokens ?? 600,
        ...(opts.disableThinking && /glm|kimi/i.test(VISION_MODEL)
          ? { thinking: { type: "disabled" } }
          : {}),
        messages: [{ role: "user", content: prompt }],
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`fireworks text ${resp.status}: ${body.slice(0, 200)}`);
    }
    const json = (await resp.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const u = json.usage ?? {};
    // callZaiText is a SEPARATE door from callZaiVision — its own exported
    // function with its own fetch in the same file. "Instrument the vision
    // transport" reads as one function and is two; hooking only the other one
    // would have left the brand-colour backstop unrecorded.
    void recordSpend({
      model: VISION_MODEL,
      stage: opts.stage,
      defaultStage: "vision-text",
      inputTokens: u.prompt_tokens ?? 0,
      outputTokens: u.completion_tokens ?? 0,
      latencyMs: Date.now() - t0,
    });
    return {
      text: json.choices?.[0]?.message?.content ?? "",
      usage: {
        ...EMPTY_USAGE,
        input_tokens: u.prompt_tokens ?? 0,
        output_tokens: u.completion_tokens ?? 0,
      },
    };
  } catch (err) {
    if (!(err instanceof Error) || !/^fireworks text \d/.test(err.message)) {
      void recordSpend({
        model: VISION_MODEL,
        stage: opts.stage,
        defaultStage: "vision-text",
        ok: false,
        tokensUnknown: true,
        latencyMs: Date.now() - t0,
      });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
};
