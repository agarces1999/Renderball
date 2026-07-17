/**
 * Tests for the z.ai vision transport's parsing behavior — specifically the
 * retry-audit class-3 fixes: the reasoning_content JSON fallback for the
 * empty-content class (3/5 acceptance builds shipped sequence-QA BLIND on
 * it), the configurable timeout, and maxTokens plumbing. `fetch` is mocked —
 * no network, no key needed beyond a dummy env var.
 */
import { callZaiVision, extractJsonFromReasoning } from "./zai-vision";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("zai-vision (parsing fallback + timeout/maxTokens plumbing)");

// ─── extractJsonFromReasoning (unit) ─────────────────────────────────────────

await check("extractJsonFromReasoning: returns the LAST parseable top-level object (the final draft)", () => {
  const reasoning = [
    "Let me assess the frames. First draft: {\"ok\": false, \"issues\": [\"draft\"]} — hmm,",
    "actually the contrast reads fine. Final verdict:",
    '{"ok": true, "issues": []}',
  ].join("\n");
  const r = extractJsonFromReasoning(reasoning);
  assert(r === '{"ok": true, "issues": []}', `expected the final draft, got ${r}`);
});

await check("extractJsonFromReasoning: braces inside strings don't break balancing", () => {
  const reasoning = 'thinking… {"issue": "the {weird} label overlaps", "scene": 2} done';
  const r = extractJsonFromReasoning(reasoning);
  assert(r !== null && JSON.parse(r).scene === 2, `expected the object, got ${r}`);
});

await check("extractJsonFromReasoning: no parseable object → null (prose-only reasoning)", () => {
  assert(extractJsonFromReasoning("I think the scene looks fine overall.") === null, "prose must yield null");
  assert(extractJsonFromReasoning("truncated { \"ok\": tru") === null, "unbalanced/unparseable must yield null");
});

// ─── callZaiVision with a mocked fetch ───────────────────────────────────────

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-key";

interface CapturedRequest { url: string; body: Record<string, unknown>; signal: AbortSignal | null | undefined }
const mockFetch = (payload: unknown) => {
  const captured: CapturedRequest[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      signal: init?.signal,
    });
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { captured, restore: () => { globalThis.fetch = original; } };
};

await check("empty content + JSON verdict in reasoning_content → the fallback extracts it", async () => {
  const mock = mockFetch({
    choices: [{ message: { content: "", reasoning_content: 'Assessing all five frames… final: {"ok": false, "issues": ["scene 3 headline clipped"]}' } }],
    usage: { prompt_tokens: 9000, completion_tokens: 5800 },
  });
  try {
    const r = await callZaiVision("aGk=", "judge the sequence");
    const parsed = JSON.parse(r.text) as { ok: boolean; issues: string[] };
    assert(parsed.ok === false && parsed.issues[0].includes("clipped"), `expected the reasoning verdict, got ${r.text}`);
    assert(r.usage.input_tokens === 9000 && r.usage.output_tokens === 5800, "usage mapped");
  } finally {
    mock.restore();
  }
});

await check("non-empty content wins — reasoning_content is never preferred over a real answer", async () => {
  const mock = mockFetch({
    choices: [{ message: { content: '{"ok": true, "issues": []}', reasoning_content: '{"ok": false, "issues": ["stale draft"]}' } }],
  });
  try {
    const r = await callZaiVision("aGk=", "judge");
    assert(r.text === '{"ok": true, "issues": []}', `content must win, got ${r.text}`);
  } finally {
    mock.restore();
  }
});

await check("empty content + prose-only reasoning → empty text (caller's malformed-verdict path handles it)", async () => {
  const mock = mockFetch({ choices: [{ message: { content: "", reasoning_content: "the frames look consistent to me" } }] });
  try {
    const r = await callZaiVision("aGk=", "judge");
    assert(r.text === "", `expected empty text, got ${JSON.stringify(r.text)}`);
  } finally {
    mock.restore();
  }
});

await check("maxTokens + multi-image payload are wired through; default max_tokens is 1200", async () => {
  const mock = mockFetch({ choices: [{ message: { content: "ok" } }] });
  try {
    await callZaiVision(["aGk=", "aGk="], "judge", { maxTokens: 6000 });
    await callZaiVision("aGk=", "judge");
    assert(mock.captured[0].body.max_tokens === 6000, `maxTokens forwarded, got ${mock.captured[0].body.max_tokens}`);
    const content = (mock.captured[0].body.messages as { content: unknown[] }[])[0].content;
    assert(content.length === 3, `2 images + 1 text expected, got ${content.length}`);
    assert(mock.captured[1].body.max_tokens === 1200, `default cap 1200, got ${mock.captured[1].body.max_tokens}`);
  } finally {
    mock.restore();
  }
});

await check("timeoutMs is honored: a 30ms guard aborts a slow call; the default survives it", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    // Resolve after 120ms unless aborted first.
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, 120);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new DOMException("aborted", "AbortError"));
      });
    });
    return new Response(JSON.stringify({ choices: [{ message: { content: "late-but-fine" } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    let aborted = false;
    try {
      await callZaiVision("aGk=", "judge", { timeoutMs: 30 });
    } catch {
      aborted = true;
    }
    assert(aborted, "a 30ms timeout must abort the 120ms call");
    const ok = await callZaiVision("aGk=", "judge", { timeoutMs: 5000 });
    assert(ok.text === "late-but-fine", "a generous timeout lets the call finish");
  } finally {
    globalThis.fetch = original;
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
