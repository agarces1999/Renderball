/**
 * Tests for the cast provider transport — mocked fetch, no network.
 * The behaviors under test are the ones that would silently corrupt a real
 * run: effort dial reaching the wire, the pre-debit param name, 429/retry
 * discipline (honor retry-after, don't retry client errors), usage mapping,
 * and the model id selecting the wire — the Fireworks GLM-5.2 fast-router
 * default vs the Cerebras bake-off wire — with the matching key contract
 * (RB_FIREWORKS_KEY vs RB_CAST_KEY, per 3839765).
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

console.log("cast-provider (OpenAI-wire transport: Fireworks default + Cerebras bake-off)");

// The default model is the Fireworks fast router; Cerebras is reached only by
// pinning a non-namespaced model. Tests that exercise Cerebras-wire params pin
// CEREBRAS_MODEL explicitly instead of relying on a default that moved.
const FW_DEFAULT = "accounts/fireworks/routers/glm-5p2-fast";
const CEREBRAS_MODEL = "gpt-oss-120b";

// The runner imports every test file into one process — restore what we touch.
const savedEnv: Record<string, string | undefined> = {
  RB_CAST_KEY: process.env.RB_CAST_KEY,
  RB_FIREWORKS_KEY: process.env.RB_FIREWORKS_KEY,
  RB_CAST_BASE_URL: process.env.RB_CAST_BASE_URL,
  RB_CAST_MODEL: process.env.RB_CAST_MODEL,
};
process.env.RB_CAST_KEY = "test-key";
process.env.RB_FIREWORKS_KEY = "fw-test-key";
delete process.env.RB_CAST_BASE_URL;
delete process.env.RB_CAST_MODEL;

await check("unconfigured provider fails fast and loud; castConfigured is wire-aware", async () => {
  // Fireworks default → RB_FIREWORKS_KEY decides; RB_CAST_KEY alone must not
  // count (the pre-pivot contract this suite used to encode).
  delete process.env.RB_FIREWORKS_KEY;
  try {
    assert(!castConfigured(), "castConfigured must be false without the default wire's key (RB_CAST_KEY doesn't cover Fireworks)");
    let threw: unknown = null;
    try { await castCall({ system: "", user: "x", maxTokens: 100 }); } catch (e) { threw = e; }
    assert(threw instanceof CastProviderError && !threw.retryable && /RB_FIREWORKS_KEY/.test(threw.message), "non-retryable config error naming RB_FIREWORKS_KEY");
  } finally {
    process.env.RB_FIREWORKS_KEY = "fw-test-key";
  }
  // Cerebras leg of the same contract: with the default pointed at the
  // bake-off wire, RB_CAST_KEY decides and the Fireworks key must not count.
  process.env.RB_CAST_MODEL = CEREBRAS_MODEL;
  delete process.env.RB_CAST_KEY;
  try {
    assert(!castConfigured(), "castConfigured must be false for a Cerebras default without RB_CAST_KEY (RB_FIREWORKS_KEY doesn't cover Cerebras)");
  } finally {
    process.env.RB_CAST_KEY = "test-key";
    delete process.env.RB_CAST_MODEL;
  }
});

await check("effort dial + max_completion_tokens reach the wire verbatim", async () => {
  let sent: Record<string, unknown> = {};
  mockFetch((_url, init) => {
    sent = JSON.parse(String(init.body));
    return ok(completion("<div />"));
  });
  // The Cerebras params are the subject here — pin the bake-off model
  // explicitly (the default routes to Fireworks since 3839765).
  await castCall({ system: "sys", user: "usr", maxTokens: 4000, effort: "low", model: CEREBRAS_MODEL });
  assert(sent.reasoning_effort === "low", "reasoning_effort must be sent — dropping it reruns M0's mistake");
  assert(sent.max_completion_tokens === 4000, "pre-debit param must be max_completion_tokens");
  assert(!("max_tokens" in sent), "must NOT send max_tokens alongside it");
  assert(sent.model === CEREBRAS_MODEL, "pinned model reaches the wire");
  const msgs = sent.messages as { role: string }[];
  assert(msgs[0].role === "system" && msgs[1].role === "user", "system + user roles");
});

await check("model override reaches the wire (call.model → RB_CAST_MODEL → Fireworks default)", async () => {
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
  assert(sent.model === FW_DEFAULT, "no override, no env → the Fireworks GLM-5.2 fast-router default");
});

await check("omitted effort omits the param on both wires (model default, not a guess)", async () => {
  let sent: Record<string, unknown> = {};
  mockFetch((_url, init) => {
    sent = JSON.parse(String(init.body));
    return ok(completion("x"));
  });
  await castCall({ system: "", user: "u", maxTokens: 100, model: CEREBRAS_MODEL });
  assert(!("reasoning_effort" in sent), "Cerebras wire: no reasoning_effort key when unset");
  await castCall({ system: "", user: "u", maxTokens: 100 });
  assert(!("thinking" in sent), "Fireworks wire (default model): no thinking key when unset");
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

await check("Fireworks model routes to Fireworks wire: url, key, max_tokens, thinking mapping", async () => {
  process.env.RB_FIREWORKS_KEY = "fw-test-key";
  let sentUrl = ""; let sent: Record<string, unknown> = {}; let auth = "";
  mockFetch((url, init) => {
    sentUrl = String(url);
    auth = String((init.headers as Record<string, string>).authorization);
    sent = JSON.parse(String(init.body));
    return ok(completion("<div />"));
  });
  await castCall({ system: "s", user: "u", maxTokens: 4000, effort: "none", model: "accounts/fireworks/models/glm-5p2" });
  assert(sentUrl.includes("api.fireworks.ai/inference/v1"), "fireworks URL");
  assert(auth === "Bearer fw-test-key", "fireworks key used, not RB_CAST_KEY");
  assert(sent.max_tokens === 4000 && !("max_completion_tokens" in sent), "fireworks uses max_tokens");
  const th = sent.thinking as { type?: string };
  assert(th?.type === "disabled", "effort none → thinking disabled (the smoke-verified off switch)");
  assert(!("reasoning_effort" in sent), "bare reasoning_effort never sent to Fireworks (CoT leaks into content)");
  await castCall({ system: "s", user: "u", maxTokens: 4000, effort: "high", model: "accounts/fireworks/models/glm-5p2" });
  const th2 = sent.thinking as { type?: string; budget_tokens?: number };
  assert(th2?.type === "enabled" && th2.budget_tokens === 8192, "effort high → bounded thinking budget");
});

await check("json flag maps to response_format json_object on both wires; absent otherwise", async () => {
  process.env.RB_FIREWORKS_KEY = "fw-test-key";
  let sent: Record<string, unknown> = {};
  mockFetch((_url, init) => {
    sent = JSON.parse(String(init.body));
    return ok(completion("{}"));
  });
  await castCall({ system: "", user: "u", maxTokens: 100, json: true, effort: "none", model: "accounts/fireworks/models/glm-5p2" });
  assert((sent.response_format as { type?: string })?.type === "json_object", "fireworks wire carries response_format");
  await castCall({ system: "", user: "u", maxTokens: 100, json: true, model: CEREBRAS_MODEL });
  assert((sent.response_format as { type?: string })?.type === "json_object", "cerebras wire carries response_format");
  await castCall({ system: "", user: "u", maxTokens: 100 });
  assert(!("response_format" in sent), "no response_format unless asked — element TSX must stay unconstrained");
});

await check("Fireworks model without RB_FIREWORKS_KEY fails fast, names the missing key", async () => {
  const saved = process.env.RB_FIREWORKS_KEY;
  delete process.env.RB_FIREWORKS_KEY;
  try {
    await castCall({ system: "", user: "u", maxTokens: 100, model: "accounts/fireworks/models/glm-5p2" });
    assert(false, "must throw");
  } catch (e) {
    assert(e instanceof CastProviderError && !e.retryable && /RB_FIREWORKS_KEY/.test(e.message), "named config error");
  } finally {
    if (saved) process.env.RB_FIREWORKS_KEY = saved;
  }
});

globalThis.fetch = realFetch;
for (const [k, v] of Object.entries(savedEnv)) {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
