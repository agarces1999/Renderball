/**
 * Alerting — the properties that decide whether anyone acts on it.
 *
 * An alert channel fails in two directions and both are fatal. Too quiet and an
 * outage goes unnoticed, which is the state this project was in: the spend
 * breaker could stop every generation in the product and say so only to a
 * console nobody reads. Too loud and the channel gets muted, which looks
 * exactly like too quiet a week later.
 *
 * So: it must fire, it must repeat-suppress, and it must never — under any
 * failure of the channel itself — throw into the code that called it.
 */
import {
  sendAlert,
  shouldSuppress,
  resetAlertsForTests,
  isAlertingConfigured,
  isEmailAlertingConfigured,
} from "./alert";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => Promise<void> | void) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

/** Capture what would have been posted, without a network. */
const withFetch = async (
  impl: (url: string, init: RequestInit) => Promise<Response> | Response,
  body: () => Promise<void>,
): Promise<{ url: string; payload: Record<string, unknown> }[]> => {
  const calls: { url: string; payload: Record<string, unknown> }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, payload: JSON.parse(String(init?.body ?? "{}")) });
    return impl(u, init ?? {});
  }) as typeof fetch;
  try {
    await body();
  } finally {
    globalThis.fetch = real;
  }
  return calls;
};

const ok = () => new Response("ok", { status: 200 });

const run = async () => {
  console.log("alerting");
  const saved = {
    webhook: process.env.RB_ALERT_WEBHOOK,
    email: process.env.RB_ALERT_EMAIL,
    smtp: process.env.SMTP_URL,
  };
  delete process.env.RB_ALERT_EMAIL;
  delete process.env.SMTP_URL;

  try {
    await check("with nothing configured, alerting is inert but still logs", async () => {
      delete process.env.RB_ALERT_WEBHOOK;
      resetAlertsForTests();
      assert(!isAlertingConfigured(), "no channel → not configured");
      const calls = await withFetch(ok, () => sendAlert({ key: "k", level: "warn", title: "t" }));
      assert(calls.length === 0, "nothing should be posted without a channel");
    });

    await check("email needs BOTH a recipient and a server to count as configured", async () => {
      // Half-configured is the dangerous state: it reads as "alerting is on" in
      // /api/health while delivering nothing.
      delete process.env.RB_ALERT_WEBHOOK;
      process.env.RB_ALERT_EMAIL = "founder@example.test";
      delete process.env.SMTP_URL;
      assert(!isEmailAlertingConfigured(), "a recipient with no SMTP server is not configured");
      assert(!isAlertingConfigured(), "and does not make alerting look live");

      delete process.env.RB_ALERT_EMAIL;
      process.env.SMTP_URL = "smtps://user:pass@smtp.example.test:465";
      assert(!isEmailAlertingConfigured(), "an SMTP server with nobody to mail is not configured");

      process.env.RB_ALERT_EMAIL = "founder@example.test";
      assert(isEmailAlertingConfigured(), "both together → configured");
      assert(isAlertingConfigured(), "and alerting reports itself live");

      delete process.env.RB_ALERT_EMAIL;
      delete process.env.SMTP_URL;
    });

    await check("a broken mail server NEVER throws into the caller", async () => {
      // Same contract as the webhook, and the more likely failure: an expired
      // app password, a blocked port, a provider outage. The build that was
      // already failing must not fail differently because the alert did.
      process.env.RB_ALERT_EMAIL = "founder@example.test";
      process.env.SMTP_URL = "smtps://user:pass@127.0.0.1:1"; // nothing listens here
      resetAlertsForTests();
      await sendAlert({ key: "smtp-boom", level: "critical", title: "t", detail: "d" });
      delete process.env.RB_ALERT_EMAIL;
      delete process.env.SMTP_URL;
    });

    process.env.RB_ALERT_WEBHOOK = "https://hooks.example.invalid/abc";

    await check("a configured webhook receives the alert", async () => {
      resetAlertsForTests();
      const calls = await withFetch(ok, () =>
        sendAlert({ key: "breaker", level: "critical", title: "Generation is DOWN", detail: "Recharge" }),
      );
      assert(calls.length === 1, `expected one post, got ${calls.length}`);
      assert(calls[0].url === "https://hooks.example.invalid/abc", "posts to the configured URL");
      const text = String(calls[0].payload.text ?? "");
      assert(text.includes("Generation is DOWN"), `the title should be in the message: ${text}`);
      assert(text.includes("Recharge"), "the action should be in the message");
    });

    await check("the payload satisfies Slack AND Discord at once", async () => {
      // One env var has to work with whatever channel already exists. Slack
      // reads `text`, Discord reads `content`; each ignores the other's key.
      resetAlertsForTests();
      const calls = await withFetch(ok, () => sendAlert({ key: "x", level: "warn", title: "hello" }));
      assert(typeof calls[0].payload.text === "string", "Slack needs `text`");
      assert(typeof calls[0].payload.content === "string", "Discord needs `content`");
      assert(calls[0].payload.text === calls[0].payload.content, "both carry the same message");
    });

    await check("the same alert does not fire twice in a row", async () => {
      // A flapping breaker must not turn into forty notifications, because a
      // muted channel is indistinguishable from no channel.
      resetAlertsForTests();
      const calls = await withFetch(ok, async () => {
        for (let i = 0; i < 5; i++) {
          await sendAlert({ key: "same", level: "critical", title: "repeat" });
        }
      });
      assert(calls.length === 1, `five identical alerts should post once, got ${calls.length}`);
    });

    await check("DIFFERENT alerts are never suppressed by each other", async () => {
      resetAlertsForTests();
      const calls = await withFetch(ok, async () => {
        await sendAlert({ key: "a", level: "critical", title: "one" });
        await sendAlert({ key: "b", level: "warn", title: "two" });
      });
      assert(calls.length === 2, `two distinct alerts should both post, got ${calls.length}`);
    });

    await check("suppression is a time window, not a permanent mute", async () => {
      resetAlertsForTests();
      await withFetch(ok, () => sendAlert({ key: "windowed", level: "warn", title: "t" }));
      const now = Date.now();
      assert(shouldSuppress("windowed", now), "immediately after firing, suppressed");
      assert(!shouldSuppress("windowed", now + 11 * 60 * 1000), "after the window, allowed again");
      assert(!shouldSuppress("never-fired", now), "an unseen key is never suppressed");
    });

    await check("a broken alert channel NEVER throws into the caller", async () => {
      // The single most important property here. An alert fires from inside the
      // spend breaker, on the error path of a build — if posting it could
      // throw, a monitoring failure would become a second, worse incident.
      resetAlertsForTests();
      const modes: [string, () => never | Promise<Response>][] = [
        ["a network error", () => { throw new Error("ECONNREFUSED"); }],
        ["a rejected promise", () => Promise.reject(new Error("DNS"))],
      ];
      for (const [why, impl] of modes) {
        resetAlertsForTests();
        await withFetch(impl as () => Promise<Response>, async () => {
          await sendAlert({ key: "boom", level: "critical", title: "t" });
        });
      }
      // A non-2xx must also be survivable, and must not be retried into a storm.
      resetAlertsForTests();
      const calls = await withFetch(() => new Response("nope", { status: 500 }), () =>
        sendAlert({ key: "boom2", level: "critical", title: "t" }),
      );
      assert(calls.length === 1, "a 500 from the channel is logged, not retried");
    });
  } finally {
    const restore = (k: string, v: string | undefined) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    restore("RB_ALERT_WEBHOOK", saved.webhook);
    restore("RB_ALERT_EMAIL", saved.email);
    restore("SMTP_URL", saved.smtp);
  }

  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
};

await run();
