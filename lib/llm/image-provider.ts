/**
 * Image provider — the Fireworks transport for editor image generation
 * (marquee "Image" mode + anywhere else that needs prompt → PNG buffer).
 *
 * PROBED LIVE 2026-07-23 before integration (see project memory
 * fireworks-image-gen-status): the pivot spec named flux-1-schnell-fp8, but
 * Fireworks deprecated image generation on 2026-06-10 and this account
 * (created 2026-07-16) gets a hard 401 from the flux flumina deployment —
 * request shape verified correct against Fireworks' own flumina README. The
 * classic `image_generation` endpoint still serves SDXL on the same key
 * (~2.2s per 1152×896 PNG), so that is the working default. The flux wire is
 * kept ready: RB_IMAGE_MODEL=accounts/fireworks/models/flux-1-schnell-fp8
 * flips over the day entitlement returns — re-probe before flipping.
 *
 * Transport discipline mirrors lib/llm/cast-provider.ts: bounded retries,
 * retry-after honored, jittered backoff, non-retryable 4xx, AbortSignal
 * timeout. Binary-response wire (Accept: image/png), no SSE.
 *
 * THE FOURTH DOOR. This transport bills PER IMAGE, not per token, and it
 * bypasses both named "choke points" (castCall, callZaiVision) completely. A
 * spend ledger that hooks only the token transports sees none of it — which
 * is why the write below is here and not in lib/edit/insert-element.ts, where
 * it survived until now only because someone hand-wired it.
 */
import { recordSpend } from "../spend/record";

export interface ImageCall {
  prompt: string;
  /** Target box in canvas px — mapped to the nearest resolution the model
   *  actually supports. The caller crops via objectFit, so nearest-aspect is
   *  enough; the generator NEVER controls placement or final size. */
  width: number;
  height: number;
  seed?: number;
  /** Per-call model override. Precedence: call.model → RB_IMAGE_MODEL → SDXL default. */
  model?: string;
  signal?: AbortSignal;
  /** Request timeout override (default 60s — probed SDXL latency is ~2-4s). */
  timeoutMs?: number;
  /** Spend-ledger label; falls back to the ambient withSpend() context. */
  stage?: string;
}

export interface ImageResult {
  png: Buffer;
  model: string;
  /** The resolution actually requested from the model (post bucket-mapping). */
  width: number;
  height: number;
  seconds: number;
}

export class ImageProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ImageProviderError";
  }
}

const DEFAULT_MODEL = "accounts/fireworks/models/stable-diffusion-xl-1024-v1-0";
const MODEL = () => process.env.RB_IMAGE_MODEL || DEFAULT_MODEL;
const KEY = () => process.env.RB_FIREWORKS_KEY || "";

export const imageConfigured = (): boolean => KEY().length > 0;

/** Model ids containing "flux" are flumina server apps with their own wire. */
const isFluxModel = (model: string): boolean => /flux/i.test(model);

/**
 * The classic endpoint accepts ONLY these pairs (enumerated verbatim by its
 * own 400 on anything else, probe 2026-07-23). Spans 0.42–2.4 aspect.
 */
export const SDXL_RESOLUTIONS: readonly [number, number][] = [
  [1024, 1024],
  [1152, 896],
  [896, 1152],
  [1216, 832],
  [832, 1216],
  [1344, 768],
  [768, 1344],
  [1536, 640],
  [640, 1536],
];

/** Flumina takes an aspect-ratio string; the common set FLUX supports. */
const FLUX_RATIOS: readonly [string, number][] = [
  ["1:1", 1],
  ["4:3", 4 / 3],
  ["3:4", 3 / 4],
  ["16:9", 16 / 9],
  ["9:16", 9 / 16],
  ["21:9", 21 / 9],
  ["9:21", 9 / 21],
];

/** Nearest supported resolution by log-aspect distance (symmetric for wide/tall). */
export const nearestResolution = (w: number, h: number): [number, number] => {
  const target = Math.log(Math.max(1, w) / Math.max(1, h));
  let best = SDXL_RESOLUTIONS[0];
  let bestD = Infinity;
  for (const pair of SDXL_RESOLUTIONS) {
    const d = Math.abs(Math.log(pair[0] / pair[1]) - target);
    if (d < bestD) {
      bestD = d;
      best = pair;
    }
  }
  return best;
};

const nearestFluxRatio = (w: number, h: number): string => {
  const target = Math.log(Math.max(1, w) / Math.max(1, h));
  let best = FLUX_RATIOS[0][0];
  let bestD = Infinity;
  for (const [label, ratio] of FLUX_RATIOS) {
    const d = Math.abs(Math.log(ratio) - target);
    if (d < bestD) {
      bestD = d;
      best = label;
    }
  }
  return best;
};

interface Wire {
  url: string;
  body: Record<string, unknown>;
  /** Resolution reported back on the result (flux derives from ratio). */
  size: [number, number];
}

const wireFor = (call: ImageCall, model: string): Wire => {
  if (isFluxModel(model)) {
    const ratio = nearestFluxRatio(call.width, call.height);
    // Flumina picks exact pixels from the ratio; report the request box.
    return {
      url: `https://api.fireworks.ai/inference/v1/workflows/${model}/text_to_image`,
      body: {
        prompt: call.prompt,
        aspect_ratio: ratio,
        num_inference_steps: 4, // schnell is a 4-step distillation
        ...(call.seed !== undefined ? { seed: call.seed } : {}),
      },
      size: [Math.round(call.width), Math.round(call.height)],
    };
  }
  const [w, h] = nearestResolution(call.width, call.height);
  return {
    url: `https://api.fireworks.ai/inference/v1/image_generation/${model}`,
    body: {
      prompt: call.prompt,
      width: w,
      height: h,
      steps: 30,
      ...(call.seed !== undefined ? { seed: call.seed } : {}),
    },
    size: [w, h],
  };
};

/** Same bounded, retry-after-honoring backoff as the cast transport. */
const RETRIES = 4;
const BASE_DELAY_MS = 1500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const retryDelayMs = (attempt: number, retryAfterHeader: string | null): number => {
  const retryAfter = Number(retryAfterHeader);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  return BASE_DELAY_MS * 2 ** attempt * (0.5 + Math.random());
};

/** One image call: prompt → PNG buffer. Throws ImageProviderError on failure. */
export const imageCall = async (call: ImageCall): Promise<ImageResult> => {
  const model = call.model ?? MODEL();
  if (!KEY()) {
    throw new ImageProviderError(
      "image provider not configured (RB_FIREWORKS_KEY missing)",
      null,
      false,
    );
  }
  if (!call.prompt.trim()) {
    throw new ImageProviderError("image prompt is empty", null, false);
  }
  const wire = wireFor(call, model);
  const t0 = Date.now();
  let lastErr: ImageProviderError | null = null;

  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const tAttempt = Date.now();
    let res: Response;
    try {
      res = await fetch(wire.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "image/png",
          authorization: `Bearer ${KEY()}`,
        },
        body: JSON.stringify(wire.body),
        signal: call.signal ?? AbortSignal.timeout(call.timeoutMs ?? 60_000),
      });
    } catch (err) {
      lastErr = new ImageProviderError(
        `image transport error: ${err instanceof Error ? err.message : String(err)}`,
        null,
        true,
      );
      // No Response, so we cannot know whether the render completed and was
      // billed. Zero-cost marker, never a guessed image count — same rule as
      // the cast transport.
      void recordSpend({
        model,
        stage: call.stage,
        defaultStage: "image",
        ok: false,
        tokensUnknown: true,
        latencyMs: Date.now() - tAttempt,
      });
      if (attempt < RETRIES) await sleep(retryDelayMs(attempt, null));
      continue;
    }

    if (res.status === 429 || res.status >= 500) {
      lastErr = new ImageProviderError(
        `image HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`,
        res.status,
        true,
      );
      if (attempt < RETRIES) await sleep(retryDelayMs(attempt, res.headers.get("retry-after")));
      continue;
    }

    if (!res.ok) {
      // 4xx other than 429: our request (or entitlement — flux 401) is wrong;
      // retrying cannot fix it.
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      throw new ImageProviderError(`image HTTP ${res.status}: ${detail}`, res.status, false);
    }

    const contentType = res.headers.get("content-type") ?? "";
    const bytes = Buffer.from(await res.arrayBuffer());
    // A 200 that isn't a PNG (JSON error leaked past the status, HTML edge
    // page) must not be written to disk as an "image".
    const isPng = bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    if (!isPng) {
      throw new ImageProviderError(
        `image response is not a PNG (content-type ${contentType || "unknown"}, ${bytes.length} bytes)`,
        res.status,
        false,
      );
    }

    // A PNG came back, so an image was generated and billed. Token fields stay
    // zero by construction; imageCostUsd (lib/usage.ts) prices `images`.
    void recordSpend({
      model,
      stage: call.stage,
      defaultStage: "image",
      images: 1,
      latencyMs: Date.now() - t0,
    });

    return {
      png: bytes,
      model,
      width: wire.size[0],
      height: wire.size[1],
      seconds: (Date.now() - t0) / 1000,
    };
  }

  throw lastErr ?? new ImageProviderError("image call failed after retries", null, true);
};
