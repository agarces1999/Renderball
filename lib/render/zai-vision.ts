/**
 * z.ai NATIVE vision call (GLM-5V-Turbo).
 *
 * CRITICAL endpoint distinction: z.ai's Anthropic-compatibility endpoint
 * (`/api/anthropic`, what `getAnthropic()` uses) SILENTLY DROPS image blocks —
 * any screenshot sent through the SDK client is invisible to the model, so it
 * hallucinates (verified 2026-06-21: GLM called a vivid green frame "Blue", and
 * GLM-4.5V invented a "THE NEW YORK TIMES" headline). The NATIVE paas endpoint
 * (`/api/paas/v4/chat/completions`, OpenAI `image_url` format) passes images
 * correctly — GLM-5V-Turbo then reads scenes accurately. So all real vision MUST
 * go through THIS helper, not the SDK client.
 *
 * Self-contained env reading (does NOT touch getAnthropic's hot path): the loop
 * builds depend on getAnthropic(), so this duplicates the small key/base-url
 * resolution rather than refactoring it.
 */
import { readFileSync } from "fs";
import path from "path";
import { VISION_MODEL } from "../anthropic";
import { EMPTY_USAGE, type Usage } from "../usage";

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

const zaiKey = (): string => {
  const k = process.env.ANTHROPIC_API_KEY?.trim() || readEnvLocal("ANTHROPIC_API_KEY");
  if (!k) throw new Error("ANTHROPIC_API_KEY not set (z.ai vision)");
  return k;
};

/** Derive the native chat/completions URL from the configured z.ai host. */
const zaiNativeUrl = (): string => {
  const base = readEnvLocal("ANTHROPIC_BASE_URL") || process.env.ANTHROPIC_BASE_URL?.trim();
  if (base) {
    const host = base.replace(/\/api\/anthropic\/?$/, "").replace(/\/$/, "");
    return `${host}/api/paas/v4/chat/completions`;
  }
  return "https://api.z.ai/api/paas/v4/chat/completions";
};

export interface ZaiVisionResult {
  text: string;
  usage: Usage;
}

/**
 * Send ONE screenshot + prompt to GLM-5V-Turbo on the native endpoint. Returns
 * the model text + token usage. Throws on HTTP/timeout error so the advisory
 * vision gate can skip the scene. A 60s AbortController guard guarantees a hung
 * vision call can never wedge a build (these are thinking models — adequate
 * max_tokens, else the budget is spent on reasoning and content comes back empty).
 */
export const callZaiVision = async (
  imageBase64: string,
  prompt: string,
): Promise<ZaiVisionResult> => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const resp = await fetch(zaiNativeUrl(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${zaiKey()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        max_tokens: 1200,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${imageBase64}` },
              },
              { type: "text", text: prompt },
            ],
          },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`z.ai vision ${resp.status}: ${body.slice(0, 200)}`);
    }
    const json = (await resp.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const u = json.usage ?? {};
    return {
      text: json.choices?.[0]?.message?.content ?? "",
      usage: {
        ...EMPTY_USAGE,
        input_tokens: u.prompt_tokens ?? 0,
        output_tokens: u.completion_tokens ?? 0,
      },
    };
  } finally {
    clearTimeout(timer);
  }
};
