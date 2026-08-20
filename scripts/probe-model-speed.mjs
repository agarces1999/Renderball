/**
 * Founder question 2026-08-20: "any faster models on Fireworks with similar
 * quality?" Measure REAL streaming speed on this account for the text-model
 * candidates the /v1/models listing says are callable — TTFT + tokens/sec on
 * a deck-shaped TSX emission prompt. ~600 output tokens per model, a few
 * cents total (declared paid-wire probe, same class as probe-thinking-off).
 *   node scripts/probe-model-speed.mjs
 */
import { readFileSync } from "fs";
const env = Object.fromEntries(
  readFileSync(".env.local", "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]),
);
const KEY = env.RB_FIREWORKS_KEY || process.env.RB_FIREWORKS_KEY;

const CANDIDATES = [
  "accounts/fireworks/routers/glm-5p2-fast", // current default — the baseline
  "accounts/fireworks/routers/kimi-k3-fast",
  "accounts/fireworks/routers/kimi-k2p7-code-fast",
  "accounts/fireworks/models/deepseek-v4-flash-0731",
  "accounts/fireworks/models/minimax-m3",
  "accounts/fireworks/models/nemotron-lightning-3p5-30b-a3b",
];

// Deck-shaped: emit real TSX under constraints, the shape our fills have.
const PROMPT = `Write a React TSX component Section0 for a 1920x1080 presentation slide: a bold headline "Ship the wedge first", a supporting paragraph, and a row of three stat tiles (97%, 12, 4 of 4) with labels, using inline styles only, absolutely positioned within the frame, referencing const FONT_DISPLAY and PALETTE.accent that already exist in scope. Output only the code, no prose.`;

const one = async (model) => {
  const t0 = Date.now();
  let ttft = null;
  let text = "";
  let completionTokens = 0;
  let reasoningSeen = false;
  try {
    const res = await fetch("https://api.fireworks.ai/inference/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: PROMPT }],
        max_tokens: 4000,
        temperature: 0.4,
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
    if (!res.ok) return { model, error: `HTTP ${res.status} ${(await res.text()).slice(0, 90)}` };
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
        let j;
        try { j = JSON.parse(line.slice(6)); } catch { continue; }
        const d = j.choices?.[0]?.delta;
        if (d?.reasoning_content || d?.reasoning) reasoningSeen = true;
        if (d?.content) {
          if (ttft === null) ttft = Date.now() - t0;
          text += d.content;
        }
        if (j.usage?.completion_tokens) completionTokens = j.usage.completion_tokens;
      }
    }
    const total = (Date.now() - t0) / 1000;
    const tokPerSec = completionTokens > 0 ? completionTokens / total : text.length / 4 / total;
    const looksLikeTsx = /Section0|position:\s*["']absolute|FONT_DISPLAY/.test(text);
    return {
      model: model.split("/").pop(),
      ttftMs: ttft,
      totalS: +total.toFixed(1),
      completionTokens,
      tokPerSec: +tokPerSec.toFixed(0),
      thinking: reasoningSeen,
      emittedTsx: looksLikeTsx,
      chars: text.length,
    };
  } catch (e) {
    return { model: model.split("/").pop(), error: String(e.message ?? e).slice(0, 90) };
  }
};

for (const m of CANDIDATES) {
  const r = await one(m);
  console.log(JSON.stringify(r));
}
