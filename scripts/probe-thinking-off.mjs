/**
 * Can GLM-5.2-fast's thinking be turned OFF via Fireworks? (speed playbook)
 * Four parameter shapes, one tiny prompt each, ~cents total.
 *   node scripts/probe-thinking-off.mjs
 */
import { readFileSync } from "fs";
const env = Object.fromEntries(
  readFileSync(".env.local", "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]),
);
const KEY = env.RB_FIREWORKS_KEY || process.env.RB_FIREWORKS_KEY;
const MODEL = "accounts/fireworks/routers/glm-5p2-fast";
const PROMPT = "Write a 6-word tagline for a coffee brand. Return only the tagline.";

const shapes = [
  ["baseline (nothing)", {}],
  ["reasoning_effort: none", { reasoning_effort: "none" }],
  ["reasoning: {enabled:false}", { reasoning: { enabled: false } }],
  ["chat_template_kwargs enable_thinking=false", { chat_template_kwargs: { enable_thinking: false } }],
  ["extra_body thinking disabled (zai shape)", { thinking: { type: "disabled" } }],
];

for (const [label, extra] of shapes) {
  const t0 = Date.now();
  try {
    const res = await fetch("https://api.fireworks.ai/inference/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        messages: [{ role: "user", content: PROMPT }],
        ...extra,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const ms = Date.now() - t0;
    if (!res.ok) {
      console.log(`✗ ${label}: HTTP ${res.status} ${(await res.text()).slice(0, 140)}`);
      continue;
    }
    const j = await res.json();
    const msg = j.choices?.[0]?.message ?? {};
    const usage = j.usage ?? {};
    const reasoning = msg.reasoning_content ? msg.reasoning_content.length : 0;
    console.log(
      `${reasoning === 0 ? "◎" : "·"} ${label}: ${ms}ms · completion_tokens=${usage.completion_tokens} · reasoning_chars=${reasoning} · text=${JSON.stringify((msg.content ?? "").slice(0, 60))}`,
    );
  } catch (e) {
    console.log(`✗ ${label}: ${e.message ?? e}`);
  }
}
