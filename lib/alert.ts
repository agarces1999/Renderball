/**
 * Getting told when production breaks.
 *
 * Until now the answer was `console.error`, which in practice means nobody
 * finds out until a user complains — and the loudest thing this app can do,
 * tripping the spend breaker, silently stops ALL generation. That is the exact
 * failure where minutes matter and where a log line in a container nobody is
 * watching is the same as no alert at all.
 *
 * Deliberately NOT an SDK and NOT a vendor. `RB_ALERT_WEBHOOK` takes any HTTPS
 * URL, and the payload is shaped to satisfy Slack and Discord at once: Slack
 * reads `text`, Discord reads `content`, each ignores the other's key. So the
 * founder can point it at whatever channel already exists — no new account, no
 * dependency, no key to rotate. Unset, this degrades to exactly what happens
 * today: a loud console line.
 *
 * Never throws, never blocks the caller. An alert that can fail an operation is
 * worse than no alert.
 */

/** How long the same alert stays quiet after firing. */
const REPEAT_MS = 10 * 60 * 1000;

/** Last time each alert key fired, so a flapping condition cannot spam a channel. */
const lastSent = new Map<string, number>();

export type AlertLevel = "warn" | "critical";

export interface Alert {
  /** Dedupe key — the same key is silent for REPEAT_MS after firing. */
  key: string;
  level: AlertLevel;
  /** One line, human-readable, no jargon: this is read on a phone. */
  title: string;
  /** What to do about it. Optional, but an alert without an action is noise. */
  detail?: string;
}

export const isAlertingConfigured = (): boolean => Boolean(process.env.RB_ALERT_WEBHOOK);

/** PURE: has this key fired recently enough to suppress? Exported for tests. */
export const shouldSuppress = (key: string, now: number, window = REPEAT_MS): boolean => {
  const prev = lastSent.get(key);
  return prev !== undefined && now - prev < window;
};

/** Testing seam — the dedupe map is process-global by design. */
export const resetAlertsForTests = (): void => lastSent.clear();

/**
 * Fire an alert. Always logs; also posts to the webhook when one is configured.
 *
 * Fire-and-forget by contract — callers `void` this. The await inside exists
 * only so a failure can be logged, not so anyone waits for it.
 */
export const sendAlert = async (alert: Alert): Promise<void> => {
  const now = Date.now();
  const line = `[ALERT:${alert.level}] ${alert.title}${alert.detail ? ` — ${alert.detail}` : ""}`;

  // The log happens even when suppressed: a repeated condition should still be
  // visible in the logs of whoever goes looking, just not re-notified.
  if (alert.level === "critical") console.error(line);
  else console.warn(line);

  if (shouldSuppress(alert.key, now)) return;
  lastSent.set(alert.key, now);

  const url = process.env.RB_ALERT_WEBHOOK;
  if (!url) return;

  const emoji = alert.level === "critical" ? "🔴" : "🟡";
  const text = `${emoji} *Renderball* — ${alert.title}${alert.detail ? `\n${alert.detail}` : ""}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Both keys on purpose: Slack reads `text`, Discord reads `content`.
      body: JSON.stringify({ text, content: text }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.warn(`[alert] webhook returned ${res.status} — the alert above was not delivered`);
    }
  } catch (err) {
    // The alert channel failing must never become a second incident.
    console.warn(`[alert] webhook post failed: ${err instanceof Error ? err.message : err}`);
  }
};
