import { lookup } from "node:dns/promises";

/**
 * SSRF guard for the brand crawl.
 *
 * The crawl fetches URLs the user controls (the brand URL they paste) and URLs
 * derived from the page they pointed us at (stylesheet hrefs, favicon paths,
 * og:image, logo candidates). Without a guard an attacker can aim any of those
 * at internal infrastructure — `http://169.254.169.254/latest/meta-data/...`
 * (cloud instance credentials), `http://127.0.0.1:6379` (internal Redis), or a
 * private 10.x/192.168.x service — and exfiltrate the response through the
 * brand-extract result.
 *
 * Defense: resolve the hostname and refuse to fetch if ANY resolved address is
 * loopback / private / link-local / reserved, and re-validate on every redirect
 * hop (a public host can 302 to an internal one). Only http/https is allowed;
 * `data:` URLs are handled by the callers before they ever reach a fetch.
 *
 * Known residual: DNS rebinding (the name resolves to a public IP at check time
 * and a private IP at connect time) is not closed here — that needs connect-time
 * IP pinning, tracked as a follow-up. This closes the trivially-exploitable
 * "paste an internal URL" and "redirect to internal" vectors.
 */

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

const MAX_REDIRECTS = 5;

/** Parse a dotted-quad into four octets, or null if it isn't one. */
const parseIpv4 = (host: string): [number, number, number, number] | null => {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1, 5).map((n) => Number(n));
  if (parts.some((n) => n > 255)) return null;
  return parts as [number, number, number, number];
};

/**
 * True if an IPv4 address falls in a range we must never fetch. Fails closed:
 * an unparseable string is treated as blocked.
 */
export const isBlockedIpv4 = (ip: string): boolean => {
  const octets = parseIpv4(ip);
  if (!octets) return true;
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 + 192.0.2.0/24 (IETF/test)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a >= 224) return true; // 224/4 multicast, 240/4 reserved, 255.255.255.255
  return false;
};

/** True if an IPv6 address is loopback / unspecified / ULA / link-local / mapped-private. */
export const isBlockedIpv6 = (ip: string): boolean => {
  const addr = ip.toLowerCase().split("%")[0]; // strip zone id (fe80::1%eth0)
  if (addr === "::1" || addr === "::") return true;
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible — validate the embedded v4.
  const mapped = addr.match(/(?:::ffff:|::)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isBlockedIpv4(mapped[1]);
  const head = addr.split(":")[0];
  if (/^f[cd]/.test(head)) return true; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(head)) return true; // fe80::/10 link-local
  return false;
};

/** Classify any resolved address string. Fails closed on anything unrecognized. */
export const isBlockedAddress = (ip: string): boolean =>
  ip.includes(":") ? isBlockedIpv6(ip) : isBlockedIpv4(ip);

/**
 * Throw SsrfBlockedError unless `rawUrl` is an http(s) URL whose hostname
 * resolves exclusively to public, routable addresses.
 */
export const assertPublicUrl = async (rawUrl: string): Promise<void> => {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError(`Invalid URL: ${rawUrl}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new SsrfBlockedError(`Refusing non-http(s) URL: ${u.protocol}`);
  }
  let host = u.hostname;
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1); // [::1] → ::1

  // Literal IP in the host — check it directly, no DNS.
  if (parseIpv4(host) || host.includes(":")) {
    if (isBlockedAddress(host)) {
      throw new SsrfBlockedError(`Refusing to fetch private/reserved address: ${host}`);
    }
    return;
  }

  // Hostname — resolve every address it points at and reject if any is internal.
  let resolved: { address: string }[];
  try {
    resolved = await lookup(host, { all: true });
  } catch {
    throw new SsrfBlockedError(`Could not resolve host: ${host}`);
  }
  if (resolved.length === 0) {
    throw new SsrfBlockedError(`Host resolved to no addresses: ${host}`);
  }
  for (const { address } of resolved) {
    if (isBlockedAddress(address)) {
      throw new SsrfBlockedError(`Host ${host} resolves to a private address: ${address}`);
    }
  }
};

/**
 * Drop-in replacement for `fetch` that validates the target (and every redirect
 * hop) against {@link assertPublicUrl} before connecting. Redirects are followed
 * manually so each new location is re-checked. `data:` URLs pass through to the
 * native fetch unchanged — there is no SSRF surface there.
 */
export const safeFetch = async (
  rawUrl: string,
  init: RequestInit = {},
): Promise<Response> => {
  if (rawUrl.startsWith("data:")) return fetch(rawUrl, init);

  let url = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(url);
    const res = await fetch(url, { ...init, redirect: "manual" });
    const status = res.status;
    if (status >= 300 && status < 400) {
      const location = res.headers.get("location");
      if (!location) return res; // 3xx with no Location — hand back as-is
      url = new URL(location, url).toString();
      continue;
    }
    return res;
  }
  throw new SsrfBlockedError(`Too many redirects (>${MAX_REDIRECTS}) from ${rawUrl}`);
};
