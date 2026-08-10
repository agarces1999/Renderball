import { lookup } from "node:dns/promises";
import { Agent, fetch as undiciFetch } from "undici";

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
 * DNS REBINDING is closed too, and it is the subtle one. Checking a hostname and
 * then handing that hostname to `fetch` resolves it TWICE, and an attacker who
 * controls the authoritative DNS can answer public the first time and
 * 127.0.0.1 the second — the check passes and the connection still lands
 * inside. So the address validated here is the address connected to: the
 * resolution result is pinned into the dispatcher, while the Host header and
 * TLS SNI keep the original hostname so certificate validation is unaffected.
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
  const [a, b, c] = octets;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  // /24s, NOT /16 — the predicate and its own comment disagreed, and the
  // predicate won: `b === 0` blocks all 65,536 addresses of 192.0.0.0/16.
  // heroku.com resolves to 192.0.66.110, a public Automattic/WP-VIP address,
  // so it and every customer hosted on WP VIP was silently unreachable —
  // "resolves to a private address" for a host that answers 200 to a plain
  // fetch. Found while assembling a brand truth set, where it looked like a
  // crawl failure.
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 TEST-NET-1
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

/** A validated address, kept so the connection can be pinned to it. */
export interface PinnedAddress {
  address: string;
  family: 4 | 6;
}

/**
 * Throw SsrfBlockedError unless `rawUrl` is an http(s) URL whose hostname
 * resolves exclusively to public, routable addresses.
 *
 * Returns the address that was validated, or null when the host was a literal
 * IP (nothing to pin — there is no second resolution to subvert).
 */
export const assertPublicUrl = async (rawUrl: string): Promise<PinnedAddress | null> => {
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

  // Literal IP in the host — check it directly, no DNS, nothing to rebind.
  if (parseIpv4(host) || host.includes(":")) {
    if (isBlockedAddress(host)) {
      throw new SsrfBlockedError(`Refusing to fetch private/reserved address: ${host}`);
    }
    return null;
  }

  // Hostname — resolve every address it points at and reject if any is internal.
  let resolved: { address: string; family: number }[];
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
  // EVERY address passed, so any of them is safe to pin. The first is used, the
  // same one Node would have picked.
  const chosen = resolved[0];
  return { address: chosen.address, family: chosen.family === 6 ? 6 : 4 };
};

/**
 * A DNS lookup that always answers with one pre-validated address.
 *
 * This is the whole anti-rebinding mechanism. Node's connect path calls
 * `lookup` with two different contracts depending on the `all` option, so both
 * are answered — getting that wrong would not fail loudly, it would fall back
 * to a real resolution and quietly reopen the hole.
 */
export const pinnedLookup =
  (pin: PinnedAddress) =>
  (
    _hostname: string,
    options: { all?: boolean } | undefined,
    callback: (err: NodeJS.ErrnoException | null, address: never, family?: number) => void,
  ): void => {
    if (options?.all) {
      (callback as unknown as (e: null, a: PinnedAddress[]) => void)(null, [pin]);
      return;
    }
    (callback as unknown as (e: null, a: string, f: number) => void)(null, pin.address, pin.family);
  };

/**
 * Drop-in replacement for `fetch` that validates the target (and every redirect
 * hop) against {@link assertPublicUrl} before connecting, and then connects to
 * the address it validated rather than resolving the name a second time.
 *
 * Redirects are followed manually so each new location is re-checked and
 * re-pinned. `data:` URLs pass through to the native fetch unchanged — there is
 * no SSRF surface there.
 */
export const safeFetch = async (
  rawUrl: string,
  init: RequestInit = {},
): Promise<Response> => {
  if (rawUrl.startsWith("data:")) return fetch(rawUrl, init);

  let url = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const pin = await assertPublicUrl(url);
    // A per-request dispatcher, not a shared one: each hop pins a different
    // address, and a cached agent would carry the previous hop's pin.
    const dispatcher = pin
      ? new Agent({ connect: { lookup: pinnedLookup(pin) as never } })
      : undefined;
    const options = { ...init, redirect: "manual" as const, dispatcher };
    const res = await (undiciFetch as unknown as (
      u: string,
      o: unknown,
    ) => Promise<Response>)(url, options).finally(() => {
      // The socket is kept alive by default; closing it means one connection
      // per hop, which for a crawl of a few dozen assets is the right trade
      // against leaking pinned agents.
      void dispatcher?.close().catch(() => {});
    });
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
