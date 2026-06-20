/**
 * SSRF guard regression tests. Locks the address classifier that decides which
 * resolved IPs the brand crawl is allowed to fetch. Pure functions — no network,
 * no DNS, no API key.
 *
 * Run: `npm test`.
 */
import {
  assertPublicUrl,
  isBlockedAddress,
  isBlockedIpv4,
  isBlockedIpv6,
  SsrfBlockedError,
} from "./ssrf-guard";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void | Promise<void>) => {
  try {
    const r = fn();
    if (r instanceof Promise) {
      r.then(
        () => {
          passed++;
          console.log(`  ✓ ${name}`);
        },
        (err) => {
          failed++;
          process.exitCode = 1;
          console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : err}`);
        },
      );
      return;
    }
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    process.exitCode = 1;
    console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : err}`);
  }
};
const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg);
};

// ─── Cloud metadata + loopback + private ranges are blocked ──────────────────
check("blocks cloud metadata endpoint 169.254.169.254", () => {
  assert(isBlockedIpv4("169.254.169.254"), "metadata IP must be blocked");
  assert(isBlockedAddress("169.254.169.254"), "metadata via isBlockedAddress");
});

check("blocks loopback and private IPv4 ranges", () => {
  for (const ip of [
    "127.0.0.1",
    "127.1.2.3",
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "0.0.0.0",
    "100.64.0.1", // CGNAT
    "198.18.0.1", // benchmarking
    "255.255.255.255",
    "224.0.0.1", // multicast
  ]) {
    assert(isBlockedIpv4(ip), `${ip} must be blocked`);
  }
});

check("allows ordinary public IPv4", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.0.1", "172.32.0.1", "11.0.0.1"]) {
    assert(!isBlockedIpv4(ip), `${ip} must be allowed`);
  }
});

check("fails closed on garbage IPv4", () => {
  assert(isBlockedIpv4("999.1.1.1"), "out-of-range octet must be blocked");
  assert(isBlockedIpv4("not-an-ip"), "non-IP must be blocked");
});

check("blocks loopback / ULA / link-local / mapped IPv6", () => {
  for (const ip of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254"]) {
    assert(isBlockedIpv6(ip), `${ip} must be blocked`);
  }
});

check("allows public IPv6 and mapped-public IPv4", () => {
  assert(!isBlockedIpv6("2606:4700:4700::1111"), "Cloudflare DNS v6 must be allowed");
  assert(!isBlockedIpv6("::ffff:8.8.8.8"), "mapped public v4 must be allowed");
});

// ─── assertPublicUrl scheme + literal-IP gating (no DNS needed) ──────────────
check("assertPublicUrl rejects non-http schemes", async () => {
  for (const url of ["file:///etc/passwd", "ftp://example.com", "gopher://x"]) {
    let threw = false;
    try {
      await assertPublicUrl(url);
    } catch (e) {
      threw = e instanceof SsrfBlockedError;
    }
    assert(threw, `${url} must be rejected`);
  }
});

check("assertPublicUrl rejects literal internal IPs without DNS", async () => {
  for (const url of ["http://169.254.169.254/latest/meta-data", "http://127.0.0.1:6379", "http://[::1]:8080", "http://192.168.0.1"]) {
    let threw = false;
    try {
      await assertPublicUrl(url);
    } catch (e) {
      threw = e instanceof SsrfBlockedError;
    }
    assert(threw, `${url} must be rejected`);
  }
});

// Summary line (mirrors sibling tests' style).
queueMicrotask(() => {
  console.log(`\n  ssrf-guard: ${passed} passed, ${failed} failed`);
});
