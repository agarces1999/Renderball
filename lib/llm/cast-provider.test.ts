/**
 * Tests for the cast provider transport — mocked fetch, no network.
 * The behaviors under test are the ones that would silently corrupt a real
 * run: effort dial reaching the wire, the pre-debit param name, 429/retry
 * discipline (honor retry-after, don't retry client errors), usage mapping,
 * and the model id selecting the wire — the Fireworks GLM-5.2 fast-router
 * default vs the Cerebras bake-off wire — with the matching key contract
 * (RB_FIREWORKS_KEY vs RB_CAST_KEY, per 3839765).
 */
import { castCall, castStream, castConfigured, CastProviderError } from "./cast-provider";
import { __setSpendWriterForTests, flushSpend, type SpendRow } from "../spend/record";
import { withSpend } from "../spend/context";
import { costUsd, EMPTY_USAGE } from "../usage";

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

await check("effort dial + max_completion_tokens reach the Cerebras wire verbatim", async () => {
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
  const r = await castCall({ system: "", user: "u", maxTokens: 100, model: CEREBRAS_MODEL });
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
    await castCall({ system: "", user: "u", maxTokens: 100, model: CEREBRAS_MODEL });
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
    await castCall({ system: "", user: "u", maxTokens: 100, model: CEREBRAS_MODEL });
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
  await castCall({ system: "", user: "u", maxTokens: 100, model: CEREBRAS_MODEL });
  assert(!("response_format" in sent), "no response_format unless asked — element TSX must stay unconstrained");
});

// ─── the spend ledger, recorded INSIDE the transport ─────────────────────────
// The reason these live here and not at a call site: castCall is reached from
// ~15 modules and every one of them would otherwise have to remember. In
// August 2026 they did not — Fireworks billed $37.69 and our records covered
// $6.52. The transport cannot forget.
//
// The runner disarms the ledger process-wide (scripts/run-tests.mjs); these
// checks arm it with an in-memory writer for their own duration.
{
  let rows: SpendRow[] = [];
  const armLedger = () => {
    rows = [];
    delete process.env.RB_SPEND_DISABLE;
    __setSpendWriterForTests(async (r) => { rows.push(r); });
  };
  const disarmLedger = () => {
    __setSpendWriterForTests(null);
    process.env.RB_SPEND_DISABLE = "1";
  };

  await check("a successful call records EXACTLY ONE row with the exact tokens and cost", async () => {
    armLedger();
    try {
      mockFetch(() => ok(completion("<div />")));
      await castCall({ system: "s", user: "u", maxTokens: 100, stage: "outline" });
      assert(rows.length === 1, `expected exactly 1 ledger row, got ${rows.length}`);
      const r = rows[0];
      // Verbatim from the response — 100/42 in `completion()` above. Derived
      // or estimated counts are the failure this whole table exists to end.
      assert(r.inputTokens === 100, `prompt_tokens verbatim, got ${r.inputTokens}`);
      assert(r.outputTokens === 42, `completion_tokens verbatim, got ${r.outputTokens}`);
      assert(r.model === FW_DEFAULT, `the WIRE model id is what gets billed, got ${r.model}`);
      assert(r.stage === "outline", `stage: ${r.stage}`);
      assert(r.ok === true && r.tokensUnknown === false, "a served call is measured, not a marker");
      const expected = costUsd(FW_DEFAULT, { ...EMPTY_USAGE, input_tokens: 100, output_tokens: 42 });
      assert(Math.abs(r.costUsd - expected) < 1e-8, `cost ${r.costUsd} should be ${expected}`);
    } finally {
      disarmLedger();
    }
  });

  await check("cached_tokens are captured off the wire (recorded, not discounted)", async () => {
    armLedger();
    try {
      mockFetch(() =>
        ok({
          choices: [{ message: { content: "x" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 4000 } },
        }),
      );
      await castCall({ system: "", user: "u", maxTokens: 100 });
      assert(rows[0].cachedTokens === 4000, `cached_tokens must reach the ledger, got ${rows[0].cachedTokens}`);
      // Priced at the FULL input rate on purpose: the semantics are unverified
      // on this account and lib/usage.ts errs on overstating, never under.
      const full = costUsd(FW_DEFAULT, { ...EMPTY_USAGE, input_tokens: 5000, output_tokens: 10 });
      assert(Math.abs(rows[0].costUsd - full) < 1e-8, "no silent discount on an unverified rate");
    } finally {
      disarmLedger();
    }
  });

  await check("no stage passed → the ambient build context labels the row", async () => {
    armLedger();
    try {
      mockFetch(() => ok(completion("x")));
      await withSpend({ stage: "build.fill", scriptId: "deck-9" }, () =>
        castCall({ system: "", user: "u", maxTokens: 100 }),
      );
      assert(rows[0].stage === "build.fill", `stage: ${rows[0].stage}`);
      assert(rows[0].scriptId === "deck-9", "cost-per-deck needs the scriptId on every row");
    } finally {
      disarmLedger();
    }
  });

  await check("a REJECTED attempt records nothing; only the served one counts", async () => {
    armLedger();
    try {
      let calls = 0;
      mockFetch(() => {
        calls++;
        if (calls === 1) return new Response("rate limited", { status: 429, headers: { "retry-after": "0.05" } });
        return ok(completion("body"));
      });
      await castCall({ system: "", user: "u", maxTokens: 100, stage: "build" });
      assert(calls === 2, `expected a retry, got ${calls} attempts`);
      // A 429 is the provider refusing to serve — nothing generated, nothing
      // billed. Emitting a marker for it would drown the "we paid and could
      // not measure it" count, which is the one signal here that must stay
      // trustworthy.
      assert(rows.length === 1, `expected 1 row for 2 attempts (1 rejected), got ${rows.length}`);
      assert(rows[0].ok === true, "the row is the SERVED attempt");
    } finally {
      disarmLedger();
    }
  });

  await check("a transport failure records a ZERO-token marker per attempt, never an estimate", async () => {
    armLedger();
    try {
      mockFetch(() => {
        throw new Error("ECONNRESET");
      });
      let threw = false;
      try {
        await castCall({ system: "", user: "u", maxTokens: 100, stage: "build" });
      } catch {
        threw = true;
      }
      assert(threw, "castCall still surfaces the error");
      // 4 retries + the original = 5 attempts, each of which may have been
      // billed for a completion we aborted before reading. Unknowable from our
      // side, forever — so the honest record is a COUNT, not a dollar guess.
      assert(rows.length === 5, `expected 5 markers (one per attempt), got ${rows.length}`);
      assert(rows.every((r) => r.ok === false && r.tokensUnknown === true), "every marker says why it is zero");
      assert(rows.every((r) => r.costUsd === 0), "a marker must never carry a fabricated cost");
      assert(rows.every((r) => r.inputTokens === 0 && r.outputTokens === 0), "no fabricated token counts");
      assert(rows.every((r) => r.latencyMs !== null), "elapsed time is what makes a marker useful");
    } finally {
      disarmLedger();
    }
  });

  await check("a FAILING recorder does not break the user's call", async () => {
    rows = [];
    delete process.env.RB_SPEND_DISABLE;
    // The ledger's disk fallback would fire here; point it somewhere harmless.
    const savedLog = process.env.RB_SPEND_LOG;
    process.env.RB_SPEND_LOG = "/dev/null";
    __setSpendWriterForTests(async () => {
      throw new Error("ledger is on fire");
    });
    // The transport calls `void recordSpend(...)`, so a returned value that
    // merely LOOKS fine is not proof. A rejecting recorder produces an
    // unhandled rejection, which on Node ≥15 terminates the process the user's
    // build is running in — the call "succeeds" and the container dies. This
    // listener is what makes the check real; verified by making recordSpend
    // rethrow and watching this line go red.
    let unhandled: unknown = null;
    const onUnhandled = (e: unknown) => { unhandled = e; };
    process.on("unhandledRejection", onUnhandled);
    try {
      mockFetch(() => ok(completion("the answer")));
      const r = await castCall({ system: "", user: "u", maxTokens: 100 });
      // This is the rule lib/usage.ts states and this module inherits: usage
      // logging must NEVER break the call it is measuring.
      assert(r.text === "the answer", "the call must succeed even when the ledger cannot write");
      assert(r.inputTokens === 100 && r.outputTokens === 42, "and return its usage unharmed");
      await new Promise((res) => setTimeout(res, 20)); // let a rejection surface
      assert(unhandled === null, `the ledger must not crash the caller's process: ${String(unhandled)}`);
      // MUST flush before the env is restored below. The disk fallback resolves
      // RB_SPEND_LOG at write time, not at call time, so an in-flight fallback
      // that lands after the restore writes into the developer's real
      // .data/spend.jsonl. Found the honest way: four phantom rows appeared
      // there after four runs of this file.
      await flushSpend();
    } finally {
      process.off("unhandledRejection", onUnhandled);
      __setSpendWriterForTests(null);
      if (savedLog === undefined) delete process.env.RB_SPEND_LOG;
      else process.env.RB_SPEND_LOG = savedLog;
      process.env.RB_SPEND_DISABLE = "1";
    }
  });

  await check("CONCURRENT calls through the transport lose no rows", async () => {
    armLedger();
    try {
      mockFetch(async () => {
        await new Promise((r) => setTimeout(r, Math.random() * 10));
        return ok(completion("x"));
      });
      const N = 40;
      await Promise.all(
        Array.from({ length: N }, (_, i) =>
          withSpend({ stage: `fill.${i}` }, () => castCall({ system: "", user: "u", maxTokens: 100 })),
        ),
      );
      assert(rows.length === N, `expected ${N} rows, got ${rows.length}`);
      assert(new Set(rows.map((r) => r.stage)).size === N, "each parallel call keeps its own stage");
    } finally {
      disarmLedger();
    }
  });
}

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

await check("two consecutive TIMEOUTS end the ladder early; mixed failures keep it", async () => {
  // Timeout-shaped: fetch rejects with an AbortError/TimeoutError.
  let calls = 0;
  const timeoutErr = () => {
    const e = new Error("The operation was aborted due to timeout");
    e.name = "TimeoutError";
    throw e;
  };
  mockFetch(() => {
    calls++;
    return timeoutErr();
  });
  let threw: unknown = null;
  try {
    await castCall({ system: "", user: "u", maxTokens: 100, model: CEREBRAS_MODEL });
  } catch (e) {
    threw = e;
  }
  assert(threw instanceof CastProviderError, "surfaces as a cast error");
  assert(calls === 2, `wedged request stops after 2 timeouts, got ${calls} attempts`);

  // A timeout FOLLOWED by a different transient failure resets the strike
  // count — only uninterrupted silence is treated as wedged.
  calls = 0;
  mockFetch(() => {
    calls++;
    if (calls === 1) return timeoutErr();
    if (calls === 2) throw new Error("ECONNRESET");
    if (calls === 3) return timeoutErr();
    return ok(completion("recovered"));
  });
  const r = await castCall({ system: "", user: "u", maxTokens: 100, model: CEREBRAS_MODEL });
  assert(r.text === "recovered", "mixed failures still recover within the ladder");
  assert(calls === 4, `full ladder available to mixed failures, got ${calls}`);
});

await check("RB_FIREWORKS_SERVICE_TIER reaches the Fireworks wire; absent when unset", async () => {
  let sent: Record<string, unknown> = {};
  mockFetch((_u, init) => {
    sent = JSON.parse(String(init?.body));
    return ok(completion("x"));
  });
  process.env.RB_FIREWORKS_SERVICE_TIER = "priority";
  try {
    await castCall({ system: "", user: "u", maxTokens: 100 });
    assert(sent.service_tier === "priority", "tier on the wire when set");
  } finally {
    delete process.env.RB_FIREWORKS_SERVICE_TIER;
  }
  await castCall({ system: "", user: "u", maxTokens: 100 });
  assert(!("service_tier" in sent), "field omitted entirely when unset");
});

// ── castStream: the outline ceremony's transport (2026-08-14) ─────────────

/** An SSE Response whose payload arrives in the given raw chunks. */
const sseResponse = (chunks: string[]) => {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
};
const sseFrame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

await check("castStream assembles deltas in order, fires onDelta per fragment, maps usage", async () => {
  mockFetch((_url, init) => {
    const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    assert(sent.stream === true, "stream:true must reach the wire");
    assert(
      typeof sent.stream_options === "object" && (sent.stream_options as { include_usage?: boolean }).include_usage === true,
      "stream_options.include_usage must be requested — without it Fireworks omits the final usage frame",
    );
    return sseResponse([
      sseFrame({ choices: [{ delta: { content: "Hel" } }] }),
      sseFrame({ choices: [{ delta: { content: "lo " } }] }) + sseFrame({ choices: [{ delta: { content: "world" }, finish_reason: "stop" }] }),
      sseFrame({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } }),
      "data: [DONE]\n\n",
    ]);
  });
  const seen: string[] = [];
  const r = await castStream({ system: "s", user: "u", maxTokens: 100 }, (d) => seen.push(d));
  assert(r.text === "Hello world", `assembled text, got ${JSON.stringify(r.text)}`);
  assert(seen.join("|") === "Hel|lo |world", `onDelta per fragment, got ${seen.join("|")}`);
  assert(r.inputTokens === 11 && r.outputTokens === 7, "usage mapped from the final frame");
  assert(r.stopReason === "stop", "finish_reason mapped");
});

await check("castStream reassembles a frame torn across transport chunks", async () => {
  const frame = sseFrame({ choices: [{ delta: { content: "unbroken" } }] });
  const cut = Math.floor(frame.length / 2);
  mockFetch(() =>
    sseResponse([
      frame.slice(0, cut),
      frame.slice(cut),
      sseFrame({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2 } }),
      "data: [DONE]\n\n",
    ]),
  );
  const r = await castStream({ system: "", user: "u", maxTokens: 100 }, () => {});
  assert(r.text === "unbroken", `torn frame must reassemble, got ${JSON.stringify(r.text)}`);
});

await check("castStream retries a 5xx BEFORE any delta, succeeds on the next attempt", async () => {
  let calls = 0;
  mockFetch(() => {
    calls++;
    if (calls === 1) return new Response("upstream sad", { status: 502 });
    return sseResponse([
      sseFrame({ choices: [{ delta: { content: "ok" } }] }),
      sseFrame({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      "data: [DONE]\n\n",
    ]);
  });
  const r = await castStream({ system: "", user: "u", maxTokens: 100 }, () => {});
  assert(calls === 2, `expected retry after pre-stream 502, got ${calls} calls`);
  assert(r.text === "ok", "second attempt's text returned");
});

await check("castStream does NOT retry after text has streamed — a mid-stream death surfaces", async () => {
  let calls = 0;
  mockFetch(() => {
    calls++;
    const enc = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode(sseFrame({ choices: [{ delta: { content: "half an out" } }] })));
          // Deferred: an error in the same turn as the enqueue makes undici
          // drop the buffered chunk, which would simulate a PRE-stream death
          // instead of a mid-stream one.
          setTimeout(() => controller.error(new Error("connection reset mid-stream")), 20);
        },
      }),
      { status: 200 },
    );
  });
  const seen: string[] = [];
  let threw: unknown = null;
  try {
    await castStream({ system: "", user: "u", maxTokens: 100 }, (d) => seen.push(d));
  } catch (e) {
    threw = e;
  }
  assert(threw instanceof CastProviderError, "must throw — the caller decides how to fall back");
  assert(calls === 1, `no silent restart after words reached the user, got ${calls} calls`);
  assert(seen.join("") === "half an out", "the delivered prefix reached onDelta before the death");
});

await check("castStream aborts a SILENT stream at idleMs — the fallback must start fast", async () => {
  let calls = 0;
  mockFetch(() => {
    calls++;
    const enc = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          // One delta, then eternal silence — the mid-stream stall shape that
          // burned the full 300s total timeout live (2026-08-14).
          controller.enqueue(enc.encode(sseFrame({ choices: [{ delta: { content: "started " } }] })));
        },
      }),
      { status: 200 },
    );
  });
  const t0 = Date.now();
  let threw: unknown = null;
  try {
    await castStream({ system: "", user: "u", maxTokens: 100, idleMs: 150 }, () => {});
  } catch (e) {
    threw = e;
  }
  const ms = Date.now() - t0;
  assert(threw instanceof CastProviderError && /idle/.test(threw.message), "idle abort surfaces as a cast error");
  assert(calls === 1, `no silent restart after words streamed, got ${calls} calls`);
  assert(ms < 5_000, `aborted promptly (~idleMs), took ${ms}ms`);
});

await check("castStream survives an onDelta that throws — the paid stream finishes", async () => {
  mockFetch(() =>
    sseResponse([
      sseFrame({ choices: [{ delta: { content: "a" } }] }),
      sseFrame({ choices: [{ delta: { content: "b" } }] }),
      sseFrame({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2 } }),
      "data: [DONE]\n\n",
    ]),
  );
  const r = await castStream({ system: "", user: "u", maxTokens: 100 }, () => {
    throw new Error("sink exploded");
  });
  assert(r.text === "ab", "text still assembled despite the sink throwing");
});

globalThis.fetch = realFetch;
for (const [k, v] of Object.entries(savedEnv)) {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
