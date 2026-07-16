/**
 * Tests for the cast provider transport — mocked fetch, no network.
 * The behaviors under test are the ones that would silently corrupt a real
 * run: effort dial reaching the wire, the pre-debit param name, 429/retry
 * discipline (honor retry-after, don't retry client errors), usage mapping.
 */
import { castCall, castConfigured, CastProviderError } from "./cast-provider";

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
const ok = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers });
const completion = (text: string, extra: Record<string, unknown> = {}) => ({
  choices: [{ message: { content: text, ...extra }, finish_reason: "stop" }],
  usage: { prompt_tokens: 100, completion_tokens: 42 },
});

console.log("cast-provider (Cerebras OpenAI-wire transport)");

process.env.RB_CAST_KEY = "test-key";
delete process.env.RB_CAST_BASE_URL;
delete process.env.RB_CAST_MODEL;

await check("unconfigured provider fails fast and loud (no silent fallback)", async () => {
  const saved = process.env.RB_CAST_KEY;
  delete process.env.RB_CAST_KEY;
  assert(!castConfigured(), "castConfigured must be false without a key");
  try {
    await castCall({ system: "", user: "x", maxTokens: 100 });
    assert(false, "must throw");
  } catch (e) {
    assert(e instanceof CastProviderError && !e.retryable, "non-retryable config error");
  } finally {
    process.env.RB_CAST_KEY = saved;
  }
});

await check("effort dial + max_completion_tokens reach the wire verbatim", async () => {
  let sent: Record<string, unknown> = {};
  mockFetch((_url, init) => {
    sent = JSON.parse(String(init.body));
    return ok(completion("<div />"));
  });
  await castCall({ system: "sys", user: "usr", maxTokens: 4000, effort: "low" });
  assert(sent.reasoning_effort === "low", "reasoning_effort must be sent — dropping it reruns M0's mistake");
  assert(sent.max_completion_tokens === 4000, "pre-debit param must be max_completion_tokens");
  assert(!("max_tokens" in sent), "must NOT send max_tokens alongside it");
  assert(sent.model === "gpt-oss-120b", "default model");
  const msgs = sent.messages as { role: string }[];
  assert(msgs[0].role === "system" && msgs[1].role === "user", "system + user roles");
});

await check("model override reaches the wire (call.model → RB_CAST_MODEL → default)", async () => {
  let sent: Record<string, unknown> = {};
  mockFetch((_url, init) => {
    sent = JSON.parse(String(init.body));
    return ok(completion("x"));
  });
  await castCall({ system: "", user: "u", maxTokens: 100, model: "zai-glm-4.7" });
  assert(sent.model === "zai-glm-4.7", "explicit call.model must reach the wire");
  process.env.RB_CAST_MODEL = "env-model";
  try {
    await castCall({ system: "", user: "u", maxTokens: 100, model: "override-model" });
    assert(sent.model === "override-model", "call.model beats RB_CAST_MODEL");
    await castCall({ system: "", user: "u", maxTokens: 100 });
    assert(sent.model === "env-model", "no override falls back to RB_CAST_MODEL");
  } finally {
    delete process.env.RB_CAST_MODEL;
  }
  await castCall({ system: "", user: "u", maxTokens: 100 });
  assert(sent.model === "gpt-oss-120b", "no override, no env → the gpt-oss default");
});

await check("omitted effort omits the param (model default, not a guess)", async () => {
  let sent: Record<string, unknown> = {};
  mockFetch((_url, init) => {
    sent = JSON.parse(String(init.body));
    return ok(completion("x"));
  });
  await castCall({ system: "", user: "u", maxTokens: 100 });
  assert(!("reasoning_effort" in sent), "no effort key when unset");
});

await check("429 honors retry-after, then succeeds; usage + reasoning mapped", async () => {
  let calls = 0;
  const t0 = Date.now();
  mockFetch(() => {
    calls++;
    if (calls === 1) return new Response("rate limited", { status: 429, headers: { "retry-after": "0.05" } });
    return ok(completion("body", { reasoning: "brief thought" }));
  });
  const r = await castCall({ system: "", user: "u", maxTokens: 100 });
  assert(calls === 2, `one retry expected, got ${calls}`);
  assert(Date.now() - t0 >= 45, "retry-after must be honored (waited ~50ms)");
  assert(r.text === "body" && r.thinking === "brief thought", "text + reasoning mapped");
  assert(r.inputTokens === 100 && r.outputTokens === 42, "usage mapped");
  assert(r.stopReason === "stop", "finish_reason mapped");
});

await check("client errors (400) do NOT retry — the request is wrong, not the network", async () => {
  let calls = 0;
  mockFetch(() => {
    calls++;
    return new Response(JSON.stringify({ error: { message: "bad param" } }), { status: 400 });
  });
  try {
    await castCall({ system: "", user: "u", maxTokens: 100 });
    assert(false, "must throw");
  } catch (e) {
    assert(e instanceof CastProviderError && e.status === 400 && !e.retryable, "non-retryable 400");
  }
  assert(calls === 1, `no retries on 400, got ${calls} calls`);
});

await check("network failure retries within budget then surfaces the error", async () => {
  let calls = 0;
  mockFetch(() => {
    calls++;
    throw new Error("ECONNRESET");
  });
  try {
    await castCall({ system: "", user: "u", maxTokens: 100 });
    assert(false, "must throw");
  } catch (e) {
    assert(e instanceof CastProviderError && e.retryable, "retryable transport error");
    assert(e instanceof Error && /ECONNRESET/.test(e.message), "underlying cause preserved");
  }
  assert(calls === 5, `4 retries + original = 5 attempts, got ${calls}`);
});

globalThis.fetch = realFetch;
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
