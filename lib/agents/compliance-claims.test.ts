//
// Fabricated compliance claims at the OUTLINE stage.
//
// Measured 2026-08-21. The Claude Code test brief contains no numbers and no
// compliance language — it asks only for "a page on the security posture an
// engineering leader will ask about". Both outline runs filled that page by
// inventing the answers, and every one of the eleven invented strings passed
// findUngroundedClaims and findUngroundedStageLabels: the stat gate only
// matches stat-SHAPED tokens (currency, percent, multiplier, latency, magnitude
// counts), and "SOC 2 Type II" is none of those.
//
// The strings below are verbatim from those two runs. Two of them ("On-prem
// deployment", "Your code never leaves your infrastructure") are outright false
// about the product, which is the point: this is the class where invention
// stops being embarrassing and becomes a representation the reader may act on.
//
import { findUngroundedComplianceClaims } from "./schema-validator";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

/** The real brief. Note what it does NOT say: nothing about certifications. */
const BRIEF = `A pitch deck introducing Claude Code to engineering leaders deciding whether to roll out an AI coding tool across their team. Claude Code is Anthropic's agentic coding tool: it runs in the terminal, as a desktop app on Mac and Windows, on the web, and as extensions for VS Code and JetBrains. Include a page on how it fits the workflows a team already has, and a page on the security posture an engineering leader will ask about before approving it. Close on how a team runs a one-week pilot.`;

console.log("\n▶ compliance-claims");

check("catches every fabricated claim the two real runs produced", () => {
  const emitted = [
    "SOC 2 Type II",
    "Enterprise SSO",
    "AES-256 at rest and in transit",
    "On-prem deployment",
    "Your code never leaves your infrastructure",
    "SSO / SAML",
    "No training on your code by default",
    "SOC 2 & penetration tests",
  ];
  for (const t of emitted) {
    assert(
      findUngroundedComplianceClaims(t, BRIEF).length > 0,
      `must flag ${JSON.stringify(t)} — the brief says none of this`,
    );
  }
});

check("a claim the company DOES make about itself is allowed through", () => {
  const grounded =
    BRIEF +
    " Claude Code is SOC 2 Type II certified, supports SSO and SAML, and does not train on your code.";
  for (const t of ["SOC 2 Type II", "SSO / SAML", "No training on your code by default"]) {
    assert(
      findUngroundedComplianceClaims(t, grounded).length === 0,
      `must allow ${JSON.stringify(t)} — the source states it`,
    );
  }
});

check("punctuation is not a claim: SOC 2 / SOC-2 / soc2 are one assertion", () => {
  const grounded = BRIEF + " We maintain SOC 2 Type II.";
  for (const t of ["SOC 2", "SOC-2", "soc2", "SOC  2"]) {
    assert(findUngroundedComplianceClaims(t, grounded).length === 0, `must allow ${JSON.stringify(t)}`);
  }
});

check("a promise made in DIFFERENT WORDS still grounds", () => {
  // Literal substring matching called this ungrounded and would have burned a
  // retry forcing the model to delete something true.
  const grounded = BRIEF + " Anthropic does not train on your code.";
  assert(
    findUngroundedComplianceClaims("No training on your code by default", grounded).length === 0,
    "same promise, different sentence — must ground",
  );
});

check("ordinary deck copy is never touched", () => {
  const ordinary = [
    "Security you can defend",
    "Enterprise-grade controls built in",
    "We take privacy seriously",
    "Built for teams that ship",
    "Reads the repo, plans the change, runs the tests",
    "Two sockets and a socket wrench",     // contains "soc"
    "Associate of the year",               // contains "soc"
    "The isolation you need",              // contains "iso"
    "A personal, isolated workspace",      // contains "iso"
  ];
  for (const t of ordinary) {
    const hits = findUngroundedComplianceClaims(t, BRIEF);
    assert(hits.length === 0, `false positive on ${JSON.stringify(t)} → ${JSON.stringify(hits)}`);
  }
});

check("the certification regimes are matched by NAME, not by loose substring", () => {
  // SOC and ISO carry their number so the token stays a real assertion.
  assert(findUngroundedComplianceClaims("SOC 2", BRIEF).length === 1, "SOC 2 is a claim");
  assert(findUngroundedComplianceClaims("soc", BRIEF).length === 0, "bare 'soc' is not");
  assert(findUngroundedComplianceClaims("ISO 27001", BRIEF).length === 1, "ISO 27001 is a claim");
  assert(findUngroundedComplianceClaims("iso", BRIEF).length === 0, "bare 'iso' is not");
});

check("REAL CORPUS: the Fuse deck's invented certification is caught", () => {
  // Verbatim from src/generated/01KV4J28RYSNFXH4TTQXSTBXBQ, whose brief
  // contains no security language at all — not "SOC", not "compliance", not
  // even "secure".
  const shipped = "and 200+ integrations — on enterprise-grade, SOC 2 infrastructure. Enterprise-grade · single-tenant · SOC 2 compliant";
  const brief = "Manifesto-style brand film positioning Fuse Finance as the platform that lets traditional financial institutions originate modern credit products.";
  const hits = findUngroundedComplianceClaims(shipped, brief);
  assert(hits.some((h) => /soc\s?-?2/i.test(h)), `must catch the SOC 2 claim, got ${JSON.stringify(hits)}`);
  assert(hits.some((h) => /single[\s-]?tenant/i.test(h)), `must catch single-tenant, got ${JSON.stringify(hits)}`);
});

check("an empty source grounds nothing (a missing crawl must not license invention)", () => {
  assert(findUngroundedComplianceClaims("SOC 2 Type II", "").length > 0, "empty source cannot ground");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
