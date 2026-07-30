/**
 * Getting told when production breaks.
 *
 * Until now the answer was `console.error`, which in practice means nobody
 * finds out until a user complains — and the loudest thing this app can do,
 * tripping the spend breaker, silently stops ALL generation. That is the exact
 * failure where minutes matter and where a log line in a container nobody is
 * watching is the same as no alert at all.
 *
 * TWO CHANNELS, both optional, both fire when set:
 *
 *   EMAIL (`RB_ALERT_EMAIL` + `SMTP_URL`) — the default, because everyone has
 *   an inbox and not everyone has a Slack. SMTP rather than a vendor SDK so the
 *   same code works with a Gmail app password today and any provider later
 *   (Resend, Postmark and SES all speak SMTP) by changing one string.
 *
 *   WEBHOOK (`RB_ALERT_WEBHOOK`) — any HTTPS URL. The payload carries both
 *   `text` and `content`, which Slack and Discord read respectively, each
 *   ignoring the other's key.
 *
 * With neither set this degrades to a loud console line, which is exactly the
 * behaviour it replaces.
 *
 * Never throws, never blocks the caller. An alert fires from inside an error
 * handler, so one that can fail an operation is worse than no alert.
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

/**
 * The SMTP connection string, built the easy way if possible.
 *
 * `SMTP_URL` is the general form and works with any provider. But asking
 * someone to hand-assemble `smtps://user%40gmail.com:pass@smtp.gmail.com:465`
 * is asking them to URL-encode an @ correctly under time pressure, and getting
 * it wrong fails as an authentication error that says nothing about the cause.
 * So GMAIL_USER + GMAIL_APP_PASSWORD is accepted instead: two values copied
 * verbatim, encoded here, where it can be done right once.
 *
 * The spaces Google puts in app passwords for readability are stripped — they
 * are not part of the password, and leaving them in is the most common way this
 * fails.
 */
export const smtpUrl = (): string | null => {
  if (process.env.SMTP_URL) return process.env.SMTP_URL;
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return null;
  const encoded = encodeURIComponent(pass.replace(/\s+/g, ""));
  return `smtps://${encodeURIComponent(user)}:${encoded}@smtp.gmail.com:465`;
};

/** Where alerts go — explicit, or the Gmail account they are sent from. */
export const alertRecipient = (): string | null =>
  process.env.RB_ALERT_EMAIL || process.env.GMAIL_USER || null;

export const isEmailAlertingConfigured = (): boolean =>
  Boolean(alertRecipient() && smtpUrl());

export const isAlertingConfigured = (): boolean =>
  isEmailAlertingConfigured() || Boolean(process.env.RB_ALERT_WEBHOOK);

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

  // Both channels, independently. A failure in one must not skip the other —
  // the whole point is that at least one message arrives.
  await Promise.all([sendEmail(alert), postWebhook(alert)]);
};

const emoji = (level: AlertLevel) => (level === "critical" ? "🔴" : "🟡");

/**
 * Email, over plain SMTP.
 *
 * SMTP rather than a vendor SDK because it is the one interface every provider
 * offers: a Gmail app password works today with no new account, and moving to
 * Resend or Postmark later is a change to one connection string rather than to
 * this file.
 *
 * The subject line carries the whole alert, because that is all you see on a
 * phone's lock screen and the point of an alert is to be understood there.
 */
const sendEmail = async (alert: Alert): Promise<void> => {
  const to = alertRecipient();
  const url = smtpUrl();
  if (!to || !url) return;

  try {
    // Imported lazily so the module is not loaded by the many code paths that
    // will never send an alert.
    const nodemailer = (await import("nodemailer")).default;
    const transport = nodemailer.createTransport(url);
    const subject = `${emoji(alert.level)} Renderball: ${alert.title}`;
    await transport.sendMail({
      // Falls back to the SMTP user, which is what Gmail requires anyway — it
      // rewrites the From header to the authenticated account regardless.
      from: process.env.RB_ALERT_FROM || to,
      to,
      subject,
      text: `${alert.title}\n\n${alert.detail ?? ""}\n\n— Renderball (${alert.level})`,
    });
  } catch (err) {
    console.warn(`[alert] email send failed: ${err instanceof Error ? err.message : err}`);
  }
};

/** Slack, Discord, or anything else that accepts a JSON POST. */
const postWebhook = async (alert: Alert): Promise<void> => {
  const url = process.env.RB_ALERT_WEBHOOK;
  if (!url) return;

  const text = `${emoji(alert.level)} *Renderball* — ${alert.title}${alert.detail ? `\n${alert.detail}` : ""}`;
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
