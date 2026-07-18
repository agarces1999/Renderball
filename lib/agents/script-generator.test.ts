/**
 * Tests for the script-generator PROVIDER SWITCH (Part A of the fusefinance
 * migration): production script generation moved OFF z.ai (single point of
 * failure — [1113] "insufficient balance" killed the build at script-gen) ONTO
 * Fireworks GLM-5.2 via castCall. The parse/validate/repair loop is unchanged;
 * only the transport is provider-configurable.
 *
 * What's under test (the things that would silently break a real migration):
 *   - the provider resolves to fireworks by DEFAULT, zai only on explicit opt-in
 *   - the fireworks transport reaches the Fireworks wire with the right model,
 *     json mode, bounded-thinking effort, max_tokens, and maps usage back
 *   - the repair-loop history flattens correctly into castCall's single user turn
 *   - the loop is transport-agnostic: an injected transport drives the SAME
 *     validate/repair/usage path (proving the zai path's loop is unchanged)
 */
import {
  resolveScriptProvider,
  flattenHistoryToUser,
  fireworksScriptTransport,
  generateScript,
  buildUserMessage,
  type ScriptMsg,
  type ScriptTransport,
  type AgentBrief,
} from "./script-generator";
import { SCRIPT_GENERATOR_SYSTEM_PROMPT } from "./prompts/script-generator";
import { validateScript } from "./schema-validator";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("script-generator (provider switch — z.ai → Fireworks GLM-5.2)");

const realFetch = globalThis.fetch;
type Handler = (url: string, init: RequestInit) => Response;
const mockFetch = (handler: Handler) => {
  globalThis.fetch = ((url: string, init: RequestInit) => Promise.resolve(handler(url, init))) as typeof fetch;
};
const fwOk = (text: string, usage = { prompt_tokens: 111, completion_tokens: 222 }) =>
  new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: "stop" }], usage }), { status: 200 });

delete process.env.RB_SCRIPT_PROVIDER;
delete process.env.RB_SCRIPT_MODEL;
process.env.RB_FIREWORKS_KEY = "fw-test-key";

// ── provider resolution ──────────────────────────────────────────────────────
await check("provider defaults to fireworks (off the z.ai SPOF)", () => {
  delete process.env.RB_SCRIPT_PROVIDER;
  assert(resolveScriptProvider() === "fireworks", "unset must default to fireworks");
});

await check("RB_SCRIPT_PROVIDER=zai selects the legacy path; case-insensitive; unknown → fireworks", () => {
  process.env.RB_SCRIPT_PROVIDER = "zai";
  assert(resolveScriptProvider() === "zai", "'zai' → zai");
  process.env.RB_SCRIPT_PROVIDER = "  ZAI ";
  assert(resolveScriptProvider() === "zai", "whitespace/case-insensitive 'ZAI' → zai");
  process.env.RB_SCRIPT_PROVIDER = "fireworks";
  assert(resolveScriptProvider() === "fireworks", "'fireworks' → fireworks");
  process.env.RB_SCRIPT_PROVIDER = "openai";
  assert(resolveScriptProvider() === "fireworks", "unknown value falls back to fireworks (never silently zai)");
  delete process.env.RB_SCRIPT_PROVIDER;
});

// ── history flattening (repair loop → single castCall user turn) ─────────────
await check("flattenHistoryToUser: first attempt = just the brief (byte-identical)", () => {
  assert(flattenHistoryToUser([{ role: "user", content: "THE BRIEF" }]) === "THE BRIEF", "single turn is the brief verbatim");
  assert(flattenHistoryToUser([]) === "", "empty history → empty string");
});

await check("flattenHistoryToUser: retries fold the rejected output + correction into one turn", () => {
  const flat = flattenHistoryToUser([
    { role: "user", content: "THE BRIEF" },
    { role: "assistant", content: "BAD_OUTPUT" },
    { role: "user", content: "FIX THIS" },
  ]);
  assert(flat.includes("THE BRIEF") && flat.includes("BAD_OUTPUT") && flat.includes("FIX THIS"), "all three turns present");
  assert(/rejected; see the correction below/.test(flat), "rejected-response marker wraps the assistant turn");
  assert(flat.indexOf("THE BRIEF") < flat.indexOf("BAD_OUTPUT") && flat.indexOf("BAD_OUTPUT") < flat.indexOf("FIX THIS"), "order preserved");
});

// ── fireworks transport wire (through the real castCall) ─────────────────────
await check("fireworks transport → Fireworks wire: model, json, bounded-thinking effort, max_tokens, prompt, usage", async () => {
  let sentUrl = ""; let sent: Record<string, unknown> = {}; let auth = "";
  mockFetch((url, init) => {
    sentUrl = String(url);
    auth = String((init.headers as Record<string, string>).authorization);
    sent = JSON.parse(String(init.body));
    return fwOk("{}");
  });
  const history: ScriptMsg[] = [{ role: "user", content: "USER-BRIEF-BODY" }];
  const r = await fireworksScriptTransport(history);
  assert(sentUrl.includes("api.fireworks.ai/inference/v1"), "hits the Fireworks endpoint");
  assert(auth === "Bearer fw-test-key", "uses RB_FIREWORKS_KEY");
  assert(sent.model === "accounts/fireworks/routers/glm-5p2-fast", `default script model is the GLM-5.2 Fast router, got ${String(sent.model)}`);
  assert(sent.max_tokens === 16000 && !("max_completion_tokens" in sent), "16k output cap via max_tokens (Fireworks, no TPM pre-debit)");
  assert((sent.response_format as { type?: string })?.type === "json_object", "json:true → response_format json_object (script is a JSON contract)");
  const th = sent.thinking as { type?: string; budget_tokens?: number };
  assert(th?.type === "enabled" && th.budget_tokens === 8192, "effort high → bounded thinking budget 8192, not a bare reasoning_effort");
  const msgs = sent.messages as { role: string; content: string }[];
  assert(msgs[0].role === "system" && msgs[0].content === SCRIPT_GENERATOR_SYSTEM_PROMPT, "system message is the SCRIPT_GENERATOR_SYSTEM_PROMPT verbatim");
  assert(msgs[1].role === "user" && msgs[1].content === "USER-BRIEF-BODY", "user message is the flattened history");
  assert(r.usage.input_tokens === 111 && r.usage.output_tokens === 222, "usage mapped: prompt→input, completion→output");
  assert(r.usage.cache_creation_input_tokens === 0 && r.usage.cache_read_input_tokens === 0, "cache token slots zeroed (no cache breakdown on the cast wire)");
});

await check("RB_SCRIPT_MODEL overrides the default fireworks model", async () => {
  process.env.RB_SCRIPT_MODEL = "accounts/fireworks/models/glm-5p2";
  let sent: Record<string, unknown> = {};
  mockFetch((_url, init) => { sent = JSON.parse(String(init.body)); return fwOk("{}"); });
  await fireworksScriptTransport([{ role: "user", content: "x" }]);
  assert(sent.model === "accounts/fireworks/models/glm-5p2", "RB_SCRIPT_MODEL reaches the wire");
  delete process.env.RB_SCRIPT_MODEL;
});

globalThis.fetch = realFetch;

// ── loop is transport-agnostic: injected transport drives the real loop ──────
// A minimal but FULLY VALID script (grounded, rich, cold-open clean). Built
// here so the happy-path test proves usage maps into the ok:true return and the
// validate/grounding/richness guards all still run identically.
const VALID_SCRIPT = {
  config: { duration_seconds: 12, aspect_ratio: "16:9" },
  brief: {},
  assets: { images: [], fonts: [] },
  scenes: [
    {
      start_seconds: 0,
      end_seconds: 4,
      label: "The wait",
      register: "split",
      visual_concept:
        "A split panel frames a loan application on the left with labeled input fields, a status sidebar and a progress bar on the right; the accent bar sweeps across the divider at 2.8s while a cursor settles into the amount field and the review rows fill in.",
      content: { headline: "You wait days just to hear back on a loan", asset_ids: [] },
    },
    {
      start_seconds: 4,
      end_seconds: 8,
      label: "The black box",
      register: "list",
      visual_concept:
        "A vertical list of three status cards steps through the review stages, each card carrying an icon, a timestamp label and a checkmark; the third card's badge flips to a bright approved chip at 3.1s as a thin divider line draws beneath the stack.",
      content: { headline: "The whole review feels like a black box", asset_ids: [] },
    },
    {
      start_seconds: 8,
      end_seconds: 12,
      label: "The answer",
      register: "centered",
      visual_concept:
        "A centered dashboard tile confirms the approval with a bold checkmark, a summary row and two labeled metric fields; the confirmation ring expands around the tile at 2.6s and a slim divider underlines the final amount.",
      content: { headline: "See your decision in minutes, not days", asset_ids: [] },
    },
  ],
};

const validBrief: AgentBrief = {
  duration_seconds: 12,
  moment_count: 3,
  freeform_prompt: "Loan approvals that once dragged on for days now finish in minutes.",
};

await check("fixture sanity: the crafted script passes validateScript (richness on)", () => {
  const v = validateScript(VALID_SCRIPT, {});
  assert(v.ok, `fixture must be valid so the happy-path test is meaningful — got: ${v.ok ? "" : v.error}`);
});

await check("injected transport happy path: valid script → ok, usage mapped, ONE call", async () => {
  let calls = 0;
  const transport: ScriptTransport = async () => {
    calls++;
    return {
      text: JSON.stringify(VALID_SCRIPT),
      usage: { input_tokens: 1234, output_tokens: 567, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    };
  };
  const r = await generateScript(validBrief, "brief_test", { transport });
  assert(r.ok, `expected ok, got: ${r.ok ? "" : r.error}`);
  if (r.ok) {
    assert(r.usage.input_tokens === 1234 && r.usage.output_tokens === 567, "transport usage maps into the result");
    assert(r.script.scenes.length === 3, "the parsed script survives the loop");
  }
  assert(calls === 1, `a valid first attempt makes exactly one transport call, got ${calls}`);
});

await check("injected transport repair loop: bad JSON every attempt → MAX_ATTEMPTS calls, correction fed back, ok:false", async () => {
  const historyLens: number[] = [];
  const transport: ScriptTransport = async (history) => {
    historyLens.push(history.length);
    return {
      text: "this is not valid json {{{",
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    };
  };
  const r = await generateScript(validBrief, "brief_test", { transport });
  assert(!r.ok, "malformed output every attempt must fail");
  if (!r.ok) assert(/Schema validation failed after 3 attempts/.test(r.error), `final error names the attempt exhaustion, got: ${r.error}`);
  assert(historyLens.length === 3, `the loop runs MAX_ATTEMPTS (3) times regardless of provider, got ${historyLens.length}`);
  assert(historyLens[0] === 1 && historyLens[1] === 3 && historyLens[2] === 5, `each retry feeds the correction back (history grows 1→3→5), got ${JSON.stringify(historyLens)}`);
});

// ── R4 (audit-3): the copy-language directive binds on-screen copy to the market ──
await check("buildUserMessage: emits the HARD copy-language directive when a brand extract is present", () => {
  const brief: AgentBrief = {
    duration_seconds: 12,
    moment_count: 3,
    freeform_prompt: "Pedí lo que quieras.",
    brand_extract: {
      url: "https://www.rappi.com",
      title: "Rappi",
      headlines: ["Pedí lo que quieras"],
      body_excerpts: ["Envío gratis en tu primer pedido"],
      site_lang: "es",
      ok: true,
    },
  };
  const msg = buildUserMessage(brief);
  assert(/LANGUAGE \(HARD\)/.test(msg), "the hard language directive must be present");
  assert(/SAME language as the site copy quoted above/.test(msg), "directive anchors to the quoted site copy");
  assert(/diegetic mock label/.test(msg), "directive covers diegetic mock labels");
  assert(/site language is "es"/.test(msg), "threads site_lang when present");
  assert(/illustrate STRUCTURE, not language/.test(msg), "clarifies the English examples are structural");
});

await check("buildUserMessage: the directive fires even without a site_lang (anchored to quoted copy)", () => {
  const brief: AgentBrief = {
    duration_seconds: 12,
    moment_count: 3,
    freeform_prompt: "x",
    brand_extract: { url: "https://ex.com", title: "Ex", headlines: ["Hello"], body_excerpts: ["World"], ok: true },
  };
  const msg = buildUserMessage(brief);
  assert(/LANGUAGE \(HARD\)/.test(msg), "directive present without site_lang");
  assert(!/site language is/.test(msg), "no site_lang clause when absent");
});

await check("buildUserMessage: no brand extract → no copy-language directive (nothing to bind to)", () => {
  const msg = buildUserMessage({ duration_seconds: 12, moment_count: 3, freeform_prompt: "x" });
  assert(!/LANGUAGE \(HARD\)/.test(msg), "no directive when there is no brand copy to match");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
