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
  pinnedLookup,
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

// ── DNS rebinding ─────────────────────────────────────────────────────────
//
// The attack the address check alone does not stop: resolve once for the
// check, once for the connection, and answer differently the second time. The
// defence is connecting to the address that was validated, which rests entirely
// on pinnedLookup being right — and its failure mode is silent. Node calls a
// lookup function with two different contracts, and answering only one of them
// makes the connection fall back to a real resolution, reopening the hole with
// no error anywhere.

check("pinnedLookup answers the `all: true` contract with an array", () => {
  const pin = { address: "203.0.113.7", family: 4 as const };
  let got: unknown = null;
  pinnedLookup(pin)("anything.invalid", { all: true }, ((_e: unknown, a: unknown) => {
    got = a;
  }) as never);
  assert(Array.isArray(got), `all:true must yield an array, got ${JSON.stringify(got)}`);
  assert(
    (got as { address: string }[])[0]?.address === pin.address,
    `the array must carry the pinned address, got ${JSON.stringify(got)}`,
  );
});

check("pinnedLookup answers the single-address contract with (address, family)", () => {
  const pin = { address: "203.0.113.9", family: 4 as const };
  let addr = "";
  let fam = 0;
  pinnedLookup(pin)("anything.invalid", undefined, ((_e: unknown, a: string, f: number) => {
    addr = a;
    fam = f;
  }) as never);
  assert(addr === pin.address, `address ${addr}`);
  assert(fam === 4, `family ${fam}`);
});

check("pinnedLookup ignores the hostname entirely — that IS the defence", () => {
  const pin = { address: "203.0.113.11", family: 4 as const };
  const l = pinnedLookup(pin);
  for (const hostile of ["rebind.attacker.test", "localhost", "metadata.google.internal"]) {
    let addr = "";
    l(hostile, undefined, ((_e: unknown, a: string) => {
      addr = a;
    }) as never);
    assert(addr === pin.address, `${hostile} must still resolve to the pin, got ${addr}`);
  }
});

check("a literal IP yields no pin — there is no second resolution to subvert", async () => {
  assert((await assertPublicUrl("http://93.184.215.14/")) === null, "literal IPv4 needs no pin");
  assert((await assertPublicUrl("http://[2606:2800:21f:cb07::]/")) === null, "literal IPv6 needs no pin");
});

// Summary line (mirrors sibling tests' style).
queueMicrotask(() => {
  console.log(`\n  ssrf-guard: ${passed} passed, ${failed} failed`);
});
