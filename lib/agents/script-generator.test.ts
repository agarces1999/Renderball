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

await check("provider is ALWAYS fireworks — the z.ai path is gone (2026-07-23)", () => {
  process.env.RB_SCRIPT_PROVIDER = "zai";
  assert(resolveScriptProvider() === "fireworks", "'zai' no longer selects anything — fireworks only");
  process.env.RB_SCRIPT_PROVIDER = "openai";
  assert(resolveScriptProvider() === "fireworks", "unknown value → fireworks");
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
  // REGRESSION LOCK: the first build of this directive failed script-gen on Rappi
  // because the model wrote visual_concept in Spanish too, and every visual_concept
  // validator is English-vocabulary. The direction-field carve-out must ship with it.
  assert(/visual_concept`?, the atmosphere\/motion direction/.test(msg), "the direction-field carve-out must be present");
  assert(/stay in ENGLISH/.test(msg), "direction fields must be pinned to English");
  assert(/ONLY to on-screen copy values/.test(msg), "the language rule must be scoped to on-screen copy");
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

// Regression: blank documents carry `moments: []` (a required StoredBrief
// field), and `![]` is FALSE — so the old truthiness check routed every
// "generate every page for me" run down the pre-structured branch, where the
// moment list rendered empty and the user's prompt was dropped entirely. It
// produced a deck from nothing rather than failing, so nothing caught it.
await check("buildUserMessage: an EMPTY moments array is freeform, not pre-structured", () => {
  const msg = buildUserMessage({
    duration_seconds: 30,
    moment_count: 6,
    freeform_prompt: "a pitch deck for a coffee roaster",
    moments: [],
  });
  assert(/FREEFORM brief/.test(msg), "empty moments must take the FREEFORM branch");
  assert(!/PRE-STRUCTURED/.test(msg), "empty moments must NOT claim a pre-structured brief");
  assert(
    !/Moments \(each becomes one scene/.test(msg),
    "must not emit an empty moment list",
  );
});

await check("buildUserMessage: a POPULATED moments array is still pre-structured", () => {
  const msg = buildUserMessage({
    duration_seconds: 30,
    moment_count: 1,
    freeform_prompt: "ignored when structure exists",
    moments: [{ title: "Opening", description: "the hook", creativity: "balanced" }],
  });
  assert(/PRE-STRUCTURED/.test(msg), "real moments must keep the pre-structured branch");
  assert(/Opening/.test(msg), "the moment must appear in the message");
});


// ── scene-level repair ──────────────────────────────────────────────────────
// WHY THIS EXISTS: a rejected outline used to be re-rolled WHOLE — all twelve
// scenes regenerated because one tripped the drawable-noun floor. Measured on
// 1,588 real visual_concepts, 15% land at or under that floor, so a fresh roll
// of twelve scenes breaks a DIFFERENT scene about half the time and three
// attempts compound into a user-visible failure. Repair asks for just the
// flagged scenes and splices them back. The splice is the dangerous part: a
// wrong index silently swaps someone's slides, which is worse than the bug.

await check("scene repair: a bare array of the flagged scenes splices back at the right indexes", async () => {
  // Attempt 1 returns a script whose scene 1 is too thin; attempt 2 answers the
  // repair request with ONE scene, which must land at index 1 and nowhere else.
  const thin = structuredClone(VALID_SCRIPT) as typeof VALID_SCRIPT;
  thin.scenes[1] = { ...thin.scenes[1], visual_concept: "A thing." };
  const good = VALID_SCRIPT.scenes[1];

  let attempt = 0;
  const sent: string[] = [];
  const transport: ScriptTransport = async (history) => {
    attempt++;
    sent.push(String(history[history.length - 1]?.content ?? ""));
    return {
      text: attempt === 1 ? JSON.stringify(thin) : JSON.stringify([good]),
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    };
  };

  const r = await generateScript(validBrief, "brief_test", { transport });
  assert(r.ok, `the repaired script must validate, got: ${r.ok ? "" : r.error}`);
  if (r.ok) {
    assert(r.script.scenes.length === 3, `repair must not change the scene COUNT, got ${r.script.scenes.length}`);
    assert(
      r.script.scenes[1].visual_concept === good.visual_concept,
      "the repaired scene lands at the index that was flagged",
    );
    assert(
      r.script.scenes[0].visual_concept === VALID_SCRIPT.scenes[0].visual_concept &&
        r.script.scenes[2].visual_concept === VALID_SCRIPT.scenes[2].visual_concept,
      "the scenes that were FINE are untouched — the whole point of repairing instead of re-rolling",
    );
  }
  assert(attempt === 2, `one repair round should be enough, took ${attempt} attempts`);
  assert(/scene/i.test(sent[1] ?? ""), "the second turn asks for scenes, not a whole script");
});

await check("scene repair: a mismatched reply costs the ATTEMPT, never the deck", async () => {
  // A model that answers a one-scene repair with two scenes has misunderstood.
  // OBSERVED LIVE (twice in six runs): the bare array was left as the candidate,
  // so the deck became a headless list, the good scenes were destroyed, and the
  // run died on "Missing top-level key: config" — a structural defect invented
  // by the failed repair, which the model was then asked to fix. The base must
  // survive and the ORIGINAL complaint must be what carries forward.
  const thin = structuredClone(VALID_SCRIPT) as typeof VALID_SCRIPT;
  thin.scenes[1] = { ...thin.scenes[1], visual_concept: "A thing." };

  let attempt = 0;
  const transport: ScriptTransport = async () => {
    attempt++;
    return {
      text: attempt === 1
        ? JSON.stringify(thin)
        // Two scenes for a one-scene request: unusable.
        : JSON.stringify([VALID_SCRIPT.scenes[0], VALID_SCRIPT.scenes[1]]),
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    };
  };

  const r = await generateScript(validBrief, "brief_test", { transport });
  assert(!r.ok, "the thin scene was never repaired, so the run still fails");
  if (!r.ok) {
    assert(
      !/Missing top-level key/i.test(r.error),
      `a failed repair must not invent a STRUCTURAL defect — got: ${r.error}`,
    );
    const ev = r.evidence ?? [];
    assert(
      ev.some((e) => e.visual_concept === "A thing."),
      `the base deck must survive so the real offender is still nameable, got ${JSON.stringify(ev)}`,
    );
  }
});

await check("scene repair: a reply that re-emits EVERY scene is taken wholesale", async () => {
  // Not what was asked, but unambiguous — and refusing it would waste a good
  // answer.
  const thin = structuredClone(VALID_SCRIPT) as typeof VALID_SCRIPT;
  thin.scenes[1] = { ...thin.scenes[1], visual_concept: "A thing." };

  let attempt = 0;
  const transport: ScriptTransport = async () => {
    attempt++;
    return {
      text: attempt === 1 ? JSON.stringify(thin) : JSON.stringify(VALID_SCRIPT.scenes),
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    };
  };

  const r = await generateScript(validBrief, "brief_test", { transport });
  assert(r.ok, `a full re-emission is a valid answer, got: ${r.ok ? "" : r.error}`);
  if (r.ok) assert(r.script.scenes.length === 3, "scene count is preserved");
});

await check("failure carries the flagged scenes' own prose as evidence", async () => {
  // A failure used to surface only the validator's complaint, never the text it
  // was counting — so every investigation re-derived it by hand.
  const thin = structuredClone(VALID_SCRIPT) as typeof VALID_SCRIPT;
  thin.scenes[1] = { ...thin.scenes[1], visual_concept: "A quiet mood, softly." };
  const transport: ScriptTransport = async () => ({
    text: JSON.stringify(thin),
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  });

  const r = await generateScript(validBrief, "brief_test", { transport });
  assert(!r.ok, "the thin scene must fail");
  if (!r.ok) {
    const ev = r.evidence ?? [];
    assert(ev.length > 0, "a failure must carry evidence of what was judged");
    assert(
      ev.some((e) => e.visual_concept === "A quiet mood, softly."),
      `evidence must quote the offending prose verbatim, got ${JSON.stringify(ev)}`,
    );
  }
});


await check("a COPY failure (\"Section N …\") repairs the one scene, it does not re-roll the deck", async () => {
  // The validator speaks two vocabularies for the same index: "Scene 4:" for
  // visual rules, "Section 5 content.headline" for copy rules. Repair matched
  // only the first, so a two-sentence headline — a one-line fix — re-rolled
  // every scene and burned all three attempts. Observed on a 12-page outline.
  const twoSentences = structuredClone(VALID_SCRIPT) as typeof VALID_SCRIPT;
  twoSentences.scenes[1] = {
    ...twoSentences.scenes[1],
    content: { ...twoSentences.scenes[1].content, headline: "Narrower than a platform. Deeper than a tool." },
  };

  let attempt = 0;
  const asks: string[] = [];
  const transport: ScriptTransport = async (history) => {
    attempt++;
    asks.push(String(history[history.length - 1]?.content ?? ""));
    return {
      text: attempt === 1 ? JSON.stringify(twoSentences) : JSON.stringify([VALID_SCRIPT.scenes[1]]),
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    };
  };

  const r = await generateScript(validBrief, "brief_test", { transport });
  assert(r.ok, `the repaired copy must validate, got: ${r.ok ? "" : r.error}`);
  // The ask must be a SCENE repair, and must quote the actual complaint.
  const ask = asks[1] ?? "";
  assert(/JSON ARRAY of scene objects/i.test(ask), `expected a scene-repair ask, got: ${ask.slice(0, 160)}`);
  assert(
    /two sentences/i.test(ask),
    `the repair must quote the complaint it is fixing, got: ${ask.slice(0, 300)}`,
  );
});

await check("a BOUNDARY error is never scene-repaired — it is a relationship, not a scene", async () => {
  // Rewriting one scene in isolation cannot fix "previous end_seconds != current
  // start_seconds", so this must fall through to the whole-script retry.
  const broken = structuredClone(VALID_SCRIPT) as typeof VALID_SCRIPT;
  broken.scenes[1] = { ...broken.scenes[1], start_seconds: 99 };

  const asks: string[] = [];
  const transport: ScriptTransport = async (history) => {
    asks.push(String(history[history.length - 1]?.content ?? ""));
    return {
      text: JSON.stringify(broken),
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    };
  };

  const r = await generateScript(validBrief, "brief_test", { transport });
  assert(!r.ok, "the broken timeline must fail");
  const retries = asks.slice(1);
  assert(retries.length > 0, "there must be a retry to inspect");
  assert(
    retries.every((a) => !/JSON ARRAY of scene objects/i.test(a)),
    "a boundary error must NOT be answered with a single-scene repair",
  );
});


await check("a CONVERGING repair earns extra rounds beyond the 3-attempt budget", async () => {
  // Failures concentrate in long-brief x 12-page outlines, where several
  // scenes trip at once and three rolls is simply not many when every roll has
  // to land twelve times. A repair is cheap and cannot break a good scene, so
  // a repair that is still making progress gets more rounds. "Progress" means
  // the flagged set keeps changing — here a different scene each time.
  const thin = (i: number) => {
    const s = structuredClone(VALID_SCRIPT) as typeof VALID_SCRIPT;
    s.scenes[i] = { ...s.scenes[i], visual_concept: "A thing." };
    return s;
  };
  let attempt = 0;
  const transport: ScriptTransport = async () => {
    attempt++;
    // A different scene is broken each round, then finally a clean script.
    const text =
      attempt === 1 ? JSON.stringify(thin(0))
      : attempt === 2 ? JSON.stringify(thin(1))
      : attempt === 3 ? JSON.stringify(thin(2))
      : JSON.stringify(VALID_SCRIPT);
    return { text, usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
  };
  const r = await generateScript(validBrief, "brief_test", { transport });
  assert(attempt > 3, `the loop must run past the base 3 attempts while converging, ran ${attempt}`);
  assert(r.ok, `it should land once the model stops breaking scenes, got: ${r.ok ? "" : r.error}`);
});

await check("a STUCK repair does not earn extra rounds", async () => {
  // Same scene, same complaint, every time. More rounds would only spend the
  // user's time — the extra budget must not be granted.
  const thin = structuredClone(VALID_SCRIPT) as typeof VALID_SCRIPT;
  thin.scenes[1] = { ...thin.scenes[1], visual_concept: "A thing." };
  let attempt = 0;
  const transport: ScriptTransport = async () => {
    attempt++;
    return {
      text: JSON.stringify(thin),
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    };
  };
  const r = await generateScript(validBrief, "brief_test", { transport });
  assert(!r.ok, "a stuck repair still fails");
  assert(attempt <= 4, `a stuck repair must not keep buying rounds, ran ${attempt}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
