/**
 * Tests for the image provider transport — mocked fetch, no network.
 * Under test: the two wire shapes (classic SDXL vs flux flumina), resolution
 * bucket mapping (the classic endpoint hard-rejects everything else), retry
 * discipline, and the PNG-or-fail response guard.
 */
import { imageCall, imageConfigured, nearestResolution, ImageProviderError, SDXL_RESOLUTIONS } from "./image-provider";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

const realFetch = globalThis.fetch;
type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
const mockFetch = (handler: Handler) => {
  globalThis.fetch = ((url: string, init: RequestInit) => Promise.resolve(handler(url, init))) as typeof fetch;
};
// Smallest valid-enough PNG: the 8-byte signature + padding.
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const pngResponse = () => new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/png" } });

console.log("image-provider (Fireworks image transport)");

// One shared test process — restore whatever this file touches (see run-tests.mjs).
const SAVED_ENV = {
  RB_FIREWORKS_KEY: process.env.RB_FIREWORKS_KEY,
  RB_IMAGE_MODEL: process.env.RB_IMAGE_MODEL,
};
process.env.RB_FIREWORKS_KEY = "test-key";
delete process.env.RB_IMAGE_MODEL;

await check("unconfigured provider fails fast and loud", async () => {
  const saved = process.env.RB_FIREWORKS_KEY;
  delete process.env.RB_FIREWORKS_KEY;
  assert(!imageConfigured(), "imageConfigured must be false without a key");
  try {
    await imageCall({ prompt: "x", width: 400, height: 300 });
    assert(false, "must throw");
  } catch (e) {
    assert(e instanceof ImageProviderError && !e.retryable, "non-retryable config error");
  } finally {
    process.env.RB_FIREWORKS_KEY = saved;
  }
});

await check("nearestResolution maps arbitrary bounds onto the legal buckets", () => {
  assert(nearestResolution(500, 500).join("x") === "1024x1024", "square → 1024²");
  assert(nearestResolution(1600, 900).join("x") === "1344x768", "16:9 → 1344×768 (1.75, nearest to 1.78)");
  assert(nearestResolution(300, 900).join("x") === "640x1536", "very tall → 640×1536");
  assert(nearestResolution(4000, 1000).join("x") === "1536x640", "very wide → 1536×640");
  for (const [w, h] of SDXL_RESOLUTIONS) {
    const got = nearestResolution(w, h);
    assert(got[0] === w && got[1] === h, `bucket (${w},${h}) must map to itself`);
  }
});

await check("classic wire: image_generation URL, bucketed width/height, PNG accept", async () => {
  let url = "";
  let sent: Record<string, unknown> = {};
  let accept = "";
  mockFetch((u, init) => {
    url = u;
    sent = JSON.parse(String(init.body));
    accept = String((init.headers as Record<string, string>).accept);
    return pngResponse();
  });
  const res = await imageCall({ prompt: "a chart", width: 800, height: 450, seed: 7 });
  // Default flipped to playground-v2-5 on 2026-08-14 (probe: better aesthetics
  // than SDXL at equal latency, same resolution buckets).
  assert(url.includes("/image_generation/accounts/fireworks/models/playground-v2-5-1024px-aesthetic"), `classic endpoint, got ${url}`);
  assert(sent.width === 1344 && sent.height === 768, `16:9 bounds must bucket to 1344×768, got ${sent.width}×${sent.height}`);
  assert(sent.seed === 7, "seed must reach the wire");
  assert(accept === "image/png", "must request PNG");
  assert(res.width === 1344 && res.height === 768, "result reports the bucketed size");
  assert(res.png[0] === 0x89 && res.png[1] === 0x50, "PNG bytes returned");
});

await check("flux wire: flumina workflows URL with aspect_ratio (env-flip ready)", async () => {
  let url = "";
  let sent: Record<string, unknown> = {};
  mockFetch((u, init) => {
    url = u;
    sent = JSON.parse(String(init.body));
    return pngResponse();
  });
  await imageCall({ prompt: "x", width: 1600, height: 900, model: "accounts/fireworks/models/flux-1-schnell-fp8" });
  assert(url.endsWith("/workflows/accounts/fireworks/models/flux-1-schnell-fp8/text_to_image"), `flumina endpoint, got ${url}`);
  assert(sent.aspect_ratio === "16:9", `flux gets an aspect_ratio, got ${sent.aspect_ratio}`);
  assert(!("width" in sent) && !("height" in sent), "flux wire must not send raw width/height");
  assert(sent.num_inference_steps === 4, "schnell runs 4 steps");
});

await check("RB_IMAGE_MODEL env override selects the model", async () => {
  let url = "";
  mockFetch((u) => {
    url = u;
    return pngResponse();
  });
  process.env.RB_IMAGE_MODEL = "accounts/fireworks/models/playground-v2-5-1024px-aesthetic";
  try {
    await imageCall({ prompt: "x", width: 100, height: 100 });
    assert(url.includes("playground-v2-5"), "env model must reach the URL");
  } finally {
    delete process.env.RB_IMAGE_MODEL;
  }
});

await check("429 retries with retry-after honored, then succeeds", async () => {
  let calls = 0;
  mockFetch(() => {
    calls++;
    if (calls === 1) {
      return new Response("slow down", { status: 429, headers: { "retry-after": "0.01" } });
    }
    return pngResponse();
  });
  const res = await imageCall({ prompt: "x", width: 100, height: 100 });
  assert(calls === 2, `one retry after 429, got ${calls} calls`);
  assert(res.png.length > 0, "eventual success returns the PNG");
});

await check("4xx (entitlement 401 / bad request) does NOT burn retries", async () => {
  let calls = 0;
  mockFetch(() => {
    calls++;
    return new Response(JSON.stringify({ error: { message: "Unauthorized" } }), { status: 401 });
  });
  try {
    await imageCall({ prompt: "x", width: 100, height: 100 });
    assert(false, "must throw");
  } catch (e) {
    assert(e instanceof ImageProviderError && !e.retryable && e.status === 401, "non-retryable 401");
    assert(calls === 1, `no retries on 4xx, got ${calls} calls`);
  }
});

await check("a 200 that is not a PNG fails instead of landing on disk", async () => {
  mockFetch(() => new Response(JSON.stringify({ oops: true }), { status: 200, headers: { "content-type": "application/json" } }));
  try {
    await imageCall({ prompt: "x", width: 100, height: 100 });
    assert(false, "must throw");
  } catch (e) {
    assert(e instanceof ImageProviderError && !e.retryable, "non-PNG 200 is a hard error");
    assert(/not a PNG/.test((e as Error).message), "error names the failure");
  }
});

await check("icon knobs reach the classic wire (negative_prompt + cfg_scale)", async () => {
  let sent: Record<string, unknown> = {};
  mockFetch((_u, init) => {
    sent = JSON.parse(String(init?.body));
    return pngResponse();
  });
  await imageCall({
    prompt: "a single flat icon of a rocket",
    negativePrompt: "photo, text, watermark",
    cfgScale: 8,
    width: 1024,
    height: 1024,
  });
  assert(sent.negative_prompt === "photo, text, watermark", "negative_prompt on the wire");
  assert(sent.cfg_scale === 8, "cfg_scale on the wire");
  // Omitted → omitted: the params must not appear as undefined keys.
  await imageCall({ prompt: "p", width: 1024, height: 1024 });
  assert(!("negative_prompt" in sent) && !("cfg_scale" in sent), "knobs absent when unset");
});

globalThis.fetch = realFetch;
for (const [k, v] of Object.entries(SAVED_ENV)) {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
console.log(`\nimage-provider: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
